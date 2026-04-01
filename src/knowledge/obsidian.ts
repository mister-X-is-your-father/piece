/**
 * Obsidian Vault Integration
 *
 * PIECEの知識DB ↔ Obsidian Vault の双方向ブリッジ。
 *
 * 1. Export: knowledge_nodes → [[リンク]]付きマークダウン
 * 2. Import: Obsidian Vault → knowledge_nodes + node_links
 * 3. Sync: 変更検知 → 差分同期
 * 4. Graph: node_links → Obsidian Graph View互換データ
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, basename, relative, extname } from "node:path";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import { getKnowledgeDB, generateId } from "./db.js";
import { indexNodeTokens } from "./neuron.js";
import { hashContent } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import type {
  KnowledgeNode,
  NodeCitation,
  NodeLink,
} from "./schemas.js";

// --- Types ---

export interface VaultConfig {
  vaultPath: string;
  scribePath: string;
  /** フォルダ構成: specialist別 or flat */
  structure: "by-specialist" | "flat";
  /** バックリンクセクションを追加するか */
  backlinks: boolean;
  /** デイリーノートを生成するか */
  dailyNotes: boolean;
}

interface VaultNote {
  filePath: string;
  relativePath: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  wikiLinks: string[];
  tags: string[];
  hash: string;
}

// --- Export: DB → Obsidian Vault ---

export async function exportToVault(
  db: Database.Database,
  config: VaultConfig
): Promise<{ exported: number; linked: number }> {
  const vaultPath = config.vaultPath;
  await mkdir(vaultPath, { recursive: true });

  // Get all knowledge nodes
  const nodes = db
    .prepare("SELECT * FROM knowledge_nodes ORDER BY specialist, created_at")
    .all() as KnowledgeNode[];

  let exported = 0;
  let linked = 0;
  const nodeFileMap = new Map<string, string>(); // nodeId → filename (without .md)

  // Phase 1: Generate filenames
  for (const node of nodes) {
    const safeName = sanitizeForFilename(node.summary);
    nodeFileMap.set(node.id, safeName);
  }

  // Phase 2: Write files
  for (const node of nodes) {
    const fileName = nodeFileMap.get(node.id)!;
    const dir =
      config.structure === "by-specialist" && node.specialist
        ? join(vaultPath, node.specialist)
        : vaultPath;
    await mkdir(dir, { recursive: true });

    // Get citations
    const citations = db
      .prepare("SELECT * FROM node_citations WHERE node_id = ?")
      .all(node.id) as NodeCitation[];

    // Get links (outgoing)
    const links = db
      .prepare("SELECT * FROM node_links WHERE source_id = ?")
      .all(node.id) as NodeLink[];

    // Get backlinks (incoming)
    const backlinks = db
      .prepare("SELECT * FROM node_links WHERE target_id = ?")
      .all(node.id) as NodeLink[];

    // Get tags
    const tags = db
      .prepare("SELECT tag FROM node_tags WHERE node_id = ?")
      .all(node.id) as Array<{ tag: string }>;

    // Build [[wiki links]]
    const wikiLinks: string[] = [];
    let content = node.content;

    // Replace node references with [[links]]
    for (const link of links) {
      const targetName = nodeFileMap.get(link.target_id);
      if (targetName) {
        wikiLinks.push(targetName);
        linked++;
      }
    }

    // Build markdown
    const md = buildObsidianNote({
      node,
      citations,
      links,
      backlinks,
      tags: tags.map((t) => t.tag),
      nodeFileMap,
      showBacklinks: config.backlinks,
    });

    await writeFile(join(dir, `${fileName}.md`), md, "utf-8");
    exported++;
  }

  // Phase 3: Write MOC (Map of Content) — index note
  const mocContent = buildMOC(nodes, nodeFileMap, config);
  await writeFile(join(vaultPath, "MOC.md"), mocContent, "utf-8");

  // Phase 4: Daily note (today's knowledge activity)
  if (config.dailyNotes) {
    await writeDailyNote(db, vaultPath);
  }

  // Phase 5: Write .obsidian/graph.json for custom graph colors
  await writeObsidianConfig(vaultPath);

  logger.info(`Exported ${exported} notes, ${linked} links to ${vaultPath}`);
  return { exported, linked };
}

function buildObsidianNote(opts: {
  node: KnowledgeNode;
  citations: NodeCitation[];
  links: NodeLink[];
  backlinks: NodeLink[];
  tags: string[];
  nodeFileMap: Map<string, string>;
  showBacklinks: boolean;
}): string {
  const { node, citations, links, backlinks, tags, nodeFileMap, showBacklinks } = opts;

  // Frontmatter
  const fm: Record<string, unknown> = {
    piece_id: node.id,
    type: node.node_type,
    confidence: node.confidence,
    specialist: node.specialist,
    created: node.created_at,
    updated: node.updated_at,
    aliases: [node.summary],
  };

  // Tags as frontmatter
  if (tags.length > 0) {
    fm.tags = tags;
  }

  let body = `# ${node.summary}\n\n`;
  body += `${node.content}\n\n`;

  // Citations section
  if (citations.length > 0) {
    body += `## Sources\n\n`;
    for (const cit of citations) {
      const loc = cit.end_line
        ? `${cit.file_path}:L${cit.start_line}-L${cit.end_line}`
        : `${cit.file_path}:L${cit.start_line}`;
      body += `- \`${loc}\`\n`;
      if (cit.code_snippet) {
        body += `  \`\`\`\n  ${cit.code_snippet.split("\n").join("\n  ")}\n  \`\`\`\n`;
      }
    }
    body += "\n";
  }

  // Related notes (outgoing links)
  if (links.length > 0) {
    body += `## Related\n\n`;
    for (const link of links) {
      const targetName = nodeFileMap.get(link.target_id);
      if (targetName) {
        body += `- [[${targetName}]] _(${link.link_type})_\n`;
      }
    }
    body += "\n";
  }

  // Backlinks section
  if (showBacklinks && backlinks.length > 0) {
    body += `## Backlinks\n\n`;
    for (const bl of backlinks) {
      const sourceName = nodeFileMap.get(bl.source_id);
      if (sourceName) {
        body += `- [[${sourceName}]] _(${bl.link_type})_\n`;
      }
    }
    body += "\n";
  }

  // Metadata footer
  body += `---\n`;
  body += `_Confidence: ${(node.confidence * 100).toFixed(0)}% | Accessed: ${node.access_count}x | ID: ${node.id.slice(0, 8)}_\n`;

  return matter.stringify(body, fm);
}

function buildMOC(
  nodes: KnowledgeNode[],
  nodeFileMap: Map<string, string>,
  config: VaultConfig
): string {
  let md = `---\ntags: [MOC, piece]\n---\n\n`;
  md += `# PIECE Knowledge Map\n\n`;
  md += `> Precise Integrated Expert Collaboration Engine\n\n`;

  // Group by specialist
  const bySpecialist = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    const key = node.specialist || "_general";
    if (!bySpecialist.has(key)) bySpecialist.set(key, []);
    bySpecialist.get(key)!.push(node);
  }

  for (const [specialist, specNodes] of bySpecialist) {
    md += `## ${specialist === "_general" ? "General" : specialist}\n\n`;
    for (const node of specNodes) {
      const fileName = nodeFileMap.get(node.id)!;
      const confidence = (node.confidence * 100).toFixed(0);
      md += `- [[${fileName}]] _(${node.node_type}, ${confidence}%)_\n`;
    }
    md += "\n";
  }

  md += `---\n_Total: ${nodes.length} knowledge nodes_\n`;
  return md;
}

async function writeDailyNote(
  db: Database.Database,
  vaultPath: string
): Promise<void> {
  const dailyDir = join(vaultPath, "daily");
  await mkdir(dailyDir, { recursive: true });

  const today = new Date().toISOString().split("T")[0];

  // Recent activity
  const recentNodes = db
    .prepare(
      "SELECT * FROM knowledge_nodes WHERE date(created_at) = ? ORDER BY created_at DESC"
    )
    .all(today) as KnowledgeNode[];

  const recentMysteries = db
    .prepare(
      "SELECT * FROM mysteries WHERE date(created_at) = ? ORDER BY created_at DESC"
    )
    .all(today) as any[];

  let md = `---\ntags: [daily, piece]\ndate: ${today}\n---\n\n`;
  md += `# ${today}\n\n`;

  if (recentNodes.length > 0) {
    md += `## New Knowledge (${recentNodes.length})\n\n`;
    for (const node of recentNodes) {
      md += `- ${node.summary} _(${node.node_type}, ${(node.confidence * 100).toFixed(0)}%)_\n`;
    }
    md += "\n";
  }

  if (recentMysteries.length > 0) {
    md += `## New Mysteries (${recentMysteries.length})\n\n`;
    for (const m of recentMysteries) {
      md += `- ${m.title} _(${m.status}, P${m.priority})_\n`;
    }
    md += "\n";
  }

  if (recentNodes.length === 0 && recentMysteries.length === 0) {
    md += `_No activity today._\n`;
  }

  await writeFile(join(dailyDir, `${today}.md`), md, "utf-8");
}

async function writeObsidianConfig(vaultPath: string): Promise<void> {
  const configDir = join(vaultPath, ".obsidian");
  await mkdir(configDir, { recursive: true });

  // Graph color config for different node types
  const graphConfig = {
    collapse: {
      search: false,
      tags: false,
      attachments: false,
    },
    colorGroups: [
      { query: "tag:#MOC", color: { a: 1, r: 255, g: 215, b: 0 } },
      { query: "tag:#daily", color: { a: 1, r: 100, g: 200, b: 255 } },
    ],
  };

  await writeFile(
    join(configDir, "graph.json"),
    JSON.stringify(graphConfig, null, 2),
    "utf-8"
  );
}

// --- Import: Obsidian Vault → DB ---

export async function importFromVault(
  db: Database.Database,
  vaultPath: string,
  specialist?: string
): Promise<{ imported: number; links: number; skipped: number }> {
  const notes = await scanVault(vaultPath);
  let imported = 0;
  let links = 0;
  let skipped = 0;

  const titleToNodeId = new Map<string, string>();

  // Phase 1: Import notes as knowledge nodes
  for (const note of notes) {
    // Skip MOC and daily notes
    if (note.title === "MOC" || note.relativePath.startsWith("daily/")) {
      skipped++;
      continue;
    }

    // Check if already imported (by piece_id in frontmatter)
    const existingId = note.frontmatter.piece_id as string | undefined;
    if (existingId) {
      const exists = db
        .prepare("SELECT id FROM knowledge_nodes WHERE id = ?")
        .get(existingId);
      if (exists) {
        titleToNodeId.set(note.title, existingId);
        skipped++;
        continue;
      }
    }

    // Extract meaningful content (strip frontmatter, headers, metadata)
    const cleanContent = extractContent(note.content);
    if (!cleanContent.trim()) {
      skipped++;
      continue;
    }

    const nodeId = existingId || generateId();
    const nodeType = (note.frontmatter.type as string) || "explanation";
    const confidence = (note.frontmatter.confidence as number) || 0.6;

    db.prepare(
      `INSERT OR IGNORE INTO knowledge_nodes
       (id, content, summary, node_type, confidence, specialist, source_question)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nodeId,
      cleanContent,
      note.title,
      nodeType,
      confidence,
      specialist || (note.frontmatter.specialist as string) || null,
      `Imported from Obsidian: ${note.relativePath}`
    );

    // Import tags
    const allTags = [...note.tags, ...(note.frontmatter.tags as string[] || [])];
    for (const tag of new Set(allTags)) {
      db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(
        nodeId,
        tag.replace(/^#/, "")
      );
    }

    // Index for synapse search
    indexNodeTokens(db, nodeId, cleanContent, note.title, allTags);

    titleToNodeId.set(note.title, nodeId);
    imported++;
  }

  // Phase 2: Create links from [[wiki links]]
  for (const note of notes) {
    const sourceId = titleToNodeId.get(note.title);
    if (!sourceId) continue;

    for (const linkTarget of note.wikiLinks) {
      const targetId = titleToNodeId.get(linkTarget);
      if (targetId && targetId !== sourceId) {
        db.prepare(
          `INSERT OR IGNORE INTO node_links (id, source_id, target_id, link_type, description)
           VALUES (?, ?, ?, 'related', ?)`
        ).run(generateId(), sourceId, targetId, `Obsidian [[link]]`);
        links++;
      }
    }
  }

  logger.info(`Imported ${imported} notes, ${links} links, skipped ${skipped}`);
  return { imported, links, skipped };
}

async function scanVault(vaultPath: string): Promise<VaultNote[]> {
  const notes: VaultNote[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue; // skip .obsidian etc
        await walk(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const raw = await readFile(fullPath, "utf-8");
          const parsed = matter(raw);
          const relPath = relative(vaultPath, fullPath);

          // Extract [[wiki links]]
          const wikiLinks: string[] = [];
          const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
          let match;
          while ((match = linkRegex.exec(raw)) !== null) {
            wikiLinks.push(match[1]);
          }

          // Extract #tags from content
          const tagRegex = /#([\w\u3040-\u9fff]+)/g;
          const tags: string[] = [];
          while ((match = tagRegex.exec(parsed.content)) !== null) {
            tags.push(match[1]);
          }

          notes.push({
            filePath: fullPath,
            relativePath: relPath,
            title: basename(fullPath, ".md"),
            content: parsed.content,
            frontmatter: parsed.data,
            wikiLinks,
            tags,
            hash: hashContent(raw),
          });
        } catch (err) {
          logger.warn(`Failed to read ${fullPath}: ${err}`);
        }
      }
    }
  }

  await walk(vaultPath);
  return notes;
}

// --- Sync: Bidirectional ---

export interface SyncResult {
  dbToVault: number;   // DB → Vault (new/updated)
  vaultToDb: number;   // Vault → DB (new/updated)
  conflicts: number;
  unchanged: number;
}

export async function syncVault(
  db: Database.Database,
  config: VaultConfig
): Promise<SyncResult> {
  const result: SyncResult = { dbToVault: 0, vaultToDb: 0, conflicts: 0, unchanged: 0 };

  // Step 1: Import new/changed vault notes → DB
  const importResult = await importFromVault(db, config.vaultPath);
  result.vaultToDb = importResult.imported;

  // Step 2: Export new/changed DB nodes → vault
  const exportResult = await exportToVault(db, config);
  result.dbToVault = exportResult.exported;

  logger.info(
    `Sync complete: DB→Vault: ${result.dbToVault}, Vault→DB: ${result.vaultToDb}`
  );

  return result;
}

// --- Helpers ---

function sanitizeForFilename(text: string): string {
  return text
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function extractContent(markdownContent: string): string {
  // Remove headings that are metadata
  return markdownContent
    .replace(/^## Sources\n[\s\S]*?(?=^## |\n---\n|$)/m, "")
    .replace(/^## Related\n[\s\S]*?(?=^## |\n---\n|$)/m, "")
    .replace(/^## Backlinks\n[\s\S]*?(?=^## |\n---\n|$)/m, "")
    .replace(/^# .+\n/m, "")
    .replace(/^---\n_.*_\n$/m, "")
    .trim();
}
