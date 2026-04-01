#!/usr/bin/env node

import { Command } from "commander";
import { runAnalyze } from "./commands/analyze.js";
import { runAsk } from "./commands/ask.js";
import { runList } from "./commands/list.js";
import { runUpdate } from "./commands/update.js";
import { setLogLevel } from "./utils/logger.js";

const program = new Command();

program
  .name("codebase-scribe")
  .description(
    "Reliable knowledge documentation tool with multi-agent fact-checking"
  )
  .version("0.1.0");

program
  .command("analyze")
  .description("Analyze a codebase and generate specialist documentation")
  .argument("<path>", "Path to the target project")
  .option("-c, --config <path>", "Path to config file")
  .option("-o, --output <path>", "Output directory (default: .scribe)")
  .option("-v, --verbose", "Verbose logging")
  .option("--dry-run", "Estimate cost without running analysis")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runAnalyze(path, options);
  });

program
  .command("ask")
  .description(
    "Ask a question about an analyzed codebase (with fact-checking)"
  )
  .argument("<path>", "Path to the analyzed project")
  .argument("<question>", "Your question")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --docs <path>", "Path to .scribe directory")
  .option("--max-docs <n>", "Max docs in context", parseInt)
  .option("--skip-fact-check", "Skip fact checking step")
  .option("-v, --verbose", "Verbose logging")
  .action(async (path: string, question: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runAsk(path, question, options);
  });

program
  .command("specialists")
  .description("List specialists for an analyzed project")
  .argument("[path]", "Path to the analyzed project")
  .option("-v, --verbose", "Show detailed specialist info")
  .action(async (path: string | undefined, options) => {
    await runList(path, options);
  });

program
  .command("update")
  .description("Incrementally update analysis for changed files")
  .argument("<path>", "Path to the target project")
  .option("-c, --config <path>", "Path to config file")
  .option("--force", "Force full re-analysis")
  .option("-v, --verbose", "Verbose logging")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runUpdate(path, options);
  });

program.parse();
