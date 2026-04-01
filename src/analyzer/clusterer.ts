import { dirname } from "node:path";
import type { Cluster, FileEntry, FileStructure, ScribeConfig } from "../config/schema.js";
import type { DependencyGraph } from "./dependency-graph.js";
import { logger } from "../utils/logger.js";

/**
 * Groups files into functional clusters for Specialist assignment.
 *
 * Strategy priority:
 * 1. Feature-based (from app-map): ビジネスドメイン単位（認証、freee連携、etc.）
 * 2. Directory-based (fallback): ディレクトリ構造単位
 *
 * Feature-based clustering produces specialists like:
 *   "認証・ログイン specialist" instead of "src-auth specialist"
 */
/**
 * Cluster from app-map features (business domain).
 * Each feature becomes a specialist.
 */
export function clusterByFeatures(
  files: FileEntry[],
  featureFileMap: Map<string, { name: string; description: string; files: string[] }>,
  config: ScribeConfig
): Cluster[] {
  const clusters: Cluster[] = [];
  const assignedFiles = new Set<string>();

  for (const [, feature] of featureFileMap) {
    const featureFiles = feature.files.filter((f) =>
      files.some((fe) => fe.relativePath === f)
    );

    if (featureFiles.length >= (config.clustering.minFilesPerSpecialist || 1)) {
      clusters.push({
        name: feature.name,
        description: feature.description,
        files: featureFiles,
        keywords: [feature.name.toLowerCase()],
        dependencies: [],
      });
      for (const f of featureFiles) assignedFiles.add(f);
    }
  }

  // Unassigned files go to "_other" cluster
  const unassigned = files
    .filter((f) => f.category === "source" && !assignedFiles.has(f.relativePath))
    .map((f) => f.relativePath);

  if (unassigned.length > 0) {
    clusters.push({
      name: "_other",
      description: "Unassigned files",
      files: unassigned,
      keywords: [],
      dependencies: [],
    });
  }

  logger.info(`Feature-based clustering: ${clusters.length} specialists`);
  return clusters;
}

export function clusterFiles(
  files: FileEntry[],
  structures: FileStructure[],
  graph: DependencyGraph,
  config: ScribeConfig
): Cluster[] {
  const { minFilesPerSpecialist, maxFilesPerSpecialist } = config.clustering;

  // Step 1: Group by directory
  const dirGroups = groupByDirectory(files);

  // Step 2: Merge small groups with their most-connected neighbor
  let clusters = mergeSmallGroups(dirGroups, graph, minFilesPerSpecialist);

  // Step 3: Split large groups
  clusters = splitLargeGroups(clusters, maxFilesPerSpecialist);

  // Step 4: Enrich with metadata
  const enriched = enrichClusters(clusters, structures, graph);

  // Step 5: Cap total specialists
  const capped = capSpecialists(enriched, config.agents.maxSpecialists);

  logger.info(`Created ${capped.length} specialist clusters`);
  for (const c of capped) {
    logger.debug(`  ${c.name}: ${c.files.length} files`);
  }

  return capped;
}

function groupByDirectory(files: FileEntry[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    if (file.category === "other") continue;

    // Use first two directory levels as group key
    const parts = dirname(file.relativePath).split("/");
    const key = parts.slice(0, 2).join("/") || "_root";

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(file.relativePath);
  }

  return groups;
}

function mergeSmallGroups(
  dirGroups: Map<string, string[]>,
  graph: DependencyGraph,
  minFiles: number
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  // First pass: keep groups that meet minimum
  const small: [string, string[]][] = [];
  for (const [key, files] of dirGroups) {
    if (files.length >= minFiles) {
      result.set(key, files);
    } else {
      small.push([key, files]);
    }
  }

  // Second pass: merge small groups into nearest large group by dependency
  for (const [key, files] of small) {
    let bestTarget: string | null = null;
    let bestScore = -1;

    for (const [targetKey, targetFiles] of result) {
      let score = 0;
      for (const f of files) {
        const imports = graph.imports.get(f);
        const importedBy = graph.importedBy.get(f);
        for (const tf of targetFiles) {
          if (imports?.has(tf)) score++;
          if (importedBy?.has(tf)) score++;
        }
      }
      // Also consider directory proximity
      if (key.startsWith(targetKey.split("/")[0])) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = targetKey;
      }
    }

    if (bestTarget) {
      result.get(bestTarget)!.push(...files);
    } else {
      // No good merge target, keep as standalone
      result.set(key, files);
    }
  }

  return result;
}

function splitLargeGroups(
  groups: Map<string, string[]>,
  maxFiles: number
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const [key, files] of groups) {
    if (files.length <= maxFiles) {
      result.set(key, files);
    } else {
      // Split into sub-groups by deeper directory
      const subGroups = new Map<string, string[]>();
      for (const f of files) {
        const parts = f.split("/");
        const subKey = parts.length > 2 ? parts.slice(0, 3).join("/") : key;
        if (!subGroups.has(subKey)) subGroups.set(subKey, []);
        subGroups.get(subKey)!.push(f);
      }

      if (subGroups.size > 1) {
        for (const [sk, sf] of subGroups) {
          result.set(sk, sf);
        }
      } else {
        // Can't split further by directory, just chunk
        const chunks = chunkArray(files, maxFiles);
        chunks.forEach((chunk, i) => {
          result.set(`${key}_part${i + 1}`, chunk);
        });
      }
    }
  }

  return result;
}

function enrichClusters(
  groups: Map<string, string[]>,
  structures: FileStructure[],
  graph: DependencyGraph
): Cluster[] {
  const structureMap = new Map(structures.map((s) => [s.path, s]));

  return [...groups.entries()].map(([dirKey, files]) => {
    // Extract keywords from function/export names
    const keywords = new Set<string>();
    const deps = new Set<string>();

    for (const f of files) {
      const structure = structureMap.get(f);
      if (structure) {
        for (const exp of structure.exports) {
          keywords.add(exp.name.toLowerCase());
        }
        for (const fn of structure.functions) {
          keywords.add(fn.name.toLowerCase());
        }
      }

      // Find cross-cluster dependencies
      const imports = graph.imports.get(f);
      if (imports) {
        for (const imp of imports) {
          if (!files.includes(imp)) {
            // Find which cluster the imported file belongs to
            for (const [otherKey, otherFiles] of groups) {
              if (otherKey !== dirKey && otherFiles.includes(imp)) {
                deps.add(otherKey);
              }
            }
          }
        }
      }
    }

    // Generate name from directory key
    const name = dirKey.replace(/\//g, "-").replace(/^_/, "");

    return {
      name,
      description: `Module: ${dirKey}`,
      files,
      keywords: [...keywords].slice(0, 30),
      dependencies: [...deps],
    };
  });
}

function capSpecialists(clusters: Cluster[], max: number): Cluster[] {
  if (clusters.length <= max) return clusters;

  // Sort by file count descending, merge smallest into nearest
  const sorted = [...clusters].sort((a, b) => b.files.length - a.files.length);
  const kept = sorted.slice(0, max - 1);
  const merged = sorted.slice(max - 1);

  // Merge all excess into an "other" cluster
  const otherFiles = merged.flatMap((c) => c.files);
  const otherKeywords = [...new Set(merged.flatMap((c) => c.keywords))];
  kept.push({
    name: "other",
    description: "Remaining modules merged together",
    files: otherFiles,
    keywords: otherKeywords.slice(0, 30),
    dependencies: [],
  });

  return kept;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
