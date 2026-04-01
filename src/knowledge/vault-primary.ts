/**
 * Vault-Primary Architecture
 *
 * Markdown = source of truth
 * SQLite = derived index (rebuildable)
 *
 * Write: always to .md first → auto-index to SQLite
 * Read: SQLite for Synapse search, .md for direct access
 * Sync: hash comparison, reindex changed files only
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import { getKnowledgeDB, generateId } from "./db.js";
import { indexNodeTokens, learnConceptLink } from "./synapse.js";
import { hashContent } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import type { KnowledgeNodeInsert } from "./schemas.js";

// --- Types ---

interface HashIndex {
  [relativePath: string]: { hash: string; nodeId: string };
}

// --- Core: Write knowledge as .md, index to SQLite ---

/**
 * Write a knowledge node to vault (.md) and index to SQLite.
 * This is the PRIMARY write path. All knowledge goes through here.
 */
export async function writeKnowledge(
  db: Database.Database,
  vaultPath: string,
  input: KnowledgeNodeInsert & { citations?: Array<{ file_path: string; start_line?: number; end_line?: number; code_snippet?: string }> }
): Promise<{ nodeId: string; filePath: string }> {
  const nodeId = generateId();
  const specialist = input.specialist ?? "_general";
  const dir = join(vaultPath, specialist);
  await mkdir(dir, { recursive: true });

  const fileName = sanitize(input.summary) + ".md";
  const filePath = join(dir, fileName);
  const relativePath = join(specialist, fileName);

  // Build markdown
  const tags = input.tags ?? [];
  const fm: Record<string, unknown> = {
    piece_id: nodeId,
    type: input.node_type,
    confidence: input.confidence ?? 0.5,
    specialist: input.specialist ?? null,
    source_question: input.source_question ?? null,
    tags,
    created: new Date().toISOString(),
  };

  let body = `# ${input.summary}\n\n${input.content}\n`;

  // Citations
  if (input.citations && input.citations.length > 0) {
    body += `\n## Sources\n\n`;
    for (const cit of input.citations) {
      const loc = cit.end_line
        ? `${cit.file_path}:L${cit.start_line}-L${cit.end_line}`
        : `${cit.file_path}:L${cit.start_line}`;
      body += `- \`${loc}\`\n`;
      if (cit.code_snippet) {
        body += `  \`\`\`\n  ${cit.code_snippet}\n  \`\`\`\n`;
      }
    }
  }

  const md = matter.stringify(body, fm);

  // Write .md file
  await writeFile(filePath, md, "utf-8");

  // Index to SQLite
  indexToSqlite(db, nodeId, input, tags);

  // Index citations
  if (input.citations) {
    for (const cit of input.citations) {
      db.prepare(
        `INSERT INTO node_citations (id, node_id, file_path, start_line, end_line, code_snippet)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(generateId(), nodeId, cit.file_path, cit.start_line ?? null, cit.end_line ?? null, cit.code_snippet ?? null);
    }
  }

  // Update hash index
  const hash = hashContent(md);
  await updateHashIndex(vaultPath, relativePath, hash, nodeId);

  return { nodeId, filePath };
}

function indexToSqlite(
  db: Database.Database,
  nodeId: string,
  input: KnowledgeNodeInsert,
  tags: string[]
): void {
  db.prepare(
    `INSERT OR REPLACE INTO knowledge_nodes
     (id, content, summary, node_type, confidence, specialist, source_question)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nodeId,
    input.content,
    input.summary,
    input.node_type,
    input.confidence ?? 0.5,
    input.specialist ?? null,
    input.source_question ?? null
  );

  // Tags
  for (const tag of tags) {
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nodeId, tag);
  }

  // N-gram token index for Synapse search
  indexNodeTokens(db, nodeId, input.content, input.summary, tags);
}

// --- Sync: detect changes, reindex ---

/**
 * Check vault for changes and reindex modified files.
 * Fast: only processes files whose hash has changed.
 */
export async function syncVaultToIndex(
  db: Database.Database,
  vaultPath: string
): Promise<{ reindexed: number; added: number; removed: number }> {
  const hashIndex = await loadHashIndex(vaultPath);
  const currentFiles = await scanMdFiles(vaultPath);

  let reindexed = 0;
  let added = 0;
  let removed = 0;

  // Check each current file
  for (const { relativePath, content, hash } of currentFiles) {
    const existing = hashIndex[relativePath];

    if (!existing) {
      // New file — import
      const nodeId = await importMdFile(db, vaultPath, relativePath, content);
      hashIndex[relativePath] = { hash, nodeId };
      added++;
    } else if (existing.hash !== hash) {
      // Changed — reindex
      await reindexMdFile(db, existing.nodeId, content);
      hashIndex[relativePath] = { hash, nodeId: existing.nodeId };
      reindexed++;
    }
    // Unchanged — skip
  }

  // Check for deleted files
  const currentPaths = new Set(currentFiles.map((f) => f.relativePath));
  for (const [path, entry] of Object.entries(hashIndex)) {
    if (!currentPaths.has(path)) {
      db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(entry.nodeId);
      delete hashIndex[path];
      removed++;
    }
  }

  await saveHashIndex(vaultPath, hashIndex);

  if (reindexed + added + removed > 0) {
    logger.info(`Vault sync: ${added} added, ${reindexed} reindexed, ${removed} removed`);
  }

  return { reindexed, added, removed };
}

/**
 * Full rebuild: delete SQLite knowledge data, reimport all .md files.
 */
export async function fullReindex(
  db: Database.Database,
  vaultPath: string
): Promise<number> {
  // Clear knowledge tables
  db.prepare("DELETE FROM node_citations").run();
  db.prepare("DELETE FROM node_tags").run();
  db.prepare("DELETE FROM node_tokens").run();
  db.prepare("DELETE FROM knowledge_nodes").run();

  const files = await scanMdFiles(vaultPath);
  const hashIndex: HashIndex = {};

  for (const { relativePath, content, hash } of files) {
    const nodeId = await importMdFile(db, vaultPath, relativePath, content);
    hashIndex[relativePath] = { hash, nodeId };
  }

  await saveHashIndex(vaultPath, hashIndex);
  logger.info(`Full reindex: ${files.length} files`);
  return files.length;
}

// --- Internal ---

async function importMdFile(
  db: Database.Database,
  vaultPath: string,
  relativePath: string,
  content: string
): Promise<string> {
  const parsed = matter(content);
  const nodeId = (parsed.data.piece_id as string) || generateId();
  const title = basename(relativePath, ".md");

  const cleanContent = parsed.content
    .replace(/^# .+\n/m, "")
    .replace(/^## Sources\n[\s\S]*?(?=^## |\n$)/m, "")
    .trim();

  const tags = (parsed.data.tags as string[]) || [];

  indexToSqlite(db, nodeId, {
    content: cleanContent,
    summary: title,
    node_type: (parsed.data.type as any) || "explanation",
    confidence: (parsed.data.confidence as number) || 0.6,
    specialist: (parsed.data.specialist as string) || null,
    source_question: (parsed.data.source_question as string) || null,
    tags,
  }, tags);

  // Extract [[wiki links]] → node_links (deferred, need second pass)
  const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    // Store as tag for now; links resolved in second pass
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)")
      .run(nodeId, `link:${match[1]}`);
  }

  return nodeId;
}

async function reindexMdFile(
  db: Database.Database,
  nodeId: string,
  content: string
): Promise<void> {
  const parsed = matter(content);
  const title = parsed.data.aliases?.[0] || "untitled";

  const cleanContent = parsed.content
    .replace(/^# .+\n/m, "")
    .replace(/^## Sources\n[\s\S]*?(?=^## |\n$)/m, "")
    .trim();

  const tags = (parsed.data.tags as string[]) || [];

  db.prepare(
    `UPDATE knowledge_nodes
     SET content = ?, summary = ?, confidence = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(cleanContent, title, (parsed.data.confidence as number) || 0.6, nodeId);

  // Re-index tokens
  indexNodeTokens(db, nodeId, cleanContent, title, tags);
}

async function scanMdFiles(
  vaultPath: string
): Promise<Array<{ relativePath: string; content: string; hash: string }>> {
  const { default: fg } = await import("fast-glob");
  const files = await fg("**/*.md", {
    cwd: vaultPath,
    ignore: [".obsidian/**", "daily/**"],
    absolute: false,
  });

  const results: Array<{ relativePath: string; content: string; hash: string }> = [];
  for (const relPath of files) {
    const content = await readFile(join(vaultPath, relPath), "utf-8");
    results.push({ relativePath: relPath, content, hash: hashContent(content) });
  }
  return results;
}

// --- Hash Index ---

async function loadHashIndex(vaultPath: string): Promise<HashIndex> {
  try {
    const raw = await readFile(join(vaultPath, ".hashes.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveHashIndex(vaultPath: string, index: HashIndex): Promise<void> {
  await writeFile(join(vaultPath, ".hashes.json"), JSON.stringify(index, null, 2), "utf-8");
}

async function updateHashIndex(
  vaultPath: string,
  relativePath: string,
  hash: string,
  nodeId: string
): Promise<void> {
  const index = await loadHashIndex(vaultPath);
  index[relativePath] = { hash, nodeId };
  await saveHashIndex(vaultPath, index);
}

function sanitize(text: string): string {
  return text
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
