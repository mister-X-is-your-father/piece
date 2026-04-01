import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cluster, FileEntry, ScribeConfig, ScribeMetadata } from "../config/schema.js";
import type { DependencyGraph } from "../analyzer/dependency-graph.js";
import { renderMarkdown, type DocFrontmatter } from "./renderer.js";

/**
 * Generate the project-level index.md — the Orchestrator's "map".
 */
export async function generateProjectOverview(
  scribePath: string,
  rootPath: string,
  files: FileEntry[],
  clusters: Cluster[],
  graph: DependencyGraph,
  config: ScribeConfig
): Promise<void> {
  const now = new Date().toISOString();

  // Build overview content
  const lines: string[] = [];
  lines.push(`# Project Overview\n`);
  lines.push(`Analyzed: ${now}\n`);
  lines.push(`Total files: ${files.length}\n`);

  // File category breakdown
  const byCategory = files.reduce(
    (acc, f) => {
      acc[f.category] = (acc[f.category] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  lines.push(`\n## File Breakdown\n`);
  for (const [cat, count] of Object.entries(byCategory)) {
    lines.push(`- ${cat}: ${count}`);
  }

  // Architecture overview
  lines.push(`\n## Architecture\n`);
  if (graph.entryPoints.length > 0) {
    lines.push(`### Entry Points`);
    for (const ep of graph.entryPoints.slice(0, 10)) {
      lines.push(`- ${ep}`);
    }
  }
  if (graph.hubs.length > 0) {
    lines.push(`\n### Core Modules (most imported)`);
    for (const hub of graph.hubs.slice(0, 10)) {
      const count = graph.importedBy.get(hub)?.size ?? 0;
      lines.push(`- ${hub} (imported by ${count} files)`);
    }
  }

  // Specialists
  lines.push(`\n## Specialists\n`);
  for (const cluster of clusters) {
    lines.push(`### [[specialists/${cluster.name}/overview|${cluster.name}]]`);
    lines.push(`- ${cluster.description}`);
    lines.push(`- Files: ${cluster.files.length}`);
    lines.push(`- Keywords: ${cluster.keywords.slice(0, 10).join(", ")}`);
    if (cluster.dependencies.length > 0) {
      lines.push(`- Depends on: ${cluster.dependencies.join(", ")}`);
    }
    lines.push("");
  }

  const frontmatter: DocFrontmatter = { type: "project_overview" };
  const content = renderMarkdown(frontmatter, lines.join("\n"));
  await writeFile(join(scribePath, "index.md"), content, "utf-8");

  // Write scribe.json metadata
  const fileHashes: Record<string, string> = {};
  for (const f of files) {
    fileHashes[f.relativePath] = f.hash;
  }

  const metadata: ScribeMetadata = {
    version: 1,
    projectPath: rootPath,
    analyzedAt: now,
    config,
    specialists: clusters.map((c) => c.name),
    fileHashes,
  };

  await writeFile(
    join(scribePath, "scribe.json"),
    JSON.stringify(metadata, null, 2),
    "utf-8"
  );
}

/**
 * Build a concise project context string for specialist analysis prompts.
 */
export function buildProjectContext(
  files: FileEntry[],
  clusters: Cluster[],
  graph: DependencyGraph
): string {
  const lines: string[] = [];
  lines.push(`Project has ${files.length} files in ${clusters.length} modules.`);
  lines.push(`\nModules: ${clusters.map((c) => c.name).join(", ")}`);

  if (graph.entryPoints.length > 0) {
    lines.push(`\nEntry points: ${graph.entryPoints.slice(0, 5).join(", ")}`);
  }
  if (graph.hubs.length > 0) {
    lines.push(`Core modules: ${graph.hubs.slice(0, 5).join(", ")}`);
  }

  return lines.join("\n");
}
