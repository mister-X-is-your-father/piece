/**
 * Atomic Knowledge System
 *
 * 知識を最小単位(Atom)に分解し、論理的に接続する。
 *
 * Atom = 1つの検証可能な事実
 *   例: "handleLogin関数はJWTトークンを返す" [source:auth.ts:L34]
 *   NOT: "認証システムはJWTベースで動作しており..." (これは複数のAtom)
 *
 * AtomChain = Atom同士の論理的接続
 *   A: "handleLoginはjwt.sign()を呼ぶ" [source:auth.ts:L34]
 *   B: "jwt.sign()はtokenを生成する" [source:jwt.ts:L12]
 *   C: "生成されたtokenはAuthorizationヘッダーで返される" [source:auth.ts:L38]
 *   Chain: A → B → C (ログインからトークン返却までの証明)
 *
 * Completeness Map = コードベースの理解度マップ
 *   src/auth/ : 85% understood (12/14 functions documented)
 *   src/db/   : 30% understood (3/10 functions documented)
 */

import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { tokenize } from "./tokenizer.js";
import { indexNodeTokens } from "./neuron.js";

// --- Atom: 最小知識単位 ---

export interface Atom {
  id: string;
  /** 1文で表現できる事実 */
  claim: string;
  /** 根拠となるソースコード */
  file_path: string;
  start_line: number;
  end_line: number;
  code_snippet: string;
  /** 検証状態 */
  verified: boolean;
  /** 信頼度 (0-1) — 依存Atomの信頼度から伝播 */
  confidence: number;
  /** どのSpecialistドメインか */
  specialist: string | null;
  /** タグ */
  tags: string[];
}

export interface AtomLink {
  source_atom_id: string;
  target_atom_id: string;
  relation: "implies" | "requires" | "contradicts" | "elaborates" | "part_of";
  confidence: number;
}

// --- Completeness Map ---

export interface CompletenessEntry {
  path: string; // file or directory
  total_functions: number;
  documented_functions: number;
  total_atoms: number;
  verified_atoms: number;
  coverage: number; // 0-1
}

// --- SQL Schema (migration v3) ---

export const MIGRATION_V3_SQL = `
  -- Atomic knowledge units
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
  CREATE INDEX idx_atoms_specialist ON atoms(specialist);
  CREATE INDEX idx_atoms_verified ON atoms(verified);

  -- Atom tags
  CREATE TABLE atom_tags (
    atom_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY(atom_id, tag)
  );
  CREATE INDEX idx_atom_tags_tag ON atom_tags(tag);

  -- Logical links between atoms (proof chains)
  CREATE TABLE atom_links (
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
  CREATE INDEX idx_atom_links_source ON atom_links(source_atom_id);
  CREATE INDEX idx_atom_links_target ON atom_links(target_atom_id);

  -- Completeness tracking per file/directory
  CREATE TABLE completeness_map (
    path TEXT PRIMARY KEY,
    path_type TEXT NOT NULL CHECK(path_type IN ('file', 'directory')),
    total_functions INTEGER NOT NULL DEFAULT 0,
    documented_functions INTEGER NOT NULL DEFAULT 0,
    total_atoms INTEGER NOT NULL DEFAULT 0,
    verified_atoms INTEGER NOT NULL DEFAULT 0,
    coverage REAL NOT NULL DEFAULT 0.0,
    last_scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Contradiction log
  CREATE TABLE contradictions (
    id TEXT PRIMARY KEY,
    atom_a_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
    atom_b_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'accepted')),
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
`;

// --- Atom Store ---

export class AtomStore {
  constructor(private db: Database.Database) {}

  insertAtom(atom: Omit<Atom, "id">): Atom {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO atoms (id, claim, file_path, start_line, end_line, code_snippet, verified, confidence, specialist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, atom.claim, atom.file_path, atom.start_line, atom.end_line,
        atom.code_snippet, atom.verified ? 1 : 0, atom.confidence, atom.specialist);

    for (const tag of atom.tags) {
      this.db.prepare("INSERT OR IGNORE INTO atom_tags (atom_id, tag) VALUES (?, ?)").run(id, tag);
    }

    // Also index in node_tokens for synapse search
    indexNodeTokens(this.db, id, atom.code_snippet, atom.claim, atom.tags);

    return { ...atom, id };
  }

  getAtom(id: string): Atom | null {
    const row = this.db.prepare("SELECT * FROM atoms WHERE id = ?").get(id) as any;
    if (!row) return null;
    const tags = this.db.prepare("SELECT tag FROM atom_tags WHERE atom_id = ?")
      .all(id) as Array<{ tag: string }>;
    return { ...row, verified: !!row.verified, tags: tags.map(t => t.tag) };
  }

  /** Find atoms about a specific file */
  getAtomsForFile(filePath: string): Atom[] {
    const rows = this.db
      .prepare("SELECT * FROM atoms WHERE file_path = ? ORDER BY start_line")
      .all(filePath) as any[];
    return rows.map(r => {
      const tags = this.db.prepare("SELECT tag FROM atom_tags WHERE atom_id = ?")
        .all(r.id) as Array<{ tag: string }>;
      return { ...r, verified: !!r.verified, tags: tags.map(t => t.tag) };
    });
  }

  /** Link two atoms with a logical relation */
  linkAtoms(link: AtomLink): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO atom_links (id, source_atom_id, target_atom_id, relation, confidence)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(generateId(), link.source_atom_id, link.target_atom_id, link.relation, link.confidence);
  }

  /** Get proof chain: all atoms reachable from a starting atom */
  getProofChain(atomId: string, maxDepth: number = 5): Atom[] {
    const visited = new Set<string>();
    const chain: Atom[] = [];

    const walk = (id: string, depth: number) => {
      if (depth > maxDepth || visited.has(id)) return;
      visited.add(id);

      const atom = this.getAtom(id);
      if (atom) chain.push(atom);

      const links = this.db
        .prepare("SELECT target_atom_id FROM atom_links WHERE source_atom_id = ? AND relation IN ('implies', 'requires', 'part_of')")
        .all(id) as Array<{ target_atom_id: string }>;

      for (const link of links) {
        walk(link.target_atom_id, depth + 1);
      }
    };

    walk(atomId, 0);
    return chain;
  }

  /** Detect contradictions between atoms about the same file/function */
  findContradictions(filePath: string): Array<{ atomA: Atom; atomB: Atom }> {
    const atoms = this.getAtomsForFile(filePath);
    const contradictions: Array<{ atomA: Atom; atomB: Atom }> = [];

    // Check for overlapping line ranges with different claims
    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const a = atoms[i];
        const b = atoms[j];
        // Overlapping line ranges
        if (a.start_line <= b.end_line && b.start_line <= a.end_line) {
          // Same code region, check if already linked as contradiction
          const existing = this.db
            .prepare(
              "SELECT id FROM atom_links WHERE source_atom_id = ? AND target_atom_id = ? AND relation = 'contradicts'"
            )
            .get(a.id, b.id);
          if (!existing) {
            contradictions.push({ atomA: a, atomB: b });
          }
        }
      }
    }

    return contradictions;
  }

  /** Propagate confidence: if atom A requires atom B, and B's confidence drops, A drops too */
  propagateConfidence(atomId: string): void {
    const dependsOn = this.db
      .prepare(
        `SELECT a.*, al.confidence as link_conf
         FROM atom_links al
         JOIN atoms a ON a.id = al.target_atom_id
         WHERE al.source_atom_id = ? AND al.relation = 'requires'`
      )
      .all(atomId) as Array<any>;

    if (dependsOn.length === 0) return;

    // Confidence = min of all required atom confidences × link confidence
    let minConf = 1.0;
    for (const dep of dependsOn) {
      const effective = dep.confidence * dep.link_conf;
      if (effective < minConf) minConf = effective;
    }

    this.db
      .prepare("UPDATE atoms SET confidence = ?, updated_at = datetime('now') WHERE id = ?")
      .run(minConf, atomId);
  }

  // --- Completeness Map ---

  updateCompleteness(
    path: string,
    pathType: "file" | "directory",
    totalFunctions: number,
    documentedFunctions: number
  ): void {
    const totalAtoms = (this.db
      .prepare("SELECT COUNT(*) as c FROM atoms WHERE file_path LIKE ?")
      .get(pathType === "file" ? path : `${path}%`) as { c: number }).c;

    const verifiedAtoms = (this.db
      .prepare("SELECT COUNT(*) as c FROM atoms WHERE file_path LIKE ? AND verified = 1")
      .get(pathType === "file" ? path : `${path}%`) as { c: number }).c;

    const coverage = totalFunctions > 0
      ? documentedFunctions / totalFunctions
      : 0;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO completeness_map
         (path, path_type, total_functions, documented_functions, total_atoms, verified_atoms, coverage, last_scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(path, pathType, totalFunctions, documentedFunctions, totalAtoms, verifiedAtoms, coverage);
  }

  getCompletenessMap(): CompletenessEntry[] {
    return this.db
      .prepare("SELECT * FROM completeness_map ORDER BY coverage ASC")
      .all() as CompletenessEntry[];
  }

  getOverallCompleteness(): { coverage: number; totalAtoms: number; verifiedAtoms: number; contradictions: number } {
    const atoms = this.db.prepare("SELECT COUNT(*) as c FROM atoms").get() as { c: number };
    const verified = this.db.prepare("SELECT COUNT(*) as c FROM atoms WHERE verified = 1").get() as { c: number };
    const contradictions = this.db.prepare("SELECT COUNT(*) as c FROM contradictions WHERE status = 'open'").get() as { c: number };

    const map = this.getCompletenessMap();
    const totalCoverage = map.length > 0
      ? map.reduce((sum, e) => sum + e.coverage, 0) / map.length
      : 0;

    return {
      coverage: totalCoverage,
      totalAtoms: atoms.c,
      verifiedAtoms: verified.c,
      contradictions: contradictions.c,
    };
  }

  getAtomCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as c FROM atoms").get() as { c: number }).c;
  }
}
