/**
 * Multi-Strategy Retrieval Engine
 *
 * 脳が複数の記憶システムを並行して使うように、
 * 複数の検索戦略を同時に走らせて結果を統合する。
 *
 * 戦略一覧:
 *   1. Synapse   — N-gram + concept展開 + 拡散活性化
 *   2. Structural — ファイルパス・関数名による逆引き
 *   3. Temporal  — 最近アクセス/作成されたノード優先
 *   4. Graph     — 既にヒットしたノードの隣接を深堀り
 *   5. Tag       — タグ集合のJaccard類似度
 *   6. Atom      — 原子的知識からの精密検索
 *
 * MECE保証:
 *   各戦略が異なる軸で検索するため、取りこぼしを最小化。
 *   ┌────────────────────────────────┐
 *   │        Knowledge Space         │
 *   │  ┌─Synapse──┐                  │
 *   │  │  ┌Tag┐   │ ┌─Structural─┐  │
 *   │  │  │   │   │ │            │  │
 *   │  │  └───┘   │ │  ┌Graph┐   │  │
 *   │  └──────────┘ │  │     │   │  │
 *   │    ┌Temporal┐  │  └─────┘   │  │
 *   │    │        │  └────────────┘  │
 *   │    └────────┘  ┌─Atom──┐       │
 *   │                │       │       │
 *   │                └───────┘       │
 *   └────────────────────────────────┘
 *   各戦略がカバーする領域が異なり、
 *   和集合で知識空間を最大限カバーする
 */

import type Database from "better-sqlite3";
import { synapseSearch, type ActivatedNode } from "./neuron.js";
import { tokenizeQuery } from "./tokenizer.js";

// --- Strategy Interface (プラグイン拡張可能) ---

export interface SearchStrategy {
  /** 戦略名 */
  name: string;
  /** 戦略の説明 */
  description: string;
  /** 検索実行 */
  search(db: Database.Database, query: string, limit: number): StrategyResult[];
  /** この戦略の重み (0-1) — 結果統合時に使用 */
  weight: number;
}

export interface StrategyResult {
  nodeId: string;
  score: number;
  strategy: string;
  reason: string;
}

export interface MultiStrategyResult {
  nodeId: string;
  finalScore: number;
  strategies: Array<{ name: string; score: number; reason: string }>;
}

// --- Built-in Strategies ---

/** 1. Synapse: N-gram + concept + spreading activation */
const synapseStrategy: SearchStrategy = {
  name: "synapse",
  description: "N-gram tokenization + concept expansion + spreading activation",
  weight: 1.0,
  search(db, query, limit) {
    const results = synapseSearch(db, query, { limit, conceptExpansion: true, maxDepth: 2 });
    return results.map((r) => ({
      nodeId: r.nodeId,
      score: r.activation,
      strategy: "synapse",
      reason: `tokens: ${r.sources.slice(0, 3).join(", ")}`,
    }));
  },
};

/** 2. Structural: file path / function name reverse lookup */
const structuralStrategy: SearchStrategy = {
  name: "structural",
  description: "Match by file path, function name, or code structure",
  weight: 0.8,
  search(db, query, limit) {
    // Extract potential file/function references from query
    const patterns = query.match(/[\w./\-]+\.\w+|[\w]+(?:Function|Handler|Service|Controller|Route|Model)/gi) || [];
    const { originalTerms } = tokenizeQuery(query);

    const results: StrategyResult[] = [];

    // Search node_citations by file path
    for (const term of [...patterns, ...originalTerms]) {
      const rows = db
        .prepare(
          `SELECT DISTINCT nc.node_id, nc.file_path
           FROM node_citations nc
           WHERE nc.file_path LIKE ?
           LIMIT ?`
        )
        .all(`%${term}%`, limit) as Array<{ node_id: string; file_path: string }>;

      for (const row of rows) {
        results.push({
          nodeId: row.node_id,
          score: 5.0,
          strategy: "structural",
          reason: `file: ${row.file_path}`,
        });
      }
    }

    // Search atoms by file path
    try {
      for (const term of [...patterns, ...originalTerms]) {
        const atoms = db
          .prepare("SELECT id, file_path FROM atoms WHERE file_path LIKE ? LIMIT ?")
          .all(`%${term}%`, limit) as Array<{ id: string; file_path: string }>;
        for (const atom of atoms) {
          results.push({
            nodeId: atom.id,
            score: 6.0,
            strategy: "structural",
            reason: `atom file: ${atom.file_path}`,
          });
        }
      }
    } catch {
      // atoms table might not exist yet
    }

    return results;
  },
};

/** 3. Temporal: recently accessed/created nodes */
const temporalStrategy: SearchStrategy = {
  name: "temporal",
  description: "Prioritize recently accessed or created knowledge",
  weight: 0.4,
  search(db, query, limit) {
    // Recently accessed nodes (weighted by recency)
    const recent = db
      .prepare(
        `SELECT id, summary,
                julianday('now') - julianday(COALESCE(last_accessed_at, created_at)) as days_ago
         FROM knowledge_nodes
         WHERE last_accessed_at IS NOT NULL OR created_at > datetime('now', '-7 days')
         ORDER BY COALESCE(last_accessed_at, created_at) DESC
         LIMIT ?`
      )
      .all(limit) as Array<{ id: string; summary: string; days_ago: number }>;

    return recent.map((r) => ({
      nodeId: r.id,
      score: Math.max(0.1, 3.0 - r.days_ago * 0.3), // decay over days
      strategy: "temporal",
      reason: `${r.days_ago.toFixed(1)} days ago`,
    }));
  },
};

/** 4. Graph Walk: expand from known hits through links */
const graphWalkStrategy: SearchStrategy = {
  name: "graph_walk",
  description: "Explore neighbors of matched nodes through knowledge graph",
  weight: 0.6,
  search(db, query, limit) {
    // First get synapse results as seeds
    const seeds = synapseSearch(db, query, { limit: 5, maxDepth: 0 }); // no spreading, just direct hits
    const results: StrategyResult[] = [];
    const seen = new Set(seeds.map((s) => s.nodeId));

    for (const seed of seeds) {
      // Get neighbors
      const neighbors = db
        .prepare(
          `SELECT
             CASE WHEN source_id = ? THEN target_id ELSE source_id END as neighbor_id,
             weight, link_type
           FROM node_links
           WHERE source_id = ? OR target_id = ?`
        )
        .all(seed.nodeId, seed.nodeId, seed.nodeId) as Array<{
        neighbor_id: string;
        weight: number;
        link_type: string;
      }>;

      for (const n of neighbors) {
        if (seen.has(n.neighbor_id)) continue;
        seen.add(n.neighbor_id);
        results.push({
          nodeId: n.neighbor_id,
          score: seed.activation * 0.3 * (n.weight || 1.0),
          strategy: "graph_walk",
          reason: `via ${seed.nodeId.slice(0, 8)} [${n.link_type}]`,
        });
      }
    }

    return results.slice(0, limit);
  },
};

/** 5. Tag Cluster: Jaccard similarity on tag sets */
const tagClusterStrategy: SearchStrategy = {
  name: "tag_cluster",
  description: "Find nodes with similar tag sets using Jaccard similarity",
  weight: 0.7,
  search(db, query, limit) {
    const { originalTerms } = tokenizeQuery(query);
    const queryTags = new Set(originalTerms.map((t) => t.toLowerCase()));

    if (queryTags.size === 0) return [];

    // Get all unique node_ids with their tags
    const rows = db
      .prepare(
        `SELECT nt.node_id, GROUP_CONCAT(nt.tag) as tags
         FROM node_tags nt
         GROUP BY nt.node_id`
      )
      .all() as Array<{ node_id: string; tags: string }>;

    const results: StrategyResult[] = [];

    for (const row of rows) {
      const nodeTags = new Set(row.tags.split(",").map((t) => t.toLowerCase()));

      // Jaccard similarity
      let intersection = 0;
      for (const t of queryTags) {
        if (nodeTags.has(t)) intersection++;
      }
      const union = queryTags.size + nodeTags.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard > 0) {
        results.push({
          nodeId: row.node_id,
          score: jaccard * 10,
          strategy: "tag_cluster",
          reason: `jaccard: ${jaccard.toFixed(2)}`,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  },
};

/** 6. Vector: semantic similarity via embeddings */
const vectorStrategy: SearchStrategy = {
  name: "vector",
  description: "Semantic similarity search via local embeddings (all-MiniLM-L6-v2)",
  weight: 1.2, // highest weight — semantic understanding is powerful
  search(db, query, limit) {
    // Check if embeddings table has data
    try {
      const count = (
        db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }
      ).c;
      if (count === 0) return [];
    } catch {
      return []; // table doesn't exist yet
    }

    // Synchronous vector search using pre-computed query embedding
    // Note: The actual embedding is done async before calling multi-strategy
    // Here we check if a cached query vector exists in a temp table
    try {
      const cached = db
        .prepare("SELECT vector FROM _query_vector LIMIT 1")
        .get() as { vector: Buffer } | undefined;
      if (!cached) return [];

      const queryVec = new Float32Array(
        cached.vector.buffer,
        cached.vector.byteOffset,
        cached.vector.byteLength / 4
      );

      const rows = db
        .prepare("SELECT node_id, vector FROM embeddings")
        .all() as Array<{ node_id: string; vector: Buffer }>;

      const results: StrategyResult[] = [];
      for (const row of rows) {
        const stored = new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / 4
        );
        let dot = 0;
        for (let i = 0; i < queryVec.length; i++) {
          dot += queryVec[i] * stored[i];
        }
        if (dot > 0.3) {
          results.push({
            nodeId: row.node_id,
            score: dot * 10, // scale to comparable range
            strategy: "vector",
            reason: `similarity: ${dot.toFixed(3)}`,
          });
        }
      }

      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch {
      return [];
    }
  },
};

// --- Strategy Registry (プラグイン拡張ポイント) ---

const defaultStrategies: SearchStrategy[] = [
  synapseStrategy,
  structuralStrategy,
  temporalStrategy,
  graphWalkStrategy,
  tagClusterStrategy,
  vectorStrategy,
];

/**
 * Run all strategies in parallel and merge results.
 *
 * 統合アルゴリズム:
 *   1. 各戦略を実行
 *   2. 全結果をnodeIdでグループ化
 *   3. 各nodeIdのスコア = Σ(strategy_score × strategy_weight)
 *   4. 複数戦略でヒットしたノードにボーナス（MECE交差ボーナス）
 *   5. ランキングして返却
 */
export function multiStrategySearch(
  db: Database.Database,
  query: string,
  options: {
    limit?: number;
    strategies?: SearchStrategy[];
    minStrategies?: number; // 最低何戦略でヒットすべきか (default: 1)
  } = {}
): MultiStrategyResult[] {
  const limit = options.limit ?? 10;
  const strategies = options.strategies ?? defaultStrategies;
  const minStrategies = options.minStrategies ?? 1;

  // Run all strategies
  const allResults = new Map<
    string,
    { totalScore: number; hits: Array<{ name: string; score: number; reason: string }> }
  >();

  for (const strategy of strategies) {
    try {
      const results = strategy.search(db, query, limit * 2);

      for (const r of results) {
        const existing = allResults.get(r.nodeId) || { totalScore: 0, hits: [] };
        existing.totalScore += r.score * strategy.weight;
        existing.hits.push({ name: r.strategy, score: r.score, reason: r.reason });
        allResults.set(r.nodeId, existing);
      }
    } catch {
      // Strategy failed, skip
    }
  }

  // Cross-strategy bonus: nodes found by multiple strategies get a boost
  const results: MultiStrategyResult[] = [];
  for (const [nodeId, data] of allResults) {
    const strategyCount = data.hits.length;
    if (strategyCount < minStrategies) continue;

    // Bonus: each additional strategy adds 20% boost
    const crossBonus = 1.0 + (strategyCount - 1) * 0.2;
    const finalScore = data.totalScore * crossBonus;

    results.push({
      nodeId,
      finalScore,
      strategies: data.hits,
    });
  }

  return results.sort((a, b) => b.finalScore - a.finalScore).slice(0, limit);
}

/**
 * Register a custom strategy (フレームワーク拡張ポイント).
 */
export function createStrategy(
  name: string,
  description: string,
  weight: number,
  searchFn: (db: Database.Database, query: string, limit: number) => StrategyResult[]
): SearchStrategy {
  return { name, description, weight, search: searchFn };
}

/**
 * Get all available strategy names.
 */
export function getAvailableStrategies(): Array<{ name: string; description: string; weight: number }> {
  return defaultStrategies.map((s) => ({
    name: s.name,
    description: s.description,
    weight: s.weight,
  }));
}
