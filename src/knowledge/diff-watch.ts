/**
 * Diff Watch: コード変更を検知し、該当知識を自動で「古い」マーク
 *
 * git diff → 変更ファイル → 関連knowledge_nodes/atoms/screens/endpointsを特定
 * → confidenceを下げる → mysteryとして「要再調査」登録
 */

import { execSync } from "node:child_process";
import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { logger } from "../utils/logger.js";

export interface DiffResult {
  changedFiles: string[];
  staleNodes: number;
  mysteriesCreated: number;
}

/**
 * Detect code changes and mark related knowledge as stale.
 */
export function detectAndMarkStale(
  db: Database.Database,
  rootPath: string,
  since?: string
): DiffResult {
  // Get changed files from git
  const changedFiles = getChangedFiles(rootPath, since);
  if (changedFiles.length === 0) {
    return { changedFiles: [], staleNodes: 0, mysteriesCreated: 0 };
  }

  logger.info(`${changedFiles.length} files changed since ${since || "last analysis"}`);

  let staleNodes = 0;
  let mysteriesCreated = 0;

  for (const file of changedFiles) {
    // Find knowledge_nodes with citations referencing this file
    const nodes = db
      .prepare(
        `SELECT DISTINCT kn.id, kn.summary, kn.confidence
         FROM knowledge_nodes kn
         JOIN node_citations nc ON nc.node_id = kn.id
         WHERE nc.file_path LIKE ?`
      )
      .all(`%${file}%`) as Array<{ id: string; summary: string; confidence: number }>;

    for (const node of nodes) {
      // Lower confidence (mark as potentially stale)
      const newConf = Math.max(node.confidence * 0.6, 0.1);
      db.prepare(
        "UPDATE knowledge_nodes SET confidence = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newConf, node.id);
      staleNodes++;
    }

    // Find screens referencing this file
    const screens = db
      .prepare("SELECT id, name FROM screens WHERE file_path LIKE ?")
      .all(`%${file}%`) as Array<{ id: string; name: string }>;

    for (const screen of screens) {
      db.prepare("UPDATE screens SET status = 'detected' WHERE id = ?").run(screen.id);
    }

    // Find endpoints referencing this file
    const endpoints = db
      .prepare("SELECT id, method, path FROM endpoints WHERE handler_file LIKE ?")
      .all(`%${file}%`) as Array<{ id: string; method: string; path: string }>;

    for (const ep of endpoints) {
      db.prepare("UPDATE endpoints SET status = 'detected' WHERE id = ?").run(ep.id);
    }

    // Create mystery for significant changes
    if (nodes.length > 0 || screens.length > 0 || endpoints.length > 0) {
      const affectedSummary = [
        ...nodes.map((n) => `knowledge: ${n.summary}`),
        ...screens.map((s) => `screen: ${s.name}`),
        ...endpoints.map((e) => `endpoint: ${e.method} ${e.path}`),
      ].join(", ");

      db.prepare(
        `INSERT INTO mysteries (id, title, description, context, priority, specialist, source)
         VALUES (?, ?, ?, ?, ?, ?, 'analysis')`
      ).run(
        generateId(),
        `Code changed: ${file}`,
        `File ${file} was modified. Affected knowledge may be stale: ${affectedSummary}`,
        `Changed files: ${changedFiles.join(", ")}`,
        6,
        null
      );
      mysteriesCreated++;
    }
  }

  logger.info(`Stale: ${staleNodes} nodes, ${mysteriesCreated} mysteries created`);
  return { changedFiles, staleNodes, mysteriesCreated };
}

function getChangedFiles(rootPath: string, since?: string): string[] {
  try {
    const cmd = since
      ? `git diff --name-only ${since}`
      : `git diff --name-only HEAD~1`;

    const output = execSync(cmd, { cwd: rootPath, encoding: "utf-8" });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    // Not a git repo or no commits
    return [];
  }
}

/**
 * Get files changed since last analysis (using scribe.json timestamp).
 */
export function getChangesSinceAnalysis(
  db: Database.Database,
  rootPath: string
): string[] {
  try {
    const meta = db
      .prepare("SELECT analyzed_at FROM _migrations ORDER BY version DESC LIMIT 1")
      .get();
    // Use git log since analysis time
    const output = execSync(
      `git log --name-only --pretty=format: --since="1 week ago" | sort -u`,
      { cwd: rootPath, encoding: "utf-8" }
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
