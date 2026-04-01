import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScribeConfig, GlobalIndex, DomainJson } from "../config/schema.js";
import {
  ORCHESTRATOR_ROUTING_SYSTEM,
  ORCHESTRATOR_SYNTHESIS_SYSTEM,
  buildRoutingPrompt,
  buildSynthesisPrompt,
} from "./prompts/orchestrator.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import { askSpecialist } from "./specialist.js";
import { logger } from "../utils/logger.js";

export interface OrchestratorResult {
  answer: string;
  specialistsConsulted: string[];
  rawSpecialistAnswers: Array<{ name: string; answer: string }>;
}

/**
 * Main orchestration flow:
 * 1. Route question to relevant specialists
 * 2. Query each specialist
 * 3. Synthesize answers
 */
export async function orchestrateQuestion(
  question: string,
  scribePath: string,
  config: ScribeConfig
): Promise<OrchestratorResult> {
  // Step 1: Load project map for routing
  const projectOverview = await loadProjectOverview(scribePath);
  const specialistList = await loadSpecialistList(scribePath);

  // Step 2: Route to specialists
  const routing = await routeQuestion(
    question,
    projectOverview,
    specialistList,
    config
  );

  if (routing.specialists.length === 0) {
    return {
      answer:
        "この質問に対応できるスペシャリストが見つかりませんでした。\n分析対象のコードベースにこの情報が含まれていない可能性があります。",
      specialistsConsulted: [],
      rawSpecialistAnswers: [],
    };
  }

  logger.info(
    `Routing to specialists: ${routing.specialists.join(", ")} — ${routing.reason}`
  );

  // Step 3: Query each specialist
  const specialistAnswers: Array<{ name: string; answer: string }> = [];

  for (const name of routing.specialists) {
    const subQuestion = routing.subQuestions[name] || question;
    logger.info(`Querying specialist: ${name}`);

    try {
      const answer = await askSpecialist(name, subQuestion, scribePath, config);
      specialistAnswers.push({ name, answer });
    } catch (err) {
      logger.error(`Specialist ${name} failed: ${err}`);
      specialistAnswers.push({
        name,
        answer: `[Error: specialist ${name} could not respond]`,
      });
    }
  }

  // Step 4: Synthesize (if multiple specialists)
  let finalAnswer: string;
  if (specialistAnswers.length === 1) {
    finalAnswer = specialistAnswers[0].answer;
  } else {
    finalAnswer = await synthesizeAnswers(
      question,
      specialistAnswers,
      config
    );
  }

  return {
    answer: finalAnswer,
    specialistsConsulted: routing.specialists,
    rawSpecialistAnswers: specialistAnswers,
  };
}

interface RoutingDecision {
  specialists: string[];
  reason: string;
  subQuestions: Record<string, string>;
}

async function routeQuestion(
  question: string,
  projectOverview: string,
  specialistList: string,
  config: ScribeConfig
): Promise<RoutingDecision> {
  const task: AgentTask = {
    id: "orchestrator-routing",
    model: config.agents.responseModel,
    systemPrompt: ORCHESTRATOR_ROUTING_SYSTEM,
    userPrompt: buildRoutingPrompt(question, projectOverview, specialistList),
    maxTokens: 1024,
  };

  const result = await runSingleAgent(task);

  try {
    // Extract JSON from response (might be wrapped in markdown code block)
    const jsonStr = result.response.content
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(jsonStr) as RoutingDecision;
  } catch (err) {
    logger.warn(`Failed to parse routing response, falling back to all specialists`);
    // Fallback: return all specialists
    return {
      specialists: [],
      reason: "Could not parse routing decision",
      subQuestions: {},
    };
  }
}

async function synthesizeAnswers(
  question: string,
  specialistAnswers: Array<{ name: string; answer: string }>,
  config: ScribeConfig
): Promise<string> {
  const task: AgentTask = {
    id: "orchestrator-synthesis",
    model: config.agents.responseModel,
    systemPrompt: ORCHESTRATOR_SYNTHESIS_SYSTEM,
    userPrompt: buildSynthesisPrompt(question, specialistAnswers),
    maxTokens: 4096,
  };

  const result = await runSingleAgent(task);
  return result.response.content;
}

async function loadProjectOverview(scribePath: string): Promise<string> {
  try {
    return await readFile(join(scribePath, "index.md"), "utf-8");
  } catch {
    return "No project overview available.";
  }
}

async function loadSpecialistList(scribePath: string): Promise<string> {
  try {
    const indexRaw = await readFile(
      join(scribePath, "_global-index.json"),
      "utf-8"
    );
    const index: GlobalIndex = JSON.parse(indexRaw);

    return Object.entries(index.specialists)
      .map(
        ([name, info]) =>
          `- **${name}**: ${info.description}\n  Keywords: ${info.keywords.join(", ")}\n  Files: ${info.files.join(", ")}`
      )
      .join("\n\n");
  } catch {
    return "No specialists available.";
  }
}
