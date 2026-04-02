/**
 * Investigation Pipeline: 調査依頼の完全自動化
 *
 * 8つの調査システムを正しい順番で繋ぎ、
 * 構造化された調査報告書を出力する。
 *
 * Phase 1: 情報収集 (knowledge, app-map, diff-watch, logs)
 * Phase 2: フロー追跡 (flow-tracer)
 * Phase 3: 消去法分析 (debugger)
 * Phase 4: 影響分析 + 報告書 (impact-analysis, report)
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import type { ScribeConfig } from "../config/schema.js";
import { getKnowledgeDB, closeKnowledgeDB, generateId } from "../knowledge/db.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { detectAndMarkStale } from "../knowledge/diff-watch.js";
import { LogStore, detectPatterns, type LogPattern } from "../knowledge/log-analyzer.js";
import { analyzeImpact, formatImpactReport } from "../knowledge/impact-analysis.js";
import { indexNodeTokens } from "../knowledge/neuron.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import { DEBUGGER_SYSTEM, buildDebugPrompt } from "./prompts/debugger.js";
import {
  INVESTIGATION_REPORT_SYSTEM,
  buildReportPrompt,
} from "./prompts/investigation-report.js";
import { readFileWithLineNumbers } from "../utils/fs.js";
import { truncateToTokenBudget } from "../claude/token-counter.js";
import { logger } from "../utils/logger.js";

export interface FullInvestigationOptions {
  logFile?: string;
  verbose?: boolean;
}

export async function runFullInvestigation(
  targetPath: string,
  symptom: string,
  options: FullInvestigationOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);
  const db = getKnowledgeDB(scribePath);
  const knowledgeStore = new KnowledgeStore(scribePath);
  const mysteryStore = new MysteryStore(scribePath);

  console.log(chalk.cyan("━━━ Full Investigation Pipeline ━━━\n"));
  console.log(chalk.gray(`Symptom: ${symptom}\n`));

  const context: Record<string, string> = { symptom };

  try {
    // ═══════════════════════════════════════
    // Phase 1: 情報収集
    // ═══════════════════════════════════════
    const s1 = ora("Phase 1: Gathering intelligence...").start();

    // ① 既存知識を検索
    await knowledgeStore.prepareQueryVector(symptom);
    const existingKnowledge = knowledgeStore.searchForAnswer(symptom, 5);
    context.knowledge = existingKnowledge.length > 0
      ? existingKnowledge.map((r) => `- ${r.node.summary} (${(r.node.confidence * 100).toFixed(0)}%): ${r.node.content.slice(0, 150)}`).join("\n")
      : "No existing knowledge found.";

    // ② app-mapで関連要素を特定
    let screens: any[] = [], endpoints: any[] = [], features: any[] = [];
    try {
      screens = db.prepare("SELECT name, route, file_path FROM screens").all() as any[];
      endpoints = db.prepare("SELECT method, path, handler_file FROM endpoints").all() as any[];
      features = db.prepare("SELECT name, description FROM features").all() as any[];
    } catch { /* no app-map data */ }

    context.appMap = [
      screens.length > 0 ? `Screens: ${screens.map((s: any) => `${s.name}(${s.route}→${s.file_path})`).join(", ")}` : "",
      endpoints.length > 0 ? `Endpoints: ${endpoints.map((e: any) => `${e.method} ${e.path}→${e.handler_file}`).join(", ")}` : "",
      features.length > 0 ? `Features: ${features.map((f: any) => `${f.name}: ${f.description || ""}`).join(", ")}` : "",
    ].filter(Boolean).join("\n") || "No app-map data.";

    // ③ diff-watchで最近のコード変更を確認
    const diffResult = detectAndMarkStale(db, rootPath);
    context.changes = diffResult.changedFiles.length > 0
      ? `Changed files (${diffResult.changedFiles.length}): ${diffResult.changedFiles.join(", ")}\nStale nodes: ${diffResult.staleNodes}`
      : "No recent code changes detected.";

    // ④ ログがあればパターン検出
    let logPatterns: LogPattern[] = [];
    if (options.logFile) {
      try {
        const logContent = await readFile(resolve(options.logFile), "utf-8");
        const logStore = new LogStore(db);
        const session = logStore.ingestLog(`investigation-${Date.now()}`, logContent, options.logFile);
        logPatterns = detectPatterns(session.entries);
        logStore.saveAsKnowledge(session.id, logPatterns);
        context.logs = logPatterns.length > 0
          ? logPatterns.map((p) => `${p.type}: ${p.description} (${p.frequency}x)`).join("\n")
          : "No significant log patterns.";
      } catch (err) {
        context.logs = `Log analysis failed: ${err}`;
      }
    } else {
      context.logs = "";
    }

    s1.succeed(
      `Phase 1: ${existingKnowledge.length} knowledge hits, ${screens.length} screens, ${endpoints.length} endpoints, ${diffResult.changedFiles.length} changed files${logPatterns.length > 0 ? `, ${logPatterns.length} log patterns` : ""}`
    );

    // ═══════════════════════════════════════
    // Phase 2: フロー追跡
    // ═══════════════════════════════════════
    const s2 = ora("Phase 2: Tracing related flows...").start();

    // 既存フローを検索
    let flowContext = "";
    try {
      const flows = db.prepare("SELECT * FROM flows").all() as any[];
      for (const flow of flows) {
        const steps = db
          .prepare("SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY step_order")
          .all(flow.id) as any[];
        if (steps.length > 0) {
          flowContext += `\nFlow: ${flow.name}\n`;
          for (const step of steps) {
            flowContext += `  ${step.step_order}. [${step.action_type}] ${step.description}`;
            if (step.file_path) flowContext += ` (${step.file_path}:L${step.line_number || "?"})`;
            flowContext += "\n";
          }
        }
      }
    } catch { /* no flow data */ }

    // 関連ソースファイルを読み込み
    const relatedCode = await loadInvestigationFiles(rootPath, scribePath, symptom, diffResult.changedFiles);
    context.flow = flowContext || "No existing flows. Code loaded for analysis.";

    s2.succeed(`Phase 2: ${flowContext ? "Existing flows found" : "No flows, using code analysis"}`);

    // ═══════════════════════════════════════
    // Phase 3: 消去法分析
    // ═══════════════════════════════════════
    const s3 = ora("Phase 3: Elimination analysis...").start();

    const debugTask: AgentTask = {
      id: "investigation-debug",
      model: config.agents.analysisModel,
      systemPrompt: DEBUGGER_SYSTEM,
      userPrompt: buildDebugPrompt(
        symptom,
        truncateToTokenBudget(relatedCode, 60000),
        context.knowledge,
        context.appMap + "\n\n" + context.flow + "\n\n" + context.changes + "\n\n" + (context.logs || "")
      ),
      maxTokens: 8192,
    };

    const debugResult = await runSingleAgent(debugTask);
    let debugAnalysis: any;
    try {
      const jsonStr = debugResult.response.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      debugAnalysis = JSON.parse(jsonStr);
    } catch {
      debugAnalysis = { hypotheses: [], conclusion: { root_cause: "Analysis parse failed", confidence: 0 } };
    }

    const eliminated = (debugAnalysis.hypotheses || []).filter((h: any) => h.status === "eliminated").length;
    const suspects = (debugAnalysis.hypotheses || []).filter((h: any) => h.status === "suspect").length;

    context.debug = JSON.stringify(debugAnalysis, null, 2);

    s3.succeed(
      `Phase 3: ${(debugAnalysis.hypotheses || []).length} hypotheses, ${eliminated} eliminated, ${suspects} suspects`
    );

    // ═══════════════════════════════════════
    // Phase 4: 影響分析 + 報告書
    // ═══════════════════════════════════════
    const s4 = ora("Phase 4: Impact analysis & report generation...").start();

    // 影響分析（原因ファイルがあれば）
    let impactText = "";
    const affectedFiles = debugAnalysis.conclusion?.affected_files || [];
    for (const file of affectedFiles) {
      const impact = analyzeImpact(db, file);
      impactText += formatImpactReport(impact) + "\n\n";
    }
    context.impact = impactText || "No specific files identified for impact analysis.";

    // 報告書生成
    const reportTask: AgentTask = {
      id: "investigation-report",
      model: config.agents.analysisModel,
      systemPrompt: INVESTIGATION_REPORT_SYSTEM,
      userPrompt: buildReportPrompt(context as any),
      maxTokens: 8192,
    };

    const reportResult = await runSingleAgent(reportTask);
    let report: any;
    try {
      const jsonStr = reportResult.response.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      report = JSON.parse(jsonStr);
    } catch {
      report = { title: "調査報告", report_markdown: reportResult.response.content };
    }

    s4.succeed("Phase 4: Report generated");

    // ═══════════════════════════════════════
    // 報告書表示
    // ═══════════════════════════════════════
    console.log(chalk.cyan("\n" + "═".repeat(60)));
    console.log(chalk.cyan(report.title || "調査報告"));
    console.log(chalk.cyan("═".repeat(60) + "\n"));

    if (report.summary) {
      console.log(chalk.white(report.summary));
      console.log();
    }

    if (report.report_markdown) {
      console.log(report.report_markdown);
    } else {
      // Fallback: display raw debug analysis
      for (const h of debugAnalysis.hypotheses || []) {
        const icon = h.status === "eliminated" ? chalk.green("✗") : h.status === "suspect" ? chalk.red("⚠") : chalk.yellow("?");
        console.log(`  ${icon} H${h.id}: ${h.description} [${h.status}]`);
      }
      if (debugAnalysis.conclusion) {
        console.log(chalk.red(`\n  Root Cause: ${debugAnalysis.conclusion.root_cause}`));
        console.log(chalk.green(`  Fix: ${debugAnalysis.conclusion.fix_suggestion || "TBD"}`));
      }
    }

    if (report.risk_level) {
      const riskColor = report.risk_level === "critical" ? chalk.red : report.risk_level === "high" ? chalk.yellow : chalk.green;
      console.log(riskColor(`\nRisk: ${report.risk_level.toUpperCase()}`));
    }

    // ═══════════════════════════════════════
    // 永続化
    // ═══════════════════════════════════════
    const s5 = ora("Saving investigation results...").start();

    let nodesSaved = 0;

    // 調査セッション自体を知識に
    const sessionId = generateId();
    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, source_question)
       VALUES (?, ?, ?, 'resolution', ?, ?)`
    ).run(
      sessionId,
      report.report_markdown || context.debug,
      report.title || `調査: ${symptom.slice(0, 60)}`,
      debugAnalysis.conclusion?.confidence || 0.7,
      `investigate-full:${symptom}`
    );
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, 'investigation')").run(sessionId);
    db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, 'debug')").run(sessionId);
    indexNodeTokens(db, sessionId, report.report_markdown || symptom, report.title || symptom, ["investigation", "debug"]);
    nodesSaved++;

    // AI抽出の知識エントリ
    for (const k of report.knowledge_entries || []) {
      const nId = generateId();
      db.prepare(
        `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, source_question)
         VALUES (?, ?, ?, 'fact', 0.8, ?)`
      ).run(nId, k.content, k.summary, `investigate-full:${symptom}`);
      for (const tag of k.tags || []) {
        db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nId, tag.toLowerCase());
      }
      indexNodeTokens(db, nId, k.content, k.summary, k.tags || []);
      nodesSaved++;
    }

    // デバッグの未解決仮説 → mystery
    let mysteriesCreated = 0;
    for (const h of (debugAnalysis.hypotheses || []).filter((h: any) => h.status === "unknown")) {
      mysteryStore.insertMystery({
        title: `Investigation unknown: ${h.description.slice(0, 60)}`,
        description: `During investigation of "${symptom}", hypothesis H${h.id} could not be verified: ${h.description}`,
        source: "investigation",
        priority: 6,
      });
      mysteriesCreated++;
    }

    // デバッグから出た新規mystery
    for (const m of debugAnalysis.new_mysteries || []) {
      mysteryStore.insertMystery({
        title: m.title,
        description: m.description,
        source: "investigation",
        priority: m.priority || 5,
      });
      mysteriesCreated++;
    }

    // 報告書をMarkdownファイルとしても保存
    if (report.report_markdown) {
      const reportDir = join(scribePath, "reports");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(reportDir, { recursive: true });
      const date = new Date().toISOString().split("T")[0];
      const fileName = `${date}-${symptom.slice(0, 30).replace(/[^a-zA-Z0-9\u3040-\u9fff]/g, "-")}.md`;
      await writeFile(join(reportDir, fileName), report.report_markdown, "utf-8");
    }

    s5.succeed(`Saved: ${nodesSaved} knowledge nodes, ${mysteriesCreated} mysteries`);

    console.log(chalk.cyan("\n━━━ Investigation Complete ━━━"));
  } finally {
    closeKnowledgeDB();
  }
}

async function loadInvestigationFiles(
  rootPath: string,
  scribePath: string,
  symptom: string,
  changedFiles: string[]
): Promise<string> {
  const parts: string[] = [];
  const filesToLoad = new Set<string>(changedFiles);

  // Add files from app-map
  try {
    const db = getKnowledgeDB(scribePath);
    const screens = db.prepare("SELECT file_path FROM screens").all() as Array<{ file_path: string }>;
    const endpoints = db.prepare("SELECT handler_file FROM endpoints").all() as Array<{ handler_file: string }>;
    for (const s of screens) filesToLoad.add(s.file_path);
    for (const e of endpoints) filesToLoad.add(e.handler_file);
  } catch { /* no data */ }

  // Add files from knowledge citations
  try {
    const db = getKnowledgeDB(scribePath);
    const keywords = symptom.split(/[\s、。？]+/).filter((t) => t.length > 1);
    for (const kw of keywords) {
      const nodes = db
        .prepare("SELECT DISTINCT file_path FROM node_citations WHERE file_path LIKE ? LIMIT 5")
        .all(`%${kw}%`) as Array<{ file_path: string }>;
      for (const n of nodes) filesToLoad.add(n.file_path);
    }
  } catch { /* skip */ }

  for (const file of [...filesToLoad].slice(0, 20)) {
    try {
      const content = await readFileWithLineNumbers(join(rootPath, file));
      parts.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
    } catch { /* skip */ }
  }

  return parts.join("\n\n");
}
