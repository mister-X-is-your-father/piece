#!/usr/bin/env node

import { Command } from "commander";
import { runAnalyze } from "./commands/analyze.js";
import { runAsk } from "./commands/ask.js";
import { runList } from "./commands/list.js";
import { runUpdate } from "./commands/update.js";
import { runMysteries } from "./commands/mysteries.js";
import { runInvestigate } from "./agents/investigator.js";
import { runFlows } from "./agents/flow-tracer.js";
import { runKnowledge } from "./commands/knowledge.js";
import { setLogLevel } from "./utils/logger.js";
import { setBackend, type Backend } from "./claude/client.js";

const program = new Command();

program
  .name("codebase-scribe")
  .description(
    "Self-learning knowledge tool with multi-agent fact-checking"
  )
  .version("0.3.0")
  .option(
    "--backend <type>",
    "AI backend: claude-code (default, no API key) or api",
    "claude-code"
  )
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.backend) {
      setBackend(opts.backend as Backend);
    }
  });

// === Core Commands ===

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
  .description("Ask a question (checks knowledge DB first, then AI)")
  .argument("<path>", "Path to the analyzed project")
  .argument("<question>", "Your question")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --docs <path>", "Path to .scribe directory")
  .option("--max-docs <n>", "Max docs in context", parseInt)
  .option("--skip-fact-check", "Skip fact checking step")
  .option("--skip-knowledge", "Skip knowledge DB check/save")
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

// === Knowledge Brain Commands ===

program
  .command("investigate")
  .description("Autonomously investigate mysteries or explore topics")
  .argument("<path>", "Path to the analyzed project")
  .option("--mystery <id>", "Investigate a specific mystery")
  .option("--explore <topic>", "Explore a topic proactively")
  .option("--loop <n>", "Run N investigation cycles", parseInt)
  .option("-v, --verbose", "Verbose logging")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runInvestigate(path, options);
  });

program
  .command("mysteries")
  .description("View and manage open mysteries (unknowns/gaps)")
  .argument("<path>", "Path to the analyzed project")
  .option("--all", "Include resolved mysteries")
  .option("--specialist <name>", "Filter by specialist domain")
  .option("--add <title>", "Manually add a mystery")
  .option("--resolve <id>", "Mark a mystery as resolved")
  .option("-v, --verbose", "Show detailed mystery info")
  .action(async (path: string, options) => {
    await runMysteries(path, options);
  });

program
  .command("flows")
  .description("Trace and view end-to-end feature flows")
  .argument("<path>", "Path to the analyzed project")
  .option("--trace <feature>", "Trace a new E2E flow")
  .option("--show <id>", "Show a specific flow")
  .option("-v, --verbose", "Verbose output")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runFlows(path, options);
  });

program
  .command("knowledge")
  .description("Search, explore, and manage the knowledge base")
  .argument("<path>", "Path to the analyzed project")
  .option("--search <query>", "Search knowledge nodes")
  .option("--graph", "Show knowledge connection graph")
  .option("--specialist <name>", "Filter by specialist domain")
  .option("-v, --verbose", "Verbose output")
  .action(async (path: string, options) => {
    await runKnowledge(path, options);
  });

program.parse();
