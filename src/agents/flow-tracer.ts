import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import type { ScribeConfig, GlobalIndex } from "../config/schema.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { FlowStore } from "../knowledge/flow-store.js";
import { closeKnowledgeDB } from "../knowledge/db.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import { FLOW_TRACER_SYSTEM, buildFlowTracePrompt } from "./prompts/flow-tracer.js";
import { readFileWithLineNumbers } from "../utils/fs.js";
import { truncateToTokenBudget } from "../claude/token-counter.js";
import { logger } from "../utils/logger.js";

export interface FlowsOptions {
  trace?: string;
  show?: string;
  verbose?: boolean;
}

export async function runFlows(
  targetPath: string,
  options: FlowsOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);

  const flowStore = new FlowStore(scribePath);
  const knowledgeStore = new KnowledgeStore(scribePath);
  const mysteryStore = new MysteryStore(scribePath);

  try {
    if (options.trace) {
      await traceFlow(
        rootPath,
        scribePath,
        options.trace,
        config,
        flowStore,
        knowledgeStore,
        mysteryStore
      );
      return;
    }

    if (options.show) {
      const flow = flowStore.getFlowWithSteps(options.show);
      if (!flow) {
        console.error(chalk.red(`Flow not found: ${options.show}`));
        return;
      }
      displayFlow(flow);
      return;
    }

    // List flows
    const flows = flowStore.listFlows();
    console.log(chalk.cyan("━━━ E2E Flows ━━━\n"));

    if (flows.length === 0) {
      console.log(chalk.gray('  No flows traced yet. Use --trace "feature name" to trace one.'));
      return;
    }

    for (const flow of flows) {
      const steps = flowStore.getFlowSteps(flow.id);
      console.log(`  ${chalk.cyan(flow.name)} (${steps.length} steps)`);
      console.log(chalk.gray(`    ${flow.description}`));
      console.log(chalk.gray(`    ID: ${flow.id} | Created: ${flow.created_at}`));
      console.log();
    }
  } finally {
    closeKnowledgeDB();
  }
}

async function traceFlow(
  rootPath: string,
  scribePath: string,
  feature: string,
  config: ScribeConfig,
  flowStore: FlowStore,
  knowledgeStore: KnowledgeStore,
  mysteryStore: MysteryStore
): Promise<void> {
  const spinner = ora(`Tracing flow: ${feature}...`).start();

  try {
    // Load project overview
    let projectOverview = "";
    try {
      projectOverview = await readFile(join(scribePath, "index.md"), "utf-8");
    } catch { /* no overview */ }

    // Load relevant source files
    const filesContent = await loadFlowFiles(rootPath, scribePath, feature);

    const prompt = buildFlowTracePrompt(
      feature,
      truncateToTokenBudget(filesContent, 80000),
      truncateToTokenBudget(projectOverview, 5000)
    );

    const task: AgentTask = {
      id: "flow-tracer",
      model: config.knowledge.flowTracerModel,
      systemPrompt: FLOW_TRACER_SYSTEM,
      userPrompt: prompt,
      maxTokens: 8192,
    };

    const result = await runSingleAgent(task);

    let parsed;
    try {
      const jsonStr = result.response.content
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      spinner.fail("Failed to parse flow trace response");
      return;
    }

    // Save flow
    const flow = flowStore.insertFlow({
      name: parsed.name || feature,
      description: parsed.description || "",
      trigger_description: parsed.trigger || null,
    });

    // Save steps
    for (const step of parsed.steps || []) {
      flowStore.addFlowStep({
        flow_id: flow.id,
        step_order: step.order,
        specialist: step.specialist || null,
        description: step.description,
        file_path: step.file || null,
        start_line: step.startLine || null,
        end_line: step.endLine || null,
        code_snippet: step.codeSnippet || null,
        node_id: null,
      });
    }

    // Save knowledge from flow tracing
    let nodesCreated = 0;
    for (const k of parsed.knowledge || []) {
      const validTypes = ["fact", "explanation", "pattern", "relationship", "flow_step", "resolution"] as const;
      const nt = validTypes.includes(k.node_type) ? k.node_type as typeof validTypes[number] : "relationship" as const;
      knowledgeStore.insertNode({
        content: k.content,
        summary: k.summary,
        node_type: nt,
        confidence: k.confidence || 0.7,
        tags: k.tags || [],
        source_question: `Flow: ${feature}`,
      });
      nodesCreated++;
    }

    // Save mysteries
    let mysteriesCreated = 0;
    for (const m of parsed.mysteries || []) {
      mysteryStore.insertMystery({
        title: m.title,
        description: m.description,
        priority: m.priority || 5,
        specialist: null,
        source: "investigation",
      });
      mysteriesCreated++;
    }

    spinner.succeed(
      `Flow traced: ${(parsed.steps || []).length} steps, ${nodesCreated} knowledge nodes, ${mysteriesCreated} mysteries`
    );

    // Display the flow
    const fullFlow = flowStore.getFlowWithSteps(flow.id);
    if (fullFlow) {
      displayFlow(fullFlow);
    }
  } catch (err) {
    spinner.fail(`Flow tracing failed: ${err}`);
  }
}

function displayFlow(flow: { name: string; description: string; trigger_description: string | null; steps: Array<{ step_order: number; specialist: string | null; description: string; file_path: string | null; start_line: number | null; code_snippet: string | null }> }): void {
  console.log(chalk.cyan(`\n━━━ Flow: ${flow.name} ━━━\n`));
  console.log(`${flow.description}`);
  if (flow.trigger_description) {
    console.log(chalk.gray(`Trigger: ${flow.trigger_description}`));
  }
  console.log();

  for (const step of flow.steps) {
    const specialist = step.specialist ? chalk.blue(`[${step.specialist}]`) : "";
    console.log(`  ${step.step_order}. ${specialist} ${step.description}`);

    if (step.file_path) {
      const loc = step.start_line
        ? `${step.file_path}:L${step.start_line}`
        : step.file_path;
      console.log(chalk.gray(`     📎 ${loc}`));
    }
    if (step.code_snippet) {
      const lines = step.code_snippet.split("\n").slice(0, 2);
      for (const line of lines) {
        console.log(chalk.gray(`     > ${line}`));
      }
    }
    console.log();
  }
}

async function loadFlowFiles(
  rootPath: string,
  scribePath: string,
  feature: string
): Promise<string> {
  const parts: string[] = [];

  try {
    const indexRaw = await readFile(
      join(scribePath, "_global-index.json"),
      "utf-8"
    );
    const index: GlobalIndex = JSON.parse(indexRaw);

    // For flow tracing, load files from ALL specialists (flows cross boundaries)
    const allFiles = new Set<string>();
    for (const [, info] of Object.entries(index.specialists)) {
      for (const f of info.files) {
        allFiles.add(f);
      }
    }

    // Prioritize files matching feature keywords
    const keywords = feature.toLowerCase().split(/[\s、。]+/).filter((t) => t.length > 1);
    const scored = [...allFiles].map((f) => {
      let score = 0;
      for (const kw of keywords) {
        if (f.toLowerCase().includes(kw)) score += 2;
      }
      return { file: f, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const filesToLoad = scored.slice(0, 15).map((s) => s.file);

    for (const file of filesToLoad) {
      try {
        const content = await readFileWithLineNumbers(join(rootPath, file));
        parts.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
      } catch { /* skip */ }
    }
  } catch {
    logger.warn("Could not load files for flow tracing");
  }

  return parts.join("\n\n");
}
