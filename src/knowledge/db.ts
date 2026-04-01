import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "../utils/logger.js";

let db: Database.Database | null = null;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      -- Knowledge nodes
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        node_type TEXT NOT NULL CHECK(node_type IN (
          'fact', 'explanation', 'pattern', 'relationship', 'flow_step', 'resolution'
        )),
        confidence REAL NOT NULL DEFAULT 0.5,
        specialist TEXT,
        source_question TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );

      -- FTS5 full-text search
      CREATE VIRTUAL TABLE knowledge_nodes_fts USING fts5(
        summary, content,
        content='knowledge_nodes', content_rowid='rowid'
      );

      -- FTS sync triggers
      CREATE TRIGGER knowledge_nodes_ai AFTER INSERT ON knowledge_nodes BEGIN
        INSERT INTO knowledge_nodes_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      CREATE TRIGGER knowledge_nodes_ad AFTER DELETE ON knowledge_nodes BEGIN
        INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
      END;

      CREATE TRIGGER knowledge_nodes_au AFTER UPDATE ON knowledge_nodes BEGIN
        INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
        INSERT INTO knowledge_nodes_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      -- Node citations
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

      -- Node links (knowledge graph edges)
      CREATE TABLE node_links (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        link_type TEXT NOT NULL CHECK(link_type IN (
          'related', 'depends_on', 'contradicts', 'elaborates', 'resolves'
        )),
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, target_id, link_type)
      );
      CREATE INDEX idx_node_links_source ON node_links(source_id);
      CREATE INDEX idx_node_links_target ON node_links(target_id);

      -- Mysteries
      CREATE TABLE mysteries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        context TEXT,
        priority INTEGER NOT NULL DEFAULT 5 CHECK(priority >= 1 AND priority <= 10),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN (
          'open', 'investigating', 'resolved', 'wont_fix'
        )),
        specialist TEXT,
        source TEXT NOT NULL CHECK(source IN (
          'analysis', 'fact_check', 'ask', 'investigation', 'manual'
        )),
        resolution_node_id TEXT REFERENCES knowledge_nodes(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX idx_mysteries_status ON mysteries(status, priority DESC);
      CREATE INDEX idx_mysteries_specialist ON mysteries(specialist);

      -- E2E Flows
      CREATE TABLE flows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        trigger_description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Flow steps
      CREATE TABLE flow_steps (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL,
        specialist TEXT,
        description TEXT NOT NULL,
        file_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        code_snippet TEXT,
        node_id TEXT REFERENCES knowledge_nodes(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(flow_id, step_order)
      );
      CREATE INDEX idx_flow_steps_flow ON flow_steps(flow_id, step_order);

      -- Investigations
      CREATE TABLE investigations (
        id TEXT PRIMARY KEY,
        mystery_id TEXT REFERENCES mysteries(id),
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
          'pending', 'running', 'completed', 'failed'
        )),
        findings TEXT,
        nodes_created INTEGER NOT NULL DEFAULT 0,
        nodes_updated INTEGER NOT NULL DEFAULT 0,
        mysteries_resolved INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_investigations_status ON investigations(status);

      -- Tags
      CREATE TABLE node_tags (
        node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(node_id, tag)
      );
      CREATE INDEX idx_node_tags_tag ON node_tags(tag);

      -- Query cache: past questions + answers for instant replay
      CREATE TABLE query_cache (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        question_normalized TEXT NOT NULL,
        answer TEXT NOT NULL,
        specialists_consulted TEXT NOT NULL,
        fact_check_summary TEXT,
        knowledge_node_ids TEXT,
        investigation_method TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_hit_at TEXT
      );

      -- FTS on query cache for similar question matching
      CREATE VIRTUAL TABLE query_cache_fts USING fts5(
        question, question_normalized,
        content='query_cache', content_rowid='rowid'
      );

      CREATE TRIGGER query_cache_ai AFTER INSERT ON query_cache BEGIN
        INSERT INTO query_cache_fts(rowid, question, question_normalized)
        VALUES (new.rowid, new.question, new.question_normalized);
      END;

      CREATE TRIGGER query_cache_ad AFTER DELETE ON query_cache BEGIN
        INSERT INTO query_cache_fts(query_cache_fts, rowid, question, question_normalized)
        VALUES ('delete', old.rowid, old.question, old.question_normalized);
      END;

      -- Migration tracking
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

export function getKnowledgeDB(scribePath: string): Database.Database {
  if (db) return db;

  mkdirSync(scribePath, { recursive: true });
  const dbPath = join(scribePath, "knowledge.db");

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  return db;
}

export function closeKnowledgeDB(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(database: Database.Database): void {
  // Check if _migrations table exists
  const tableExists = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
    )
    .get();

  let currentVersion = 0;
  if (tableExists) {
    const row = database
      .prepare("SELECT MAX(version) as v FROM _migrations")
      .get() as { v: number | null } | undefined;
    currentVersion = row?.v ?? 0;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      logger.debug(`Running migration v${migration.version}...`);
      database.exec(migration.sql);

      // Record migration (table is created in migration 1)
      if (migration.version >= 1) {
        database
          .prepare("INSERT INTO _migrations (version) VALUES (?)")
          .run(migration.version);
      }

      logger.debug(`Migration v${migration.version} applied`);
    }
  }
}

export function generateId(): string {
  return crypto.randomUUID();
}
