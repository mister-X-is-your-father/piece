/**
 * Embeddings: ベクトル埋め込みによる意味検索
 *
 * transformers.js でローカル実行。APIキー不要、オフライン動作。
 * モデル: all-MiniLM-L6-v2 (384次元、高速、多言語対応)
 *
 * SQLiteにBLOBとして保存し、コサイン類似度で検索。
 */

import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { logger } from "../utils/logger.js";

// --- Lazy-loaded pipeline ---

let embedder: any = null;

async function getEmbedder() {
  if (!embedder) {
    logger.info("Loading embedding model (first time may download ~80MB)...");
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    logger.info("Embedding model loaded");
  }
  return embedder;
}

// --- Core Functions ---

/**
 * Generate embedding vector for text.
 * Returns Float32Array (384 dimensions).
 */
export async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const result = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(result.data);
}

/**
 * Cosine similarity between two vectors.
 * Both must be normalized (which all-MiniLM-L6-v2 does by default).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // normalized vectors: cosine = dot product
}

// --- SQLite Storage ---

/**
 * Store embedding for a knowledge node.
 */
export function storeEmbedding(
  db: Database.Database,
  nodeId: string,
  vector: Float32Array
): void {
  const buffer = Buffer.from(vector.buffer);
  db.prepare(
    "INSERT OR REPLACE INTO embeddings (node_id, vector, dimensions) VALUES (?, ?, ?)"
  ).run(nodeId, buffer, vector.length);

  // Also index into LSH buckets for ANN search
  try {
    indexEmbeddingBucket(db, nodeId, vector);
  } catch {
    // embedding_buckets table might not exist yet (pre-migration v9)
  }
}

/**
 * Get embedding for a node.
 */
export function getEmbedding(
  db: Database.Database,
  nodeId: string
): Float32Array | null {
  const row = db
    .prepare("SELECT vector FROM embeddings WHERE node_id = ?")
    .get(nodeId) as { vector: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
}

/**
 * Semantic search: find most similar nodes by vector similarity.
 */
export function vectorSearch(
  db: Database.Database,
  queryVector: Float32Array,
  limit: number = 10
): Array<{ nodeId: string; similarity: number }> {
  // Load all embeddings (brute force for now — works fine up to ~50k nodes)
  const rows = db
    .prepare("SELECT node_id, vector FROM embeddings")
    .all() as Array<{ node_id: string; vector: Buffer }>;

  const results: Array<{ nodeId: string; similarity: number }> = [];

  for (const row of rows) {
    const stored = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / 4
    );
    const sim = cosineSimilarity(queryVector, stored);
    if (sim > 0.3) {
      // threshold: 0.3 minimum similarity
      results.push({ nodeId: row.node_id, similarity: sim });
    }
  }

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Embed and store for a knowledge node (convenience function).
 */
export async function embedAndStore(
  db: Database.Database,
  nodeId: string,
  text: string
): Promise<void> {
  const vector = await embed(text);
  storeEmbedding(db, nodeId, vector);
}

/**
 * Embed query and search (convenience function).
 */
export async function semanticSearch(
  db: Database.Database,
  query: string,
  limit: number = 10
): Promise<Array<{ nodeId: string; similarity: number }>> {
  const queryVector = await embed(query);
  return vectorSearch(db, queryVector, limit);
}

// --- LSH Approximate Nearest Neighbor ---

const LSH_NUM_PLANES = 8;   // bits per bucket → 256 buckets per set
const LSH_NUM_SETS = 3;     // multiple sets for higher recall
const LSH_DIMS = 384;       // all-MiniLM-L6-v2 dimensions

/** Deterministic pseudo-random projection planes (seeded for reproducibility). */
let _projectionPlanes: Float32Array[][] | null = null;

function getProjectionPlanes(): Float32Array[][] {
  if (_projectionPlanes) return _projectionPlanes;

  _projectionPlanes = [];
  // Simple deterministic PRNG (mulberry32)
  function mulberry32(a: number) {
    return () => {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let s = 0; s < LSH_NUM_SETS; s++) {
    const planes: Float32Array[] = [];
    const rand = mulberry32(42 + s * 1000); // deterministic seed per set
    for (let p = 0; p < LSH_NUM_PLANES; p++) {
      const plane = new Float32Array(LSH_DIMS);
      // Random unit vector (approximately — normalized after generation)
      let norm = 0;
      for (let i = 0; i < LSH_DIMS; i++) {
        // Box-Muller-like: use two uniforms for roughly normal distribution
        const u1 = rand();
        const u2 = rand();
        plane[i] = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
        norm += plane[i] * plane[i];
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < LSH_DIMS; i++) plane[i] /= norm;
      planes.push(plane);
    }
    _projectionPlanes.push(planes);
  }

  return _projectionPlanes;
}

/**
 * Compute LSH bucket ID for a vector against a set of hyperplanes.
 * Each plane contributes 1 bit → 8 planes = 256 possible buckets.
 */
export function computeBucket(vector: Float32Array, planes: Float32Array[]): number {
  let bucket = 0;
  for (let p = 0; p < planes.length; p++) {
    let dot = 0;
    for (let i = 0; i < vector.length; i++) {
      dot += vector[i] * planes[p][i];
    }
    if (dot > 0) bucket |= (1 << p);
  }
  return bucket;
}

/**
 * Index embedding into LSH buckets for fast ANN search.
 */
export function indexEmbeddingBucket(
  db: Database.Database,
  nodeId: string,
  vector: Float32Array
): void {
  const allPlanes = getProjectionPlanes();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO embedding_buckets (node_id, bucket_id, plane_set) VALUES (?, ?, ?)"
  );
  for (let s = 0; s < allPlanes.length; s++) {
    const bucket = computeBucket(vector, allPlanes[s]);
    stmt.run(nodeId, bucket, s);
  }
}

/**
 * ANN vector search using LSH buckets.
 * Finds candidates in matching buckets, then does exact cosine on candidates only.
 */
export function vectorSearchANN(
  db: Database.Database,
  queryVector: Float32Array,
  limit: number = 10
): Array<{ nodeId: string; similarity: number }> {
  const allPlanes = getProjectionPlanes();

  // Check if buckets table has data
  let hasBuckets = false;
  try {
    const count = (db.prepare("SELECT COUNT(*) as c FROM embedding_buckets").get() as { c: number }).c;
    hasBuckets = count > 0;
  } catch {
    // table doesn't exist
  }

  if (!hasBuckets) {
    // Fallback to brute force
    return vectorSearch(db, queryVector, limit);
  }

  // Compute query buckets for each plane set
  const queryBuckets: number[] = [];
  for (let s = 0; s < allPlanes.length; s++) {
    queryBuckets.push(computeBucket(queryVector, allPlanes[s]));
  }

  // Find candidate node IDs from any matching bucket set
  const conditions = queryBuckets.map((_, i) => `(plane_set = ${i} AND bucket_id = ?)`).join(" OR ");
  const candidateRows = db
    .prepare(
      `SELECT DISTINCT node_id FROM embedding_buckets WHERE ${conditions}`
    )
    .all(...queryBuckets) as Array<{ node_id: string }>;

  const candidateIds = new Set(candidateRows.map((r) => r.node_id));

  // If too few candidates, expand to adjacent buckets (flip 1 bit)
  if (candidateIds.size < limit * 2) {
    for (let s = 0; s < queryBuckets.length && candidateIds.size < limit * 4; s++) {
      for (let bit = 0; bit < LSH_NUM_PLANES; bit++) {
        const adjacentBucket = queryBuckets[s] ^ (1 << bit);
        const adjacent = db
          .prepare("SELECT node_id FROM embedding_buckets WHERE plane_set = ? AND bucket_id = ?")
          .all(s, adjacentBucket) as Array<{ node_id: string }>;
        for (const row of adjacent) candidateIds.add(row.node_id);
      }
    }
  }

  if (candidateIds.size === 0) {
    return vectorSearch(db, queryVector, limit);
  }

  // Exact cosine similarity only on candidates
  const results: Array<{ nodeId: string; similarity: number }> = [];
  const idList = [...candidateIds];
  const placeholders = idList.map(() => "?").join(",");

  const rows = db
    .prepare(`SELECT node_id, vector FROM embeddings WHERE node_id IN (${placeholders})`)
    .all(...idList) as Array<{ node_id: string; vector: Buffer }>;

  for (const row of rows) {
    const stored = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / 4
    );
    const sim = cosineSimilarity(queryVector, stored);
    if (sim > 0.3) {
      results.push({ nodeId: row.node_id, similarity: sim });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Backfill LSH buckets for all existing embeddings.
 */
export function backfillBuckets(db: Database.Database): number {
  const rows = db
    .prepare("SELECT node_id, vector FROM embeddings")
    .all() as Array<{ node_id: string; vector: Buffer }>;

  let count = 0;
  for (const row of rows) {
    const vector = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / 4
    );
    indexEmbeddingBucket(db, row.node_id, vector);
    count++;
  }
  return count;
}

/**
 * Batch embed all nodes that don't have embeddings yet.
 */
export async function embedAllNodes(
  db: Database.Database
): Promise<number> {
  const nodes = db
    .prepare(
      `SELECT kn.id, kn.summary, kn.content
       FROM knowledge_nodes kn
       LEFT JOIN embeddings e ON e.node_id = kn.id
       WHERE e.node_id IS NULL`
    )
    .all() as Array<{ id: string; summary: string; content: string }>;

  if (nodes.length === 0) return 0;

  logger.info(`Embedding ${nodes.length} nodes...`);

  for (const node of nodes) {
    const text = `${node.summary}\n${node.content}`.slice(0, 512); // max 512 chars for efficiency
    await embedAndStore(db, node.id, text);
  }

  logger.info(`Embedded ${nodes.length} nodes`);
  return nodes.length;
}
