/**
 * Debug Investigator: 消去法で原因を特定する
 *
 * 1. 症状から関連フローを特定
 * 2. 仮説を列挙
 * 3. 各仮説に証拠を集める
 * 4. 証拠に基づいて仮説を消去
 * 5. 残った仮説 = 原因候補
 * 6. 全プロセスを知識として保存
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import type { ScribeConfig, GlobalIndex } from "../config/schema.js";
import { getKnowledgeDB, closeKnowledgeDB, generateId } from "../knowledge/db.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import { DEBUGGER_SYSTEM, buildDebugPrompt } from "./prompts/debugger.js";
import { readFileWithLineNumbers } from "../utils/fs.js";
import { truncateToTokenBudget } from "../claude/token-counter.js";
import { indexNodeTokens } from "../knowledge/neuron.js";
import { logger } from "../utils/logger.js";

export interface DebugOptions {
  verbose?: boolean;
}

export async function runDebug(
  targetPath: string,
  symptom: string,
  options: DebugOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);
  const db = getKnowledgeDB(scribePath);
  const knowledgeStore = new KnowledgeStore(scribePath);
  const mysteryStore = new MysteryStore(scribePath);

  try {
    console.log(chalk.cyan("━━━ Debug Investigation ━━━\n"));
    console.log(chalk.gray(`Symptom: ${symptom}\n`));

    // Step 1: Gather context
    const spinner = ora("Gathering evidence...").start();

    // Search existing knowledge for context
    const relatedKnowledge = knowledgeStore.searchForAnswer(symptom, 5);
    const knowledgeContext = relatedKnowledge
      .map((r) => `- ${r.node.summary}: ${r.node.content.slice(0, 200)}`)
      .join("\n");

    // Load app-map context (screens, endpoints, features)
    let appMapContext = "";
    try {
      const screens = db.prepare("SELECT name, route, file_path FROM screens").all() as any[];
      const endpoints = db.prepare("SELECT method, path, handler_file FROM endpoints").all() as any[];
      appMapContext = [
        "Screens: " + screens.map((s: any) => `${s.name}(${s.route}→${s.file_path})`).join(", "),
        "Endpoints: " + endpoints.map((e: any) => `${e.method} ${e.path}→${e.handler_file}`).join(", "),
      ].join("\n");
    } catch { /* no app-map data */ }

    // Load relevant source files
    const relatedCode = await loadRelatedFiles(rootPath, scribePath, symptom);

    spinner.succeed("Evidence gathered");

    // Step 2: AI elimination analysis
    const spinner2 = ora("Running elimination analysis...").start();

    const task: AgentTask = {
      id: "debugger",
      model: config.agents.analysisModel,
      systemPrompt: DEBUGGER_SYSTEM,
      userPrompt: buildDebugPrompt(
        symptom,
        truncateToTokenBudget(relatedCode, 80000),
        knowledgeContext,
        appMapContext
      ),
      maxTokens: 8192,
    };

    const result = await runSingleAgent(task);

    let analysis;
    try {
      const jsonStr = result.response.content
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      analysis = JSON.parse(jsonStr);
    } catch {
      spinner2.fail("Failed to parse debug analysis");
      console.log(result.response.content);
      return;
    }

    spinner2.succeed("Elimination analysis complete");

    // Step 3: Display results
    console.log(chalk.cyan("\n━━━ Hypotheses ━━━\n"));

    for (const h of analysis.hypotheses || []) {
      const icon =
        h.status === "eliminated" ? chalk.green("✗ ELIMINATED") :
        h.status === "suspect" ? chalk.red("⚠ SUSPECT") :
        chalk.yellow("? UNKNOWN");

      console.log(`  ${icon} H${h.id}: ${h.description}`);

      for (const e of h.evidence || []) {
        const verdict =
          e.verdict === "supports" ? chalk.red("→") :
          e.verdict === "contradicts" ? chalk.green("✗") :
          chalk.yellow("?");
        console.log(chalk.gray(`    ${verdict} ${e.description}`));
        if (e.file) console.log(chalk.gray(`      📎 ${e.file}:L${e.line || "?"}`));
        if (e.snippet) {
          const lines = e.snippet.split("\n").slice(0, 2);
          for (const l of lines) console.log(chalk.gray(`      > ${l}`));
        }
      }
      console.log(chalk.gray(`    Reasoning: ${h.reasoning}`));
      console.log();
    }

    // Conclusion
    if (analysis.conclusion) {
      const c = analysis.conclusion;
      console.log(chalk.cyan("━━━ Conclusion ━━━\n"));
      console.log(chalk.red(`  Root Cause: ${c.root_cause}`));
      console.log(chalk.gray(`  Confidence: ${(c.confidence * 100).toFixed(0)}%`));
      if (c.fix_suggestion) {
        console.log(chalk.green(`\n  Fix: ${c.fix_suggestion}`));
      }
      if (c.affected_files?.length > 0) {
        console.log(chalk.yellow(`  Affected: ${c.affected_files.join(", ")}`));
      }
      if (c.impact) {
        console.log(chalk.yellow(`  Impact: ${c.impact}`));
      }
      if (c.remaining_suspects?.length > 0) {
        console.log(chalk.yellow(`  Remaining suspects: H${c.remaining_suspects.join(", H")}`));
      }
    }

    // Step 4: Save as knowledge
    const spinner3 = ora("Saving debug knowledge...").start();
    let nodesSaved = 0;

    // Save the debug session itself
    const sessionNodeId = generateId();
    const sessionContent = [
      `Bug: ${symptom}`,
      `Root cause: ${analysis.conclusion?.root_cause || "unknown"}`,
      `Fix: ${analysis.conclusion?.fix_suggestion || "TBD"}`,
      `Hypotheses tested: ${(analysis.hypotheses || []).length}`,
      `Eliminated: ${(analysis.hypotheses || []).filter((h: any) => h.status === "eliminated").length}`,
    ].join("\n");

    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, source_question)
       VALUES (?, ?, ?, 'resolution', ?, ?)`
    ).run(
      sessionNodeId,
      sessionContent,
      `Debug: ${symptom.slice(0, 60)}`,
      analysis.conclusion?.confidence || 0.7,
      `debug:${symptom}`
    );
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, 'debug')").run(sessionNodeId);
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, 'bugfix')").run(sessionNodeId);
    indexNodeTokens(db, sessionNodeId, sessionContent, `Debug: ${symptom.slice(0, 60)}`, ["debug", "bugfix"]);
    nodesSaved++;

    // Save new knowledge from analysis
    for (const k of analysis.new_knowledge || []) {
      const nId = generateId();
      db.prepare(
        `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, source_question)
         VALUES (?, ?, ?, 'fact', 0.8, ?)`
      ).run(nId, k.content, k.summary, `debug:${symptom}`);
      for (const tag of k.tags || []) {
        db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nId, tag.toLowerCase());
      }
      indexNodeTokens(db, nId, k.content, k.summary, k.tags || []);
      nodesSaved++;
    }

    // Create mysteries from unknowns
    let mysteriesCreated = 0;
    for (const m of analysis.new_mysteries || []) {
      mysteryStore.insertMystery({
        title: m.title,
        description: m.description,
        source: "investigation",
        priority: 7,
      });
      mysteriesCreated++;
    }

    // Mysteries from remaining unknown hypotheses
    for (const h of (analysis.hypotheses || []).filter((h: any) => h.status === "unknown")) {
      mysteryStore.insertMystery({
        title: `Debug unknown: ${h.description.slice(0, 60)}`,
        description: `Hypothesis H${h.id} could not be verified during debug of: ${symptom}`,
        source: "investigation",
        priority: 5,
      });
      mysteriesCreated++;
    }

    spinner3.succeed(`Saved ${nodesSaved} knowledge nodes, ${mysteriesCreated} mysteries`);
  } finally {
    closeKnowledgeDB();
  }
}

async function loadRelatedFiles(
  rootPath: string,
  scribePath: string,
  symptom: string
): Promise<string> {
  const parts: string[] = [];

  try {
    const indexRaw = await readFile(join(scribePath, "_global-index.json"), "utf-8");
    const index: GlobalIndex = JSON.parse(indexRaw);

    const keywords = symptom.split(/[\s、。？！]+/).filter((t) => t.length > 1);
    const relevantFiles = new Set<string>();

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      for (const [file] of Object.entries(index.files)) {
        if (file.toLowerCase().includes(kwLower)) relevantFiles.add(file);
      }
      for (const [keyword, specialists] of Object.entries(index.keywords)) {
        if (keyword.toLowerCase().includes(kwLower)) {
          for (const sp of specialists) {
            const spInfo = index.specialists[sp];
            if (spInfo) for (const f of spInfo.files.slice(0, 3)) relevantFiles.add(f);
          }
        }
      }
    }

    // Also add files from app-map screens/endpoints matching symptom
    try {
      const db = getKnowledgeDB(scribePath);
      const screens = db.prepare("SELECT file_path FROM screens").all() as Array<{ file_path: string }>;
      const endpoints = db.prepare("SELECT handler_file FROM endpoints").all() as Array<{ handler_file: string }>;
      for (const s of screens) relevantFiles.add(s.file_path);
      for (const e of endpoints) relevantFiles.add(e.handler_file);
    } catch { /* no app-map */ }

    for (const file of [...relevantFiles].slice(0, 15)) {
      try {
        const content = await readFileWithLineNumbers(join(rootPath, file));
        parts.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
      } catch { /* skip */ }
    }
  } catch {
    logger.warn("Could not load files for debug analysis");
  }

  return parts.join("\n\n");
}
