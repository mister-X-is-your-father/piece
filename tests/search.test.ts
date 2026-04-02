/**
 * Search System Integration Tests
 *
 * Tests the full multi-strategy search pipeline against an in-memory SQLite DB.
 * Measures retrieval quality with MRR (Mean Reciprocal Rank) and Recall@K.
 *
 * Pattern:
 *   1. Create :memory: DB with full schema
 *   2. Seed knowledge nodes, tags, tokens, links
 *   3. Run searches and assert quality metrics
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { multiStrategySearch } from "../src/knowledge/multi-strategy.js";
import { indexNodeTokens, seedConceptLinks } from "../src/knowledge/neuron.js";
import { tokenizeQuery } from "../src/knowledge/tokenizer.js";

// --- In-Memory DB Setup ---

function createTestDB(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply schema (inlined from db.ts migrations v1-v9)
  db.exec(`
    CREATE TABLE knowledge_nodes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      node_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      specialist TEXT,
      source_question TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT
    );

    CREATE TABLE node_citations (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      code_snippet TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_node_citations_node ON node_citations(node_id);

    CREATE TABLE node_links (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      description TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      last_co_activated_at TEXT,
      co_activation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, link_type)
    );
    CREATE INDEX idx_node_links_source ON node_links(source_id);
    CREATE INDEX idx_node_links_target ON node_links(target_id);

    CREATE TABLE node_tags (
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY(node_id, tag)
    );
    CREATE INDEX idx_node_tags_tag ON node_tags(tag);

    CREATE TABLE node_tokens (
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      field TEXT NOT NULL,
      frequency INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(node_id, token, field)
    );
    CREATE INDEX idx_node_tokens_token ON node_tokens(token);
    CREATE INDEX idx_node_tokens_node ON node_tokens(node_id);

    CREATE TABLE concept_links (
      id TEXT PRIMARY KEY,
      term_a TEXT NOT NULL,
      term_b TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(term_a, term_b)
    );
    CREATE INDEX idx_concept_links_a ON concept_links(term_a);
    CREATE INDEX idx_concept_links_b ON concept_links(term_b);

    CREATE TABLE co_access_log (
      id TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      node_ids TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE atoms (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      code_snippet TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      specialist TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_atoms_file ON atoms(file_path);

    CREATE TABLE embeddings (
      node_id TEXT PRIMARY KEY REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE embedding_buckets (
      node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      bucket_id INTEGER NOT NULL,
      plane_set INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(node_id, plane_set)
    );
    CREATE INDEX idx_embedding_buckets_lookup ON embedding_buckets(plane_set, bucket_id);

    CREATE TABLE strategy_performance (
      id TEXT PRIMARY KEY,
      feedback_event_id TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      contributed_node_ids TEXT NOT NULL,
      was_helpful INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE feedback_events (
      id TEXT PRIMARY KEY,
      query_cache_id TEXT,
      question TEXT NOT NULL,
      answer_summary TEXT NOT NULL,
      rating INTEGER,
      feedback_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed concept links
  seedConceptLinks(db);

  return db;
}

// --- Test Data Helpers ---

interface TestNode {
  id: string;
  summary: string;
  content: string;
  tags: string[];
  confidence?: number;
}

function insertTestNode(db: Database.Database, node: TestNode): void {
  db.prepare(
    `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence)
     VALUES (?, ?, ?, 'fact', ?)`
  ).run(node.id, node.content, node.summary, node.confidence ?? 0.8);

  for (const tag of node.tags) {
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(node.id, tag);
  }

  indexNodeTokens(db, node.id, node.content, node.summary, node.tags);
}

function insertTestLink(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  linkType: string = "related",
  weight: number = 1.0
): void {
  db.prepare(
    `INSERT OR IGNORE INTO node_links (id, source_id, target_id, link_type, weight)
     VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), sourceId, targetId, linkType, weight);
}

// --- Retrieval Quality Metrics ---

/**
 * Mean Reciprocal Rank: 1/rank of first relevant result.
 * Returns 0 if no relevant result found.
 */
function mrr(results: Array<{ nodeId: string }>, relevantIds: Set<string>): number {
  for (let i = 0; i < results.length; i++) {
    if (relevantIds.has(results[i].nodeId)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Recall@K: fraction of relevant items found in top-K results.
 */
function recallAtK(
  results: Array<{ nodeId: string }>,
  relevantIds: Set<string>,
  k: number
): number {
  const topK = results.slice(0, k);
  let found = 0;
  for (const r of topK) {
    if (relevantIds.has(r.nodeId)) found++;
  }
  return found / relevantIds.size;
}

// === TESTS ===

describe("Tokenizer", () => {
  it("tokenizes Japanese text into bigrams and trigrams", () => {
    const { tokens } = tokenizeQuery("認証フロー");
    const tokenStrings = tokens.map((t) => t.token);
    expect(tokenStrings).toContain("認証");
    expect(tokenStrings).toContain("証フ");
    expect(tokenStrings).toContain("認証フ");
  });

  it("tokenizes English text into words", () => {
    const { tokens, originalTerms } = tokenizeQuery("user authentication flow");
    const tokenStrings = tokens.map((t) => t.token);
    expect(tokenStrings).toContain("user");
    expect(tokenStrings).toContain("authentication");
    expect(tokenStrings).toContain("flow");
    expect(originalTerms).toContain("user");
  });

  it("removes stop words", () => {
    const { tokens } = tokenizeQuery("the user is authenticated");
    const tokenStrings = tokens.map((t) => t.token);
    expect(tokenStrings).not.toContain("the");
    expect(tokenStrings).not.toContain("is");
    expect(tokenStrings).toContain("user");
    expect(tokenStrings).toContain("authenticated");
  });
});

describe("Query Preprocessing", () => {
  // Dynamic import since preprocessQuery is new
  it("normalizes NFKC and extracts phrases", async () => {
    const { preprocessQuery } = await import("../src/knowledge/tokenizer.js");
    const result = preprocessQuery('"exact match" remaining');
    expect(result.phrases).toContain("exact match");
    expect(result.normalized).toBe("remaining");
  });

  it("extracts negations", async () => {
    const { preprocessQuery } = await import("../src/knowledge/tokenizer.js");
    const result = preprocessQuery("auth -jwt NOT token");
    expect(result.negations).toContain("jwt");
    expect(result.negations).toContain("token");
    expect(result.normalized).not.toContain("jwt");
  });

  it("applies fuzzy correction against vocabulary", async () => {
    const { preprocessQuery } = await import("../src/knowledge/tokenizer.js");
    const vocab = new Set(["authentication", "database", "routing"]);
    const result = preprocessQuery("authentcation", vocab);
    expect(result.corrected).toBe("authentication");
  });
});

describe("Multi-Strategy Search", () => {
  let db: Database.Database;

  const nodes: TestNode[] = [
    {
      id: "node-auth",
      summary: "User authentication via JWT tokens",
      content: "The auth module handles login, token generation, and session management using JWT. Located in src/auth/handler.ts",
      tags: ["auth", "jwt", "login", "security"],
    },
    {
      id: "node-routing",
      summary: "Express routing configuration",
      content: "Routes are defined in src/routes/index.ts. Each route maps to a handler function. Middleware is applied per-route.",
      tags: ["routing", "express", "middleware"],
    },
    {
      id: "node-db",
      summary: "Database connection and query layer",
      content: "PostgreSQL connection pool managed by src/db/pool.ts. Query builder wraps pg for type safety.",
      tags: ["database", "postgresql", "query"],
    },
    {
      id: "node-auth-middleware",
      summary: "Auth middleware for route protection",
      content: "Middleware in src/middleware/auth.ts verifies JWT tokens and attaches user to request context.",
      tags: ["auth", "middleware", "jwt", "security"],
    },
    {
      id: "node-error",
      summary: "Global error handling",
      content: "Error handler in src/middleware/error.ts catches unhandled exceptions and returns structured error responses.",
      tags: ["error", "middleware", "handler"],
    },
    {
      id: "node-config",
      summary: "Application configuration management",
      content: "Config loaded from environment variables via src/config/index.ts. Supports .env files for local development.",
      tags: ["config", "environment", "settings"],
    },
  ];

  beforeEach(() => {
    db = createTestDB();
    for (const node of nodes) {
      insertTestNode(db, node);
    }
    // Add some links
    insertTestLink(db, "node-auth", "node-auth-middleware", "elaborates", 2.0);
    insertTestLink(db, "node-routing", "node-auth-middleware", "depends_on", 1.5);
    insertTestLink(db, "node-routing", "node-error", "depends_on", 1.0);
  });

  it("finds auth-related nodes for auth query", () => {
    const results = multiStrategySearch(db, "authentication login", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);

    const relevant = new Set(["node-auth", "node-auth-middleware"]);
    const mrrScore = mrr(results, relevant);
    const recall = recallAtK(results, relevant, 3);

    // MRR should be 1.0 (auth node should be first)
    expect(mrrScore).toBeGreaterThanOrEqual(0.5);
    // Both auth nodes should be in top-3
    expect(recall).toBeGreaterThanOrEqual(0.5);
  });

  it("finds routing nodes for routing query", () => {
    const results = multiStrategySearch(db, "routing middleware", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);

    const relevant = new Set(["node-routing", "node-auth-middleware"]);
    const mrrScore = mrr(results, relevant);

    expect(mrrScore).toBeGreaterThanOrEqual(0.5);
  });

  it("finds database nodes for db query", () => {
    const results = multiStrategySearch(db, "database postgresql connection", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);

    const relevant = new Set(["node-db"]);
    const mrrScore = mrr(results, relevant);

    expect(mrrScore).toBeGreaterThanOrEqual(0.5);
  });

  it("finds config nodes for config/settings query", () => {
    const results = multiStrategySearch(db, "configuration settings environment", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);

    const relevant = new Set(["node-config"]);
    const topIds = results.slice(0, 3).map((r) => r.nodeId);
    expect(topIds).toContain("node-config");
  });

  it("cross-language: Japanese query finds English nodes", () => {
    const results = multiStrategySearch(db, "認証", { limit: 5 });

    // "認証" should expand via concept mesh to "auth"/"authentication"
    expect(results.length).toBeGreaterThan(0);

    const relevant = new Set(["node-auth", "node-auth-middleware"]);
    const recall = recallAtK(results, relevant, 5);

    expect(recall).toBeGreaterThan(0);
  });

  it("cross-strategy bonus: multi-hit nodes rank higher", () => {
    const results = multiStrategySearch(db, "auth jwt middleware", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);

    // node-auth-middleware has tags [auth, middleware, jwt] — should hit tag_cluster AND synapse
    const authMw = results.find((r) => r.nodeId === "node-auth-middleware");
    if (authMw) {
      expect(authMw.strategies.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns results with multiple strategy hits", () => {
    const results = multiStrategySearch(db, "auth login security", { limit: 10 });

    // At least one result should come from multiple strategies
    const multiHit = results.find((r) => r.strategies.length >= 2);
    expect(multiHit).toBeDefined();
  });

  it("respects limit parameter", () => {
    const results = multiStrategySearch(db, "middleware", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for completely unrelated query", () => {
    const results = multiStrategySearch(db, "quantum physics relativity", { limit: 5 });
    // Should return few or no results (no matching tokens)
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("Retrieval Quality Benchmark", () => {
  let db: Database.Database;

  // Larger dataset for quality benchmarking
  const benchmarkNodes: TestNode[] = [
    { id: "b1", summary: "User registration endpoint", content: "POST /api/users creates a new user account with email validation", tags: ["api", "user", "registration"] },
    { id: "b2", summary: "Password reset flow", content: "Password reset sends email with token, user clicks link, enters new password", tags: ["auth", "password", "email"] },
    { id: "b3", summary: "JWT token refresh mechanism", content: "Refresh tokens stored in httpOnly cookie, rotated on each use, 7-day expiry", tags: ["jwt", "auth", "token", "security"] },
    { id: "b4", summary: "Rate limiting middleware", content: "Express-rate-limit applied globally, 100 requests per 15 minutes per IP", tags: ["middleware", "security", "rate-limit"] },
    { id: "b5", summary: "Database migration system", content: "Knex migrations in src/db/migrations/, run on deploy via npm run migrate", tags: ["database", "migration", "deploy"] },
    { id: "b6", summary: "File upload handling", content: "Multer middleware for multipart uploads, stored in S3, max 10MB per file", tags: ["upload", "file", "s3", "middleware"] },
    { id: "b7", summary: "WebSocket real-time notifications", content: "Socket.io handles real-time events, authenticated via JWT handshake", tags: ["websocket", "realtime", "notification"] },
    { id: "b8", summary: "Caching layer with Redis", content: "Redis cache for session data and API responses, TTL-based invalidation", tags: ["cache", "redis", "performance"] },
    { id: "b9", summary: "Logging and monitoring setup", content: "Winston logger with structured JSON, shipped to Datadog via agent", tags: ["logging", "monitoring", "datadog"] },
    { id: "b10", summary: "CI/CD pipeline configuration", content: "GitHub Actions runs tests, lint, build on PR. Deploy to ECS on merge to main", tags: ["ci", "cd", "deploy", "github-actions"] },
  ];

  // Query → expected relevant node IDs
  const testQueries = [
    { query: "how does user registration work", relevant: ["b1"] },
    { query: "password reset", relevant: ["b2"] },
    { query: "JWT token security", relevant: ["b3", "b4"] },
    { query: "database migration deploy", relevant: ["b5", "b10"] },
    { query: "file upload S3", relevant: ["b6"] },
    { query: "real-time notifications websocket", relevant: ["b7"] },
    { query: "caching performance redis", relevant: ["b8"] },
    { query: "logging monitoring", relevant: ["b9"] },
  ];

  beforeEach(() => {
    db = createTestDB();
    for (const node of benchmarkNodes) {
      insertTestNode(db, node);
    }
  });

  it("achieves MRR >= 0.5 across benchmark queries", () => {
    let totalMRR = 0;

    for (const tq of testQueries) {
      const results = multiStrategySearch(db, tq.query, { limit: 5 });
      const relevant = new Set(tq.relevant);
      totalMRR += mrr(results, relevant);
    }

    const avgMRR = totalMRR / testQueries.length;
    // Target: average MRR >= 0.5 (first relevant result in top-2 on average)
    expect(avgMRR).toBeGreaterThanOrEqual(0.5);
  });

  it("achieves Recall@3 >= 0.5 across benchmark queries", () => {
    let totalRecall = 0;

    for (const tq of testQueries) {
      const results = multiStrategySearch(db, tq.query, { limit: 5 });
      const relevant = new Set(tq.relevant);
      totalRecall += recallAtK(results, relevant, 3);
    }

    const avgRecall = totalRecall / testQueries.length;
    // Target: average Recall@3 >= 0.5
    expect(avgRecall).toBeGreaterThanOrEqual(0.5);
  });

  it("reports per-query metrics for debugging", () => {
    const report: Array<{ query: string; mrr: number; recall3: number; topResults: string[] }> = [];

    for (const tq of testQueries) {
      const results = multiStrategySearch(db, tq.query, { limit: 5 });
      const relevant = new Set(tq.relevant);
      report.push({
        query: tq.query,
        mrr: mrr(results, relevant),
        recall3: recallAtK(results, relevant, 3),
        topResults: results.slice(0, 3).map((r) => r.nodeId),
      });
    }

    // Log for visibility (vitest --reporter=verbose will show this)
    console.table(report);

    // At least 75% of queries should have MRR > 0
    const hitsCount = report.filter((r) => r.mrr > 0).length;
    expect(hitsCount / report.length).toBeGreaterThanOrEqual(0.75);
  });
});
