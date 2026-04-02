/**
 * Multi-Project: 複数リポジトリを横断で繋げる
 *
 * フロント + バックエンド + 共通ライブラリ等を1つの知識空間で管理
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export interface ProjectLink {
  name: string;
  path: string;
  role: "frontend" | "backend" | "shared" | "service" | "other";
  scribePath: string;
}

export interface MultiProjectConfig {
  projects: ProjectLink[];
}

const CONFIG_FILE = ".piece-projects.json";

/**
 * Load multi-project config from workspace root.
 */
export async function loadMultiProjectConfig(
  workspacePath: string
): Promise<MultiProjectConfig> {
  try {
    const raw = await readFile(join(workspacePath, CONFIG_FILE), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { projects: [] };
  }
}

/**
 * Save multi-project config.
 */
export async function saveMultiProjectConfig(
  workspacePath: string,
  config: MultiProjectConfig
): Promise<void> {
  await writeFile(
    join(workspacePath, CONFIG_FILE),
    JSON.stringify(config, null, 2),
    "utf-8"
  );
}

/**
 * Add a project to multi-project workspace.
 */
export async function addProject(
  workspacePath: string,
  name: string,
  projectPath: string,
  role: ProjectLink["role"]
): Promise<void> {
  const config = await loadMultiProjectConfig(workspacePath);
  const absPath = resolve(workspacePath, projectPath);

  // Check for duplicates
  if (config.projects.some((p) => p.name === name)) {
    logger.warn(`Project "${name}" already exists, updating...`);
    config.projects = config.projects.filter((p) => p.name !== name);
  }

  config.projects.push({
    name,
    path: absPath,
    role,
    scribePath: join(absPath, ".scribe"),
  });

  await saveMultiProjectConfig(workspacePath, config);
  logger.info(`Added project "${name}" (${role}) at ${absPath}`);
}

/**
 * Search across all projects in workspace.
 */
export function crossProjectSearch(
  dbs: Map<string, Database.Database>,
  query: string
): Array<{ project: string; nodeId: string; summary: string; relevance: number }> {
  const results: Array<{ project: string; nodeId: string; summary: string; relevance: number }> = [];

  for (const [projectName, db] of dbs) {
    try {
      // Simple keyword search across projects
      const nodes = db
        .prepare(
          `SELECT id, summary, confidence FROM knowledge_nodes
           WHERE summary LIKE ? OR content LIKE ?
           ORDER BY confidence DESC LIMIT 5`
        )
        .all(`%${query}%`, `%${query}%`) as Array<{ id: string; summary: string; confidence: number }>;

      for (const node of nodes) {
        results.push({
          project: projectName,
          nodeId: node.id,
          summary: node.summary,
          relevance: node.confidence,
        });
      }
    } catch {
      // DB not available for this project
    }
  }

  return results.sort((a, b) => b.relevance - a.relevance);
}
