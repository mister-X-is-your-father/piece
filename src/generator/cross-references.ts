import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cluster, GlobalIndex } from "../config/schema.js";
import type { DependencyGraph } from "../analyzer/dependency-graph.js";
import { renderMarkdown, type DocFrontmatter } from "./renderer.js";

/**
 * Generate cross-references.md and _global-index.json.
 */
export async function generateCrossReferences(
  scribePath: string,
  clusters: Cluster[],
  graph: DependencyGraph
): Promise<void> {
  // Build cross-references.md
  const lines: string[] = [];
  lines.push(`# Cross References\n`);
  lines.push(`Shows how specialist domains depend on each other.\n`);

  for (const cluster of clusters) {
    lines.push(`## ${cluster.name}`);

    // Outgoing dependencies
    if (cluster.dependencies.length > 0) {
      lines.push(`\n**Depends on:**`);
      for (const dep of cluster.dependencies) {
        lines.push(`- [[specialists/${dep}/overview|${dep}]]`);
      }
    }

    // Incoming dependencies
    const dependedOnBy = clusters.filter((c) =>
      c.dependencies.includes(cluster.name)
    );
    if (dependedOnBy.length > 0) {
      lines.push(`\n**Used by:**`);
      for (const dep of dependedOnBy) {
        lines.push(`- [[specialists/${dep.name}/overview|${dep.name}]]`);
      }
    }

    // File-level cross-module imports
    const crossImports = new Map<string, string[]>();
    for (const file of cluster.files) {
      const imports = graph.imports.get(file);
      if (!imports) continue;
      for (const imp of imports) {
        if (!cluster.files.includes(imp)) {
          if (!crossImports.has(imp)) crossImports.set(imp, []);
          crossImports.get(imp)!.push(file);
        }
      }
    }

    if (crossImports.size > 0) {
      lines.push(`\n**External imports:**`);
      for (const [target, sources] of crossImports) {
        lines.push(`- ${target} (from: ${sources.join(", ")})`);
      }
    }

    lines.push("");
  }

  const frontmatter: DocFrontmatter = { type: "cross_references" };
  const content = renderMarkdown(frontmatter, lines.join("\n"));
  await writeFile(join(scribePath, "cross-references.md"), content, "utf-8");

  // Build _global-index.json for Orchestrator routing
  const globalIndex: GlobalIndex = {
    keywords: {},
    files: {},
    specialists: {},
  };

  for (const cluster of clusters) {
    // Specialist index entry
    globalIndex.specialists[cluster.name] = {
      description: cluster.description,
      keywords: cluster.keywords,
      files: cluster.files,
    };

    // Keywords -> specialist mapping
    for (const kw of cluster.keywords) {
      if (!globalIndex.keywords[kw]) globalIndex.keywords[kw] = [];
      globalIndex.keywords[kw].push(cluster.name);
    }

    // File -> specialist mapping
    for (const file of cluster.files) {
      globalIndex.files[file] = cluster.name;
    }
  }

  await writeFile(
    join(scribePath, "_global-index.json"),
    JSON.stringify(globalIndex, null, 2),
    "utf-8"
  );
}
