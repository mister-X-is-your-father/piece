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
import { runVaultExport, runVaultImport, runVaultSync } from "./commands/vault.js";
import { setLogLevel } from "./utils/logger.js";
import { setBackend, type Backend } from "./claude/client.js";

const program = new Command();

program
  .name("piece")
  .description(
    "PIECE — Precise Integrated Expert Collaboration Engine"
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

program
  .command("reindex")
  .description("Rebuild SQLite index from vault markdown files")
  .argument("<path>", "Path to the project")
  .option("-v, --verbose", "Verbose output")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    const { resolve } = await import("node:path");
    const { loadConfig } = await import("./config/loader.js");
    const { getKnowledgeDB, closeKnowledgeDB } = await import("./knowledge/db.js");
    const { fullReindex } = await import("./knowledge/vault-primary.js");
    const rootPath = resolve(path);
    const config = await loadConfig(rootPath);
    const scribePath = resolve(rootPath, config.output.directory);
    const vaultPath = resolve(scribePath, "vault");
    const db = getKnowledgeDB(scribePath);
    const count = await fullReindex(db, vaultPath);
    console.log(`Reindexed ${count} files from ${vaultPath}`);
    closeKnowledgeDB();
  });

// === Obsidian Vault Integration ===

const vault = program.command("vault").description("Obsidian vault integration");

vault
  .command("export")
  .description("Export knowledge DB → Obsidian vault")
  .argument("<path>", "Path to the analyzed project")
  .option("-o, --output <path>", "Vault output path (default: .scribe/vault)")
  .option("--flat", "Flat structure (no specialist folders)")
  .option("--no-backlinks", "Skip backlinks section")
  .option("--no-daily-notes", "Skip daily notes")
  .option("-v, --verbose", "Verbose output")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runVaultExport(path, options);
  });

vault
  .command("import")
  .description("Import Obsidian vault → knowledge DB")
  .argument("<path>", "Path to the analyzed project")
  .argument("<vault>", "Path to Obsidian vault to import")
  .option("--specialist <name>", "Assign imported notes to specialist")
  .option("-v, --verbose", "Verbose output")
  .action(async (path: string, vaultPath: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runVaultImport(path, vaultPath, options);
  });

vault
  .command("sync")
  .description("Bidirectional sync: knowledge DB ↔ Obsidian vault")
  .argument("<path>", "Path to the analyzed project")
  .option("-o, --output <path>", "Vault path (default: .scribe/vault)")
  .option("--flat", "Flat structure")
  .option("-v, --verbose", "Verbose output")
  .action(async (path: string, options) => {
    if (options.verbose) setLogLevel("debug");
    await runVaultSync(path, options);
  });

program.parse();
