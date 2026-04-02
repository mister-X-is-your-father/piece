/**
 * Git Intelligence: git履歴から「なぜこう変わった？」を知識化
 *
 * git log/blame → commit意図の推論 → knowledge_nodesに蓄積
 */

import { execSync } from "node:child_process";
import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { indexNodeTokens } from "./neuron.js";
import { logger } from "../utils/logger.js";

export interface GitCommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: string[];
}

export interface GitBlameInfo {
  file: string;
  line: number;
  author: string;
  date: string;
  commit: string;
}

/**
 * Extract recent git commits and store as knowledge.
 */
export function ingestGitHistory(
  db: Database.Database,
  rootPath: string,
  limit: number = 50
): number {
  const commits = getRecentCommits(rootPath, limit);
  let created = 0;

  for (const commit of commits) {
    // Skip if already ingested
    const existing = db
      .prepare("SELECT id FROM knowledge_nodes WHERE source_question = ?")
      .get(`git:${commit.hash}`);
    if (existing) continue;

    // Create knowledge node from commit
    const summary = `Git: ${commit.message.split("\n")[0].slice(0, 80)}`;
    const content = [
      `Commit: ${commit.hash}`,
      `Author: ${commit.author}`,
      `Date: ${commit.date}`,
      `Message: ${commit.message}`,
      `Files changed: ${commit.files.join(", ")}`,
    ].join("\n");

    const nodeId = generateId();
    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, specialist, source_question)
       VALUES (?, ?, ?, 'fact', 0.9, null, ?)`
    ).run(nodeId, content, summary, `git:${commit.hash}`);

    // Tags
    const tags = ["git", "commit", ...extractTagsFromMessage(commit.message)];
    for (const tag of tags) {
      db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nodeId, tag.toLowerCase());
    }

    // Citations (link to changed files)
    for (const file of commit.files) {
      db.prepare(
        "INSERT INTO node_citations (id, node_id, file_path) VALUES (?, ?, ?)"
      ).run(generateId(), nodeId, file);
    }

    // Token index
    indexNodeTokens(db, nodeId, content, summary, tags);
    created++;
  }

  logger.info(`Ingested ${created} git commits as knowledge`);
  return created;
}

/**
 * Get blame information for a specific file and line range.
 */
export function getBlameInfo(
  rootPath: string,
  filePath: string,
  startLine?: number,
  endLine?: number
): GitBlameInfo[] {
  try {
    const lineRange = startLine && endLine ? `-L ${startLine},${endLine}` : "";
    const output = execSync(
      `git blame --porcelain ${lineRange} "${filePath}"`,
      { cwd: rootPath, encoding: "utf-8" }
    );

    const results: GitBlameInfo[] = [];
    const blocks = output.split(/^([0-9a-f]{40})/m).filter(Boolean);

    for (let i = 0; i < blocks.length - 1; i += 2) {
      const hash = blocks[i];
      const meta = blocks[i + 1];
      const authorMatch = meta.match(/^author (.+)$/m);
      const dateMatch = meta.match(/^author-time (\d+)$/m);
      const lineMatch = meta.match(/^(\d+) (\d+)/);

      if (authorMatch && lineMatch) {
        results.push({
          file: filePath,
          line: parseInt(lineMatch[2]),
          author: authorMatch[1],
          date: dateMatch ? new Date(parseInt(dateMatch[1]) * 1000).toISOString() : "",
          commit: hash,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function getRecentCommits(rootPath: string, limit: number): GitCommitInfo[] {
  try {
    const output = execSync(
      `git log --pretty=format:'%H|||%an|||%aI|||%s' --name-only -${limit}`,
      { cwd: rootPath, encoding: "utf-8" }
    );

    const commits: GitCommitInfo[] = [];
    const entries = output.split("\n\n").filter(Boolean);

    for (const entry of entries) {
      const lines = entry.trim().split("\n");
      if (lines.length === 0) continue;

      const parts = lines[0].split("|||");
      if (parts.length < 4) continue;

      commits.push({
        hash: parts[0].replace(/^'/, ""),
        author: parts[1],
        date: parts[2],
        message: parts[3].replace(/'$/, ""),
        files: lines.slice(1).filter(Boolean),
      });
    }

    return commits;
  } catch {
    return [];
  }
}

function extractTagsFromMessage(message: string): string[] {
  const tags: string[] = [];
  const lower = message.toLowerCase();

  if (lower.includes("fix") || lower.includes("bug")) tags.push("bugfix");
  if (lower.includes("feat") || lower.includes("add")) tags.push("feature");
  if (lower.includes("refactor")) tags.push("refactor");
  if (lower.includes("test")) tags.push("test");
  if (lower.includes("doc")) tags.push("docs");
  if (lower.includes("auth")) tags.push("auth");
  if (lower.includes("api")) tags.push("api");
  if (lower.includes("ui") || lower.includes("component")) tags.push("ui");
  if (lower.includes("db") || lower.includes("migration")) tags.push("database");

  return tags;
}
