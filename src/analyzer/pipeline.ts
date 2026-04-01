import { resolve } from "node:path";
import type { ScribeConfig, FileEntry, FileStructure, Cluster } from "../config/schema.js";
import { discoverProjectFiles } from "./discovery.js";
import { parseFileStructure } from "./parser.js";
import { buildDependencyGraph, type DependencyGraph } from "./dependency-graph.js";
import { clusterFiles } from "./clusterer.js";
import { logger } from "../utils/logger.js";

export interface AnalysisResult {
  rootPath: string;
  files: FileEntry[];
  structures: FileStructure[];
  graph: DependencyGraph;
  clusters: Cluster[];
}

export async function runAnalysisPipeline(
  targetPath: string,
  config: ScribeConfig
): Promise<AnalysisResult> {
  const rootPath = resolve(targetPath);
  logger.info(`Starting analysis pipeline for: ${rootPath}`);

  // Phase 1: Discovery
  const files = await discoverProjectFiles(rootPath, config);
  if (files.length === 0) {
    throw new Error(`No files found in ${rootPath} matching the configured patterns`);
  }

  // Phase 2: Structure extraction
  logger.info("Extracting file structures...");
  const structures: FileStructure[] = [];
  for (const file of files) {
    if (file.category === "source" || file.category === "config") {
      try {
        const structure = await parseFileStructure(file.path, file.relativePath);
        structures.push(structure);
      } catch (err) {
        logger.warn(`Failed to parse ${file.relativePath}: ${err}`);
      }
    }
  }
  logger.info(`Extracted structures from ${structures.length} files`);

  // Phase 3: Dependency graph
  logger.info("Building dependency graph...");
  const allFiles = new Set(files.map((f) => f.relativePath));
  const graph = buildDependencyGraph(structures, allFiles);
  logger.info(
    `Dependency graph: ${graph.entryPoints.length} entry points, ${graph.hubs.length} hubs`
  );

  // Phase 4: Clustering
  logger.info("Clustering files into specialist domains...");
  const clusters = clusterFiles(files, structures, graph, config);

  logger.info(`Analysis pipeline complete: ${clusters.length} clusters created`);

  return { rootPath, files, structures, graph, clusters };
}
