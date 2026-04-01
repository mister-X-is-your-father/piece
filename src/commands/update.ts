import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { discoverProjectFiles } from "../analyzer/discovery.js";
import { analyzeAllClusters } from "../agents/specialist.js";
import { generateSpecialistDocs } from "../generator/specialist-doc.js";
import { generateCrossReferences } from "../generator/cross-references.js";
import { buildProjectContext, generateProjectOverview } from "../generator/project-overview.js";
import { runAnalysisPipeline } from "../analyzer/pipeline.js";
import type { ScribeMetadata } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface UpdateOptions {
  config?: string;
  force?: boolean;
  verbose?: boolean;
}

export async function runUpdate(
  targetPath: string,
  options: UpdateOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath, options.config);
  const scribePath = resolve(rootPath, config.output.directory);

  // Load existing metadata
  let existingMeta: ScribeMetadata;
  try {
    const raw = await readFile(join(scribePath, "scribe.json"), "utf-8");
    existingMeta = JSON.parse(raw);
  } catch {
    console.log(
      chalk.yellow("No existing analysis found. Running full analysis...")
    );
    // Import and run full analyze
    const { runAnalyze } = await import("./analyze.js");
    await runAnalyze(targetPath, { verbose: options.verbose });
    return;
  }

  // Discover current files and compare hashes
  const spinner = ora("Checking for changes...").start();

  const currentFiles = await discoverProjectFiles(rootPath, config);
  const changedFiles: string[] = [];
  const newFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const file of currentFiles) {
    const oldHash = existingMeta.fileHashes[file.relativePath];
    if (!oldHash) {
      newFiles.push(file.relativePath);
    } else if (oldHash !== file.hash) {
      changedFiles.push(file.relativePath);
    }
  }

  const currentPaths = new Set(currentFiles.map((f) => f.relativePath));
  for (const oldPath of Object.keys(existingMeta.fileHashes)) {
    if (!currentPaths.has(oldPath)) {
      deletedFiles.push(oldPath);
    }
  }

  if (
    !options.force &&
    changedFiles.length === 0 &&
    newFiles.length === 0 &&
    deletedFiles.length === 0
  ) {
    spinner.succeed("No changes detected");
    return;
  }

  spinner.succeed(
    `Changes: ${changedFiles.length} modified, ${newFiles.length} new, ${deletedFiles.length} deleted`
  );

  // Find affected specialists
  const affectedFiles = [...changedFiles, ...newFiles];
  const affectedSpecialists = new Set<string>();

  try {
    const indexRaw = await readFile(
      join(scribePath, "_global-index.json"),
      "utf-8"
    );
    const index = JSON.parse(indexRaw);

    for (const file of affectedFiles) {
      const specialist = index.files?.[file];
      if (specialist) {
        affectedSpecialists.add(specialist);
      }
    }
  } catch {
    // Can't determine affected specialists, re-analyze all
    logger.warn("Could not determine affected specialists, running full re-analysis");
  }

  if (options.force || affectedSpecialists.size === 0) {
    console.log(chalk.yellow("Running full re-analysis..."));
    const { runAnalyze } = await import("./analyze.js");
    await runAnalyze(targetPath, { verbose: options.verbose });
    return;
  }

  // Re-analyze only affected specialists
  console.log(
    chalk.cyan(
      `Re-analyzing ${affectedSpecialists.size} specialists: ${[...affectedSpecialists].join(", ")}`
    )
  );

  const analysis = await runAnalysisPipeline(rootPath, config);
  const affectedClusters = analysis.clusters.filter((c) =>
    affectedSpecialists.has(c.name)
  );

  const projectContext = buildProjectContext(
    analysis.files,
    analysis.clusters,
    analysis.graph
  );

  const spinner2 = ora("Re-analyzing affected specialists...").start();
  const clusterAnalyses = await analyzeAllClusters(
    rootPath,
    affectedClusters,
    projectContext,
    config
  );

  for (const cluster of affectedClusters) {
    const content = clusterAnalyses.get(cluster.name) || "";
    await generateSpecialistDocs(scribePath, cluster, content, analysis.files);
  }

  // Regenerate cross-references and overview
  await generateProjectOverview(
    scribePath,
    rootPath,
    analysis.files,
    analysis.clusters,
    analysis.graph,
    config
  );
  await generateCrossReferences(scribePath, analysis.clusters, analysis.graph);

  spinner2.succeed("Incremental update complete");
}
