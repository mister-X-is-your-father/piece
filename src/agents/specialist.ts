import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cluster, DomainJson, ScribeConfig } from "../config/schema.js";
import { readFileWithLineNumbers } from "../utils/fs.js";
import { estimateTokens, truncateToTokenBudget } from "../claude/token-counter.js";
import {
  SPECIALIST_ANALYSIS_SYSTEM,
  SPECIALIST_ANSWER_SYSTEM,
  buildAnalysisPrompt,
  buildAnswerPrompt,
} from "./prompts/specialist.js";
import { runAgentTasks, runSingleAgent, type AgentTask } from "./agent-runner.js";
import { logger } from "../utils/logger.js";

/**
 * Run deep analysis on all clusters, creating specialist documentation.
 * Each specialist runs as a separate Claude API call with focused context.
 */
export async function analyzeAllClusters(
  rootPath: string,
  clusters: Cluster[],
  projectContext: string,
  config: ScribeConfig
): Promise<Map<string, string>> {
  logger.info(`Analyzing ${clusters.length} clusters with specialist agents...`);

  const tasks: AgentTask[] = [];

  for (const cluster of clusters) {
    // Build file content for this specialist's context
    const filesContent = await buildFilesContent(rootPath, cluster.files);
    const truncated = truncateToTokenBudget(filesContent, 80000);

    const userPrompt = buildAnalysisPrompt(
      cluster.name,
      truncated,
      projectContext
    );

    tasks.push({
      id: cluster.name,
      model: config.agents.analysisModel,
      systemPrompt: SPECIALIST_ANALYSIS_SYSTEM,
      userPrompt,
      maxTokens: 8192,
    });
  }

  const results = await runAgentTasks(tasks, config.agents.concurrency);

  const analyses = new Map<string, string>();
  for (const result of results) {
    analyses.set(result.id, result.response.content);
  }

  return analyses;
}

/**
 * Ask a specialist a question using its documentation as context.
 */
export async function askSpecialist(
  specialistName: string,
  question: string,
  scribePath: string,
  config: ScribeConfig
): Promise<string> {
  // Load specialist's documentation
  const documentation = await loadSpecialistDocs(scribePath, specialistName);

  const task: AgentTask = {
    id: `ask-${specialistName}`,
    model: config.agents.responseModel,
    systemPrompt: SPECIALIST_ANSWER_SYSTEM,
    userPrompt: buildAnswerPrompt(question, documentation),
    maxTokens: 4096,
  };

  const result = await runSingleAgent(task);
  return result.response.content;
}

async function buildFilesContent(
  rootPath: string,
  files: string[]
): Promise<string> {
  const parts: string[] = [];

  for (const file of files) {
    try {
      const content = await readFileWithLineNumbers(join(rootPath, file));
      parts.push(`### File: ${file}\n\`\`\`\n${content}\n\`\`\``);
    } catch (err) {
      logger.warn(`Could not read ${file}: ${err}`);
    }
  }

  return parts.join("\n\n");
}

async function loadSpecialistDocs(
  scribePath: string,
  specialistName: string
): Promise<string> {
  const specialistDir = join(scribePath, "specialists", specialistName);
  const parts: string[] = [];

  // Load code index first — gives specialist concrete file:line references
  try {
    const codeIndexRaw = await readFile(
      join(specialistDir, "_code-index.json"),
      "utf-8"
    );
    const codeIndex = JSON.parse(codeIndexRaw) as Array<{
      file: string;
      exports: { name: string; kind: string; line: number }[];
      functions: { name: string; startLine: number; endLine: number }[];
    }>;
    if (codeIndex.length > 0) {
      const indexLines: string[] = ["# Code Index (file → symbols with line numbers)"];
      for (const entry of codeIndex) {
        const symbols: string[] = [];
        for (const exp of entry.exports) {
          symbols.push(`  - ${exp.kind} ${exp.name} (L${exp.line})`);
        }
        for (const fn of entry.functions) {
          if (!entry.exports.some((e) => e.name === fn.name)) {
            symbols.push(`  - function ${fn.name} (L${fn.startLine}-L${fn.endLine})`);
          }
        }
        if (symbols.length > 0) {
          indexLines.push(`\n## ${entry.file}`);
          indexLines.push(...symbols);
        }
      }
      parts.push(indexLines.join("\n"));
    }
  } catch {
    // No code index — older analysis, fall through
  }

  // Load overview
  try {
    const overview = await readFile(
      join(specialistDir, "overview.md"),
      "utf-8"
    );
    parts.push(`# Domain Overview\n${overview}`);
  } catch {
    logger.warn(`No overview.md for specialist ${specialistName}`);
  }

  // Load file-level docs
  try {
    const { default: fg } = await import("fast-glob");
    const fileDocs = await fg("files/*.md", {
      cwd: specialistDir,
      absolute: true,
    });

    for (const docPath of fileDocs) {
      const content = await readFile(docPath, "utf-8");
      parts.push(content);
    }
  } catch {
    logger.warn(`No file docs for specialist ${specialistName}`);
  }

  return parts.join("\n\n---\n\n");
}
