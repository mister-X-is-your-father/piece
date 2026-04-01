/**
 * Neuron: Brain-inspired knowledge retrieval engine.
 *
 * Based on neuroscience principles:
 * 1. Spreading Activation — concepts activate related concepts through links
 * 2. Hebbian Learning — "neurons that fire together wire together"
 * 3. Associative Memory — partial cues can retrieve full memories
 * 4. Concept Expansion — cross-language synonym/concept mesh
 *
 * Replaces FTS5 with n-gram token index + spreading activation.
 */

import type Database from "better-sqlite3";
import { tokenize, tokenizeQuery, type TokenResult } from "./tokenizer.js";
import { generateId, needsConceptSeed } from "./db.js";

// --- Types ---

export interface ActivatedNode {
  nodeId: string;
  activation: number;
  sources: string[]; // which tokens/concepts contributed
}

export interface SynapseSearchOptions {
  maxDepth?: number;       // spreading activation depth (default: 2)
  decayFactor?: number;    // activation decay per hop (default: 0.5)
  threshold?: number;      // minimum activation to include (default: 0.05)
  limit?: number;          // max results (default: 10)
  conceptExpansion?: boolean; // expand query with synonyms (default: true)
}

export interface ConceptLink {
  term: string;
  weight: number;
}

// --- Seed Concepts (cross-language mappings) ---

const SEED_CONCEPTS: [string, string][] = [
  // Japanese ↔ English core concepts
  ["認証", "auth"], ["認証", "authentication"], ["認証", "login"],
  ["ログイン", "login"], ["ログイン", "auth"],
  ["ユーザー", "user"], ["ユーザ", "user"],
  ["設定", "config"], ["設定", "configuration"], ["設定", "settings"],
  ["データベース", "database"], ["データベース", "db"],
  ["エラー", "error"], ["例外", "exception"],
  ["テスト", "test"], ["テスト", "testing"],
  ["検索", "search"], ["検索", "query"], ["検索", "find"],
  ["関数", "function"], ["関数", "method"],
  ["クラス", "class"], ["型", "type"], ["型", "interface"],
  ["ルーティング", "routing"], ["ルート", "route"],
  ["ミドルウェア", "middleware"],
  ["トークン", "token"], ["トークン", "JWT"],
  ["セキュリティ", "security"], ["セキュリティ", "auth"],
  ["パスワード", "password"], ["パスワード", "credential"],
  ["暗号化", "encryption"], ["ハッシュ", "hash"],
  ["依存関係", "dependency"], ["依存", "import"],
  ["フロー", "flow"], ["処理", "process"], ["処理", "handler"],
  ["API", "endpoint"], ["API", "route"],
  ["保存", "save"], ["保存", "store"], ["保存", "persist"],
  ["削除", "delete"], ["削除", "remove"],
  ["更新", "update"], ["更新", "modify"],
  ["取得", "get"], ["取得", "fetch"], ["取得", "retrieve"],
  ["一覧", "list"], ["一覧", "index"],
  ["確認", "verify"], ["確認", "validate"], ["確認", "check"],
  ["送信", "send"], ["送信", "post"], ["送信", "submit"],
  ["受信", "receive"], ["応答", "response"],
];

// --- Core Functions ---

/**
 * Spreading Activation Search
 *
 * 1. Tokenize query → n-grams
 * 2. Expand with concept mesh (synonyms)
 * 3. Find initial activations from token index
 * 4. Spread through node_links with decay
 * 5. Return ranked results
 */
export function synapseSearch(
  db: Database.Database,
  query: string,
  options: SynapseSearchOptions = {}
): ActivatedNode[] {
  const opts: Required<SynapseSearchOptions> = {
    maxDepth: 2,
    decayFactor: 0.5,
    threshold: 0.05,
    limit: 10,
    conceptExpansion: true,
    ...options,
  };

  // Lazy seed concept links if needed
  if (needsConceptSeed()) {
    seedConceptLinks(db);
  }

  // Step 1: Tokenize query
  const { tokens, originalTerms } = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  // Step 2: Concept expansion
  let allTokens = tokens.map((t) => t.token);
  const conceptWeights = new Map<string, number>();

  if (opts.conceptExpansion) {
    const expanded = expandConcepts(db, [...allTokens, ...originalTerms]);
    for (const exp of expanded) {
      if (!allTokens.includes(exp.term)) {
        allTokens.push(exp.term);
        conceptWeights.set(exp.term, exp.weight * 0.7); // expanded terms get 70% weight
      }
    }
    // Also tokenize expanded terms (for n-gram matching)
    for (const exp of expanded) {
      const expTokens = tokenize(exp.term);
      for (const et of expTokens) {
        if (!allTokens.includes(et.token)) {
          allTokens.push(et.token);
          conceptWeights.set(et.token, (conceptWeights.get(et.token) || 0) + exp.weight * 0.5);
        }
      }
    }
  }

  // Step 3: Initial activation from token index
  const activations = new Map<string, { activation: number; sources: string[] }>();

  if (allTokens.length > 0) {
    const placeholders = allTokens.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT node_id, token, SUM(frequency) as freq
         FROM node_tokens
         WHERE token IN (${placeholders})
         GROUP BY node_id, token`
      )
      .all(...allTokens) as Array<{ node_id: string; token: string; freq: number }>;

    // Count total nodes with each token (for IDF-like weighting)
    const tokenDocFreq = new Map<string, number>();
    for (const row of rows) {
      tokenDocFreq.set(row.token, (tokenDocFreq.get(row.token) || 0) + 1);
    }

    const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as { c: number }).c || 1;

    // Calculate activation for each node
    for (const row of rows) {
      const idf = Math.log(totalNodes / (tokenDocFreq.get(row.token) || 1) + 1);
      const conceptWeight = conceptWeights.get(row.token) || 1.0;
      const activation = row.freq * idf * conceptWeight;

      const current = activations.get(row.node_id) || { activation: 0, sources: [] };
      current.activation += activation;
      current.sources.push(row.token);
      activations.set(row.node_id, current);
    }
  }

  // Step 4: Spreading activation through node_links
  for (let depth = 1; depth <= opts.maxDepth; depth++) {
    const activeNodeIds = [...activations.entries()]
      .filter(([, v]) => v.activation >= opts.threshold)
      .map(([id]) => id);

    if (activeNodeIds.length === 0) break;

    const placeholders = activeNodeIds.map(() => "?").join(",");
    const neighbors = db
      .prepare(
        `SELECT
           CASE WHEN source_id IN (${placeholders}) THEN target_id ELSE source_id END as neighbor_id,
           CASE WHEN source_id IN (${placeholders}) THEN source_id ELSE target_id END as from_id,
           weight
         FROM node_links
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
      )
      .all(
        ...activeNodeIds,
        ...activeNodeIds,
        ...activeNodeIds,
        ...activeNodeIds
      ) as Array<{ neighbor_id: string; from_id: string; weight: number }>;

    for (const n of neighbors) {
      const sourceActivation = activations.get(n.from_id)?.activation || 0;
      const spreadAmount = sourceActivation * opts.decayFactor * (n.weight || 1.0);

      if (spreadAmount >= opts.threshold) {
        const current = activations.get(n.neighbor_id) || { activation: 0, sources: [] };
        current.activation += spreadAmount;
        current.sources.push(`spread:${n.from_id.slice(0, 8)}`);
        activations.set(n.neighbor_id, current);
      }
    }
  }

  // Step 5: Rank and return
  return [...activations.entries()]
    .filter(([, v]) => v.activation >= opts.threshold)
    .sort((a, b) => b[1].activation - a[1].activation)
    .slice(0, opts.limit)
    .map(([nodeId, v]) => ({
      nodeId,
      activation: v.activation,
      sources: [...new Set(v.sources)],
    }));
}

// --- Concept Expansion ---

export function expandConcepts(
  db: Database.Database,
  terms: string[]
): ConceptLink[] {
  if (terms.length === 0) return [];

  const results: ConceptLink[] = [];
  const placeholders = terms.map(() => "?").join(",");

  const rows = db
    .prepare(
      `SELECT term_b as term, weight FROM concept_links WHERE term_a IN (${placeholders})
       UNION
       SELECT term_a as term, weight FROM concept_links WHERE term_b IN (${placeholders})
       ORDER BY weight DESC
       LIMIT 30`
    )
    .all(...terms, ...terms) as Array<{ term: string; weight: number }>;

  for (const row of rows) {
    if (!terms.includes(row.term)) {
      results.push({ term: row.term, weight: row.weight });
    }
  }

  return results;
}

// --- Token Indexing ---

export function indexNodeTokens(
  db: Database.Database,
  nodeId: string,
  content: string,
  summary: string,
  tags: string[]
): void {
  // Clear existing tokens for this node
  db.prepare("DELETE FROM node_tokens WHERE node_id = ?").run(nodeId);

  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO node_tokens (node_id, token, field, frequency) VALUES (?, ?, ?, ?)"
  );

  // Index summary (higher weight field)
  for (const t of tokenize(summary)) {
    insertStmt.run(nodeId, t.token, "summary", t.count * 3); // 3x weight for summary
  }

  // Index content
  for (const t of tokenize(content)) {
    insertStmt.run(nodeId, t.token, "content", t.count);
  }

  // Index tags (exact match, high weight)
  for (const tag of tags) {
    const tagLower = tag.toLowerCase();
    insertStmt.run(nodeId, tagLower, "tag", 5); // 5x weight for tags
  }
}

// --- Hebbian Learning ---

export function hebbianUpdate(
  db: Database.Database,
  coAccessedNodeIds: string[]
): void {
  if (coAccessedNodeIds.length < 2) return;

  const updateStmt = db.prepare(
    `UPDATE node_links
     SET weight = MIN(weight + 0.1, 5.0),
         co_activation_count = co_activation_count + 1,
         last_co_activated_at = datetime('now')
     WHERE (source_id = ? AND target_id = ?)
        OR (source_id = ? AND target_id = ?)`
  );

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO node_links (id, source_id, target_id, link_type, weight, co_activation_count, last_co_activated_at)
     VALUES (?, ?, ?, 'related', 1.0, 1, datetime('now'))`
  );

  // Strengthen links between all co-accessed pairs
  for (let i = 0; i < coAccessedNodeIds.length; i++) {
    for (let j = i + 1; j < coAccessedNodeIds.length; j++) {
      const a = coAccessedNodeIds[i];
      const b = coAccessedNodeIds[j];

      const result = updateStmt.run(a, b, b, a);
      if (result.changes === 0) {
        // No existing link — create one (auto-discovered relationship)
        insertStmt.run(generateId(), a, b);
      }
    }
  }

  // Log co-access
  db.prepare(
    "INSERT INTO co_access_log (id, query_text, node_ids) VALUES (?, '', ?)"
  ).run(generateId(), JSON.stringify(coAccessedNodeIds));

  // Periodic decay check (every 50 co-accesses)
  const logCount = (
    db.prepare("SELECT COUNT(*) as c FROM co_access_log").get() as { c: number }
  ).c;
  if (logCount % 50 === 0) {
    runDecay(db);
  }
}

export function runDecay(db: Database.Database, decayRate: number = 0.995): void {
  db.prepare(
    `UPDATE node_links
     SET weight = MAX(weight * ?, 0.1)
     WHERE last_co_activated_at IS NULL
        OR last_co_activated_at < datetime('now', '-7 days')`
  ).run(decayRate);
}

// --- Concept Learning (co-occurrence) ---

export function learnConceptLink(
  db: Database.Database,
  termA: string,
  termB: string,
  source: "co_occurrence" | "extraction" = "co_occurrence"
): void {
  // Normalize order
  const [a, b] = termA < termB ? [termA, termB] : [termB, termA];

  const existing = db
    .prepare("SELECT id, weight FROM concept_links WHERE term_a = ? AND term_b = ?")
    .get(a, b) as { id: string; weight: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE concept_links SET weight = MIN(weight + 0.1, 5.0), updated_at = datetime('now') WHERE id = ?"
    ).run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO concept_links (id, term_a, term_b, weight, source) VALUES (?, ?, ?, 1.0, ?)"
    ).run(generateId(), a, b, source);
  }
}

// --- Seed Concepts ---

export function seedConceptLinks(db: Database.Database): void {
  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO concept_links (id, term_a, term_b, weight, source) VALUES (?, ?, ?, 1.0, 'manual')"
  );

  for (const [a, b] of SEED_CONCEPTS) {
    const [normA, normB] = a < b ? [a, b] : [b, a];
    insertStmt.run(generateId(), normA, normB);
  }
}

// --- Reindex All Nodes ---

export function reindexAllNodes(db: Database.Database): number {
  const nodes = db
    .prepare("SELECT id, content, summary FROM knowledge_nodes")
    .all() as Array<{ id: string; content: string; summary: string }>;

  for (const node of nodes) {
    const tags = db
      .prepare("SELECT tag FROM node_tags WHERE node_id = ?")
      .all(node.id) as Array<{ tag: string }>;
    indexNodeTokens(db, node.id, node.content, node.summary, tags.map((t) => t.tag));
  }

  return nodes.length;
}
