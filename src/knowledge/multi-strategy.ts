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
import { synapseSearch } from "./neuron.js";
import { tokenizeQuery, preprocessQuery, type PreprocessedQuery } from "./tokenizer.js";
import { vectorSearchANN } from "./embeddings.js";

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

/** 3. Temporal: recently accessed/created nodes (query-aware + log decay) */
const temporalStrategy: SearchStrategy = {
  name: "temporal",
  description: "Prioritize recently accessed or created knowledge relevant to query",
  weight: 0.4,
  search(db, query, limit) {
    const { tokens } = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const tokenList = tokens.map((t) => t.token);
    const placeholders = tokenList.map(() => "?").join(",");

    // Query-relevant nodes with recency + confidence weighting
    const recent = db
      .prepare(
        `SELECT kn.id, kn.confidence,
                julianday('now') - julianday(COALESCE(kn.last_accessed_at, kn.created_at)) as days_ago
         FROM knowledge_nodes kn
         INNER JOIN node_tokens nt ON nt.node_id = kn.id
         WHERE nt.token IN (${placeholders})
           AND (kn.last_accessed_at IS NOT NULL OR kn.created_at > datetime('now', '-30 days'))
         GROUP BY kn.id
         ORDER BY COALESCE(kn.last_accessed_at, kn.created_at) DESC
         LIMIT ?`
      )
      .all(...tokenList, limit) as Array<{ id: string; confidence: number; days_ago: number }>;

    return recent.map((r) => ({
      nodeId: r.id,
      score: Math.max(0.1, (3.0 / (1 + Math.log1p(r.days_ago))) * r.confidence),
      strategy: "temporal",
      reason: `${r.days_ago.toFixed(1)}d ago, conf:${r.confidence.toFixed(2)}`,
    }));
  },
};

/** Link type weights for graph walk scoring */
const LINK_TYPE_WEIGHTS: Record<string, number> = {
  depends_on: 1.5,
  elaborates: 1.5,
  resolves: 1.3,
  related: 1.0,
  contradicts: 0.3,
};

/** 4. Graph Walk: expand from vector seeds through links (2-hop, orthogonal to synapse) */
const graphWalkStrategy: SearchStrategy = {
  name: "graph_walk",
  description: "2-hop graph exploration from vector-seeded nodes (semantic→structural axis)",
  weight: 0.6,
  search(db, query, limit) {
    // Seed from vector results (semantic axis, orthogonal to synapse's lexical axis)
    let seedIds: Array<{ nodeId: string; score: number }> = [];

    try {
      const cached = db
        .prepare("SELECT vector FROM _query_vector LIMIT 1")
        .get() as { vector: Buffer } | undefined;
      if (cached) {
        const queryVec = new Float32Array(
          cached.vector.buffer,
          cached.vector.byteOffset,
          cached.vector.byteLength / 4
        );
        const vectorResults = vectorSearchANN(db, queryVec, 5);
        seedIds = vectorResults.map((r) => ({ nodeId: r.nodeId, score: r.similarity * 10 }));
      }
    } catch {
      // vector not available
    }

    // Fallback: use structural matches if no vector seeds
    if (seedIds.length === 0) {
      const synapse = synapseSearch(db, query, { limit: 5, maxDepth: 0 });
      seedIds = synapse.map((s) => ({ nodeId: s.nodeId, score: s.activation }));
    }

    if (seedIds.length === 0) return [];

    const results: StrategyResult[] = [];
    const seen = new Set(seedIds.map((s) => s.nodeId));

    // Hop 1: direct neighbors
    const hop1Nodes: Array<{ nodeId: string; score: number; fromId: string }> = [];

    for (const seed of seedIds) {
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
        const linkWeight = LINK_TYPE_WEIGHTS[n.link_type] ?? 1.0;
        const score = seed.score * 0.5 * (n.weight || 1.0) * linkWeight;
        hop1Nodes.push({ nodeId: n.neighbor_id, score, fromId: seed.nodeId });
        results.push({
          nodeId: n.neighbor_id,
          score,
          strategy: "graph_walk",
          reason: `hop1 via ${seed.nodeId.slice(0, 8)} [${n.link_type}]`,
        });
      }
    }

    // Hop 2: neighbors of hop-1 nodes (top 5 only to limit expansion)
    const hop1Top = hop1Nodes.sort((a, b) => b.score - a.score).slice(0, 5);
    for (const h1 of hop1Top) {
      const neighbors = db
        .prepare(
          `SELECT
             CASE WHEN source_id = ? THEN target_id ELSE source_id END as neighbor_id,
             weight, link_type
           FROM node_links
           WHERE source_id = ? OR target_id = ?
           LIMIT 5`
        )
        .all(h1.nodeId, h1.nodeId, h1.nodeId) as Array<{
        neighbor_id: string;
        weight: number;
        link_type: string;
      }>;

      for (const n of neighbors) {
        if (seen.has(n.neighbor_id)) continue;
        seen.add(n.neighbor_id);
        const linkWeight = LINK_TYPE_WEIGHTS[n.link_type] ?? 1.0;
        const score = h1.score * 0.5 * (n.weight || 1.0) * linkWeight;
        results.push({
          nodeId: n.neighbor_id,
          score,
          strategy: "graph_walk",
          reason: `hop2 via ${h1.nodeId.slice(0, 8)} [${n.link_type}]`,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  },
};

/** 5. Tag Cluster: Jaccard similarity on tag sets (inverted index) */
const tagClusterStrategy: SearchStrategy = {
  name: "tag_cluster",
  description: "Find nodes with similar tag sets using Jaccard similarity",
  weight: 0.7,
  search(db, query, limit) {
    const { originalTerms } = tokenizeQuery(query);
    const queryTags = new Set(originalTerms.map((t) => t.toLowerCase()));

    if (queryTags.size === 0) return [];

    // Inverted index approach: find only candidate nodes that have at least one matching tag
    const tagArray = [...queryTags];
    const placeholders = tagArray.map(() => "?").join(",");

    const candidates = db
      .prepare(
        `SELECT nt.node_id,
                COUNT(*) as match_count,
                (SELECT COUNT(*) FROM node_tags nt2 WHERE nt2.node_id = nt.node_id) as total_tags
         FROM node_tags nt
         WHERE LOWER(nt.tag) IN (${placeholders})
         GROUP BY nt.node_id
         LIMIT ?`
      )
      .all(...tagArray, limit * 3) as Array<{ node_id: string; match_count: number; total_tags: number }>;

    const results: StrategyResult[] = [];

    for (const row of candidates) {
      const intersection = row.match_count;
      const union = queryTags.size + row.total_tags - intersection;
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

/** 6. Vector: semantic similarity via embeddings (LSH-ANN accelerated) */
const vectorStrategy: SearchStrategy = {
  name: "vector",
  description: "Semantic similarity search via local embeddings with LSH-ANN acceleration",
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

      // Use ANN search (falls back to brute force if buckets not populated)
      const annResults = vectorSearchANN(db, queryVec, limit);

      return annResults.map((r) => ({
        nodeId: r.nodeId,
        score: r.similarity * 10,
        strategy: "vector",
        reason: `similarity: ${r.similarity.toFixed(3)}`,
      }));
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
 * Compute adaptive strategy weights from feedback data.
 * Uses strategy_performance table to adjust weights based on helpfulness.
 */
function computeAdaptiveWeights(db: Database.Database): Map<string, number> {
  const weights = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT strategy_name,
                SUM(CASE WHEN was_helpful = 1 THEN 1 ELSE 0 END) as helpful,
                COUNT(*) as total
         FROM strategy_performance
         GROUP BY strategy_name`
      )
      .all() as Array<{ strategy_name: string; helpful: number; total: number }>;

    for (const row of rows) {
      if (row.total >= 5) {
        const helpfulRate = row.helpful / row.total;
        weights.set(row.strategy_name, helpfulRate);
      }
    }
  } catch {
    // table might not exist yet
  }
  return weights;
}

/**
 * Run all strategies in parallel and merge results.
 *
 * 統合アルゴリズム:
 *   1. 適応的重みを計算（フィードバックから学習）
 *   2. 各戦略を実行
 *   3. 全結果をnodeIdでグループ化
 *   4. 各nodeIdのスコア = Σ(strategy_score × adaptive_weight)
 *   5. 複数戦略でヒットしたノードにボーナス（MECE交差ボーナス）
 *   6. MMR多様化してランキング返却
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

  // Query preprocessing: NFKC normalization, phrase/negation extraction, fuzzy correction
  let vocabulary: Set<string> | undefined;
  try {
    const vocabRows = db
      .prepare("SELECT DISTINCT token FROM node_tokens LIMIT 10000")
      .all() as Array<{ token: string }>;
    vocabulary = new Set(vocabRows.map((r) => r.token));
  } catch {
    // node_tokens might not exist yet
  }
  const preprocessed = preprocessQuery(query, vocabulary);
  const effectiveQuery = preprocessed.corrected || preprocessed.normalized || query;

  // Compute adaptive weights from feedback history
  const adaptiveRates = computeAdaptiveWeights(db);

  // Run all strategies
  const allResults = new Map<
    string,
    { totalScore: number; hits: Array<{ name: string; score: number; reason: string }> }
  >();

  for (const strategy of strategies) {
    try {
      // Apply adaptive weight: baseWeight * (0.5 + helpfulRate), clamped [0.2, 2.0]
      const rate = adaptiveRates.get(strategy.name);
      const effectiveWeight =
        rate !== undefined
          ? Math.min(2.0, Math.max(0.2, strategy.weight * (0.5 + rate)))
          : strategy.weight;

      const results = strategy.search(db, effectiveQuery, limit * 2);

      for (const r of results) {
        const existing = allResults.get(r.nodeId) || { totalScore: 0, hits: [] };
        existing.totalScore += r.score * effectiveWeight;
        existing.hits.push({ name: r.strategy, score: r.score, reason: r.reason });
        allResults.set(r.nodeId, existing);
      }
    } catch {
      // Strategy failed, skip
    }
  }

  // Filter out negated terms: remove nodes whose content matches negation tokens
  if (preprocessed.negations.length > 0) {
    for (const negTerm of preprocessed.negations) {
      for (const [nodeId] of allResults) {
        try {
          const hasNeg = db
            .prepare("SELECT 1 FROM node_tokens WHERE node_id = ? AND token = ? LIMIT 1")
            .get(nodeId, negTerm);
          if (hasNeg) allResults.delete(nodeId);
        } catch {
          // ignore
        }
      }
    }
  }

  // Cross-strategy bonus: nodes found by multiple strategies get a boost
  const ranked: MultiStrategyResult[] = [];
  for (const [nodeId, data] of allResults) {
    const strategyCount = data.hits.length;
    if (strategyCount < minStrategies) continue;

    // Bonus: each additional strategy adds 20% boost
    const crossBonus = 1.0 + (strategyCount - 1) * 0.2;
    const finalScore = data.totalScore * crossBonus;

    ranked.push({
      nodeId,
      finalScore,
      strategies: data.hits,
    });
  }

  ranked.sort((a, b) => b.finalScore - a.finalScore);

  // MMR diversification: penalize nodes that overlap heavily with already-selected nodes
  if (ranked.length <= 1) return ranked.slice(0, limit);

  const selected: MultiStrategyResult[] = [ranked[0]];
  const remaining = ranked.slice(1);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const candidateStrategies = new Set(candidate.strategies.map((s) => s.name));

      // Count how many selected nodes share 2+ strategies with this candidate
      let overlapCount = 0;
      for (const sel of selected) {
        const selStrategies = new Set(sel.strategies.map((s) => s.name));
        let shared = 0;
        for (const s of candidateStrategies) {
          if (selStrategies.has(s)) shared++;
        }
        if (shared >= 2) overlapCount++;
      }

      const diversityPenalty = Math.pow(0.9, overlapCount);
      const adjustedScore = candidate.finalScore * diversityPenalty;

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
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
