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
