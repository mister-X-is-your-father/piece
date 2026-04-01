import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { runAnalysisPipeline } from "../analyzer/pipeline.js";
import { analyzeAllClusters } from "../agents/specialist.js";
import { generateSpecialistDocs } from "../generator/specialist-doc.js";
import {
  generateProjectOverview,
  buildProjectContext,
} from "../generator/project-overview.js";
import { generateCrossReferences } from "../generator/cross-references.js";
import { logger } from "../utils/logger.js";

export interface AnalyzeOptions {
  config?: string;
  output?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

export async function runAnalyze(
  targetPath: string,
  options: AnalyzeOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath, options.config);

  if (options.output) {
    config.output.directory = options.output;
  }

  const scribePath = resolve(rootPath, config.output.directory);

  // Phase 1-4: Analysis pipeline (discovery, parsing, dependency graph, clustering)
  const spinner = ora("Analyzing project structure...").start();

  let analysis;
  try {
    analysis = await runAnalysisPipeline(rootPath, config);
    spinner.succeed(
      `Found ${analysis.files.length} files, ${analysis.clusters.length} specialist domains`
    );
  } catch (err) {
    spinner.fail(`Analysis failed: ${err}`);
    throw err;
  }

  // Dry run: show cost estimate and exit
  if (options.dryRun) {
    console.log(chalk.yellow("\n--- Dry Run Estimate ---"));
    console.log(`Files to analyze: ${analysis.files.length}`);
    console.log(`Specialists to create: ${analysis.clusters.length}`);
    console.log(`\nClusters:`);
    for (const cluster of analysis.clusters) {
      console.log(`  ${cluster.name}: ${cluster.files.length} files`);
    }
    const estimatedCalls =
      analysis.clusters.length + // specialist analysis
      1 + // project overview context
      1; // cross-reference
    console.log(`\nEstimated API calls: ~${estimatedCalls}`);
    console.log(
      `Estimated cost: ~$${(estimatedCalls * 0.05).toFixed(2)} (rough estimate)`
    );
    return;
  }

  // Create output directory
  await mkdir(scribePath, { recursive: true });

  // Phase 5: Deep analysis with specialist agents
  const spinner2 = ora(
    `Running ${analysis.clusters.length} specialist analyses...`
  ).start();

  const projectContext = buildProjectContext(
    analysis.files,
    analysis.clusters,
    analysis.graph
  );

  let clusterAnalyses;
  try {
    clusterAnalyses = await analyzeAllClusters(
      rootPath,
      analysis.clusters,
      projectContext,
      config
    );
    spinner2.succeed("Specialist analyses complete");
  } catch (err) {
    spinner2.fail(`Specialist analysis failed: ${err}`);
    throw err;
  }

  // Phase 6: Generate documentation
  const spinner3 = ora("Generating documentation...").start();

  try {
    // Generate specialist docs in parallel
    const docPromises = analysis.clusters.map((cluster) => {
      const analysisContent = clusterAnalyses.get(cluster.name) || "";
      return generateSpecialistDocs(
        scribePath,
        cluster,
        analysisContent,
        analysis.files
      );
    });
    await Promise.all(docPromises);

    // Generate project overview
    await generateProjectOverview(
      scribePath,
      rootPath,
      analysis.files,
      analysis.clusters,
      analysis.graph,
      config
    );

    // Generate cross-references and global index
    await generateCrossReferences(
      scribePath,
      analysis.clusters,
      analysis.graph
    );

    spinner3.succeed("Documentation generated");
  } catch (err) {
    spinner3.fail(`Documentation generation failed: ${err}`);
    throw err;
  }

  // Summary
  console.log(chalk.green("\n=== Analysis Complete ==="));
  console.log(`Output: ${scribePath}`);
  console.log(`Specialists: ${analysis.clusters.length}`);
  for (const cluster of analysis.clusters) {
    console.log(
      `  ${chalk.cyan(cluster.name)}: ${cluster.files.length} files — ${cluster.description}`
    );
  }
  console.log(`\nRun ${chalk.cyan(`codebase-scribe ask ${targetPath} "your question"`)} to query`);
}
