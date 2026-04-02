import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { logger } from "../utils/logger.js";

let db: Database.Database | null = null;
let _needsSeed = false;

export function needsConceptSeed(): boolean {
  if (_needsSeed) {
    _needsSeed = false;
    return true;
  }
  return false;
}

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
  {
    version: 2,
    sql: `
      -- N-gram token index (replaces FTS5 for search)
      CREATE TABLE node_tokens (
        node_id   TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        token     TEXT NOT NULL,
        field     TEXT NOT NULL CHECK(field IN ('summary', 'content', 'tag')),
        frequency INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(node_id, token, field)
      );
      CREATE INDEX idx_node_tokens_token ON node_tokens(token);
      CREATE INDEX idx_node_tokens_node  ON node_tokens(node_id);

      -- Concept mesh (synonym/cross-language expansion)
      CREATE TABLE concept_links (
        id        TEXT PRIMARY KEY,
        term_a    TEXT NOT NULL,
        term_b    TEXT NOT NULL,
        weight    REAL NOT NULL DEFAULT 1.0,
        source    TEXT NOT NULL CHECK(source IN ('manual', 'co_occurrence', 'extraction')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(term_a, term_b)
      );
      CREATE INDEX idx_concept_links_a ON concept_links(term_a);
      CREATE INDEX idx_concept_links_b ON concept_links(term_b);

      -- Hebbian weight on node_links
      ALTER TABLE node_links ADD COLUMN weight REAL NOT NULL DEFAULT 1.0;
      ALTER TABLE node_links ADD COLUMN last_co_activated_at TEXT;
      ALTER TABLE node_links ADD COLUMN co_activation_count INTEGER NOT NULL DEFAULT 0;

      -- Co-access log (for Hebbian learning)
      CREATE TABLE co_access_log (
        id         TEXT PRIMARY KEY,
        query_text TEXT NOT NULL,
        node_ids   TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Atomic knowledge units
      CREATE TABLE IF NOT EXISTS atoms (
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
      CREATE INDEX IF NOT EXISTS idx_atoms_file ON atoms(file_path);
      CREATE INDEX IF NOT EXISTS idx_atoms_specialist ON atoms(specialist);
      CREATE INDEX IF NOT EXISTS idx_atoms_verified ON atoms(verified);

      CREATE TABLE IF NOT EXISTS atom_tags (
        atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(atom_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_atom_tags_tag ON atom_tags(tag);

      CREATE TABLE IF NOT EXISTS atom_links (
        id TEXT PRIMARY KEY,
        source_atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
        target_atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK(relation IN (
          'implies', 'requires', 'contradicts', 'elaborates', 'part_of'
        )),
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_atom_id, target_atom_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_atom_links_source ON atom_links(source_atom_id);
      CREATE INDEX IF NOT EXISTS idx_atom_links_target ON atom_links(target_atom_id);

      CREATE TABLE IF NOT EXISTS completeness_map (
        path TEXT PRIMARY KEY,
        path_type TEXT NOT NULL CHECK(path_type IN ('file', 'directory')),
        total_functions INTEGER NOT NULL DEFAULT 0,
        documented_functions INTEGER NOT NULL DEFAULT 0,
        total_atoms INTEGER NOT NULL DEFAULT 0,
        verified_atoms INTEGER NOT NULL DEFAULT 0,
        coverage REAL NOT NULL DEFAULT 0.0,
        last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS contradictions (
        id TEXT PRIMARY KEY,
        atom_a_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
        atom_b_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'accepted')),
        resolution TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS mece_matrices (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('function', 'module', 'flow', 'custom')),
        template TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        cols_json TEXT NOT NULL,
        coverage REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mece_target ON mece_matrices(target);

      CREATE TABLE IF NOT EXISTS mece_cells (
        id TEXT PRIMARY KEY,
        matrix_id TEXT NOT NULL REFERENCES mece_matrices(id) ON DELETE CASCADE,
        row_label TEXT NOT NULL,
        col_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uncovered' CHECK(status IN (
          'covered', 'uncovered', 'not_applicable', 'partial'
        )),
        evidence_id TEXT,
        note TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(matrix_id, row_label, col_label)
      );
      CREATE INDEX IF NOT EXISTS idx_mece_cells_matrix ON mece_cells(matrix_id);
      CREATE INDEX IF NOT EXISTS idx_mece_cells_status ON mece_cells(status);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS embeddings (
        node_id TEXT PRIMARY KEY REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        vector BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS feedback_events (
        id TEXT PRIMARY KEY,
        query_cache_id TEXT REFERENCES query_cache(id),
        question TEXT NOT NULL,
        answer_summary TEXT NOT NULL,
        rating INTEGER CHECK(rating >= 1 AND rating <= 5),
        feedback_text TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS node_feedback (
        id TEXT PRIMARY KEY,
        feedback_event_id TEXT NOT NULL REFERENCES feedback_events(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL CHECK(verdict IN (
          'correct', 'incorrect', 'misleading', 'outdated', 'incomplete'
        )),
        correction TEXT,
        before_confidence REAL NOT NULL,
        after_confidence REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS strategy_performance (
        id TEXT PRIMARY KEY,
        feedback_event_id TEXT NOT NULL REFERENCES feedback_events(id) ON DELETE CASCADE,
        strategy_name TEXT NOT NULL,
        contributed_node_ids TEXT NOT NULL,
        was_helpful INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS learned_rules (
        id TEXT PRIMARY KEY,
        rule_type TEXT NOT NULL CHECK(rule_type IN (
          'avoid_node', 'boost_node', 'concept_correction', 'strategy_adjust', 'answer_pattern'
        )),
        condition_text TEXT NOT NULL,
        action_text TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1.0,
        applied_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS screens (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, route TEXT, description TEXT,
        file_path TEXT NOT NULL, component_name TEXT, layout TEXT,
        status TEXT NOT NULL DEFAULT 'detected',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL,
        description TEXT, handler_file TEXT NOT NULL, handler_function TEXT,
        request_params TEXT, response_type TEXT,
        status TEXT NOT NULL DEFAULT 'detected',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, screen_id TEXT REFERENCES screens(id),
        name TEXT NOT NULL, description TEXT,
        trigger_type TEXT, handler_file TEXT, handler_function TEXT,
        calls_endpoint_id TEXT REFERENCES endpoints(id), step_order INTEGER,
        status TEXT NOT NULL DEFAULT 'detected',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'detected',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS feature_connections (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS operation_flows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        feature_id TEXT REFERENCES features(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS operation_flow_steps (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL REFERENCES operation_flows(id) ON DELETE CASCADE,
        step_order INTEGER NOT NULL, action_type TEXT NOT NULL,
        description TEXT NOT NULL,
        screen_id TEXT REFERENCES screens(id),
        operation_id TEXT REFERENCES operations(id),
        endpoint_id TEXT REFERENCES endpoints(id),
        file_path TEXT, line_number INTEGER, code_snippet TEXT,
        UNIQUE(flow_id, step_order)
      );
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS log_sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
        entry_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
        time_range_start TEXT, time_range_end TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS log_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
        timestamp TEXT, level TEXT NOT NULL, message TEXT NOT NULL,
        source TEXT, line_number INTEGER NOT NULL, raw TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_log_entries_session ON log_entries(session_id, line_number);
      CREATE INDEX IF NOT EXISTS idx_log_entries_level ON log_entries(level);
      CREATE TABLE IF NOT EXISTS log_findings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
        finding_type TEXT NOT NULL, description TEXT NOT NULL,
        evidence_entries TEXT NOT NULL, severity INTEGER NOT NULL DEFAULT 5,
        knowledge_node_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  const migrationsRun = runMigrations(db);
  if (migrationsRun.includes(2)) {
    // Seed concept links synchronously after v2 migration
    // Dynamic import is async, so we seed lazily on first search instead
    db.prepare(
      "INSERT OR IGNORE INTO concept_links (id, term_a, term_b, weight, source) VALUES (?, ?, ?, 1.0, 'manual')"
    ); // just ensure table exists
    _needsSeed = true;
  }
  return db;
}

export function closeKnowledgeDB(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(database: Database.Database): number[] {
  const applied: number[] = [];
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
      applied.push(migration.version);

      // Record migration (table is created in migration 1)
      if (migration.version >= 1) {
        database
          .prepare("INSERT INTO _migrations (version) VALUES (?)")
          .run(migration.version);
      }

      logger.debug(`Migration v${migration.version} applied`);
    }
  }
  return applied;
}

export function generateId(): string {
  return crypto.randomUUID();
}
