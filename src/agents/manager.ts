/**
 * Manager AI (旧Orchestrator)
 *
 * 各ビジネスドメインの専門家に調査依頼・協力依頼を出し、
 * 回答を統合し、全回答に必ずFact Checkを走らせる。
 *
 * Orchestratorとの違い:
 * - ビジネスドメイン（機能）ベースでspecialistを選択
 * - 調査依頼（investigate request）と協力依頼（collaboration request）を区別
 * - 全specialistの回答に必ずFact Checkが走る
 * - Specialistは全6検索戦略パイプラインを使う
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScribeConfig, GlobalIndex } from "../config/schema.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import { askSpecialist } from "./specialist.js";
import { factCheckAnswer, type FactCheckReport } from "./fact-checker.js";
import { logger } from "../utils/logger.js";

// --- Manager Prompts ---

const MANAGER_ROUTING_SYSTEM = `You are the Manager AI — you delegate investigations to domain specialists and coordinate collaboration between them.

Your specialists are organized by BUSINESS DOMAIN (not code directories):
- Each specialist is an expert in a specific business feature (e.g., "認証", "freee連携", "インポート機能")
- They know everything about their domain: screens, APIs, operations, and underlying code

Your job:
1. Understand the question
2. Decide which specialist(s) should investigate
3. Decide the type of request:
   - "investigate": This specialist should research and answer (primary responsibility)
   - "collaborate": This specialist has relevant context (secondary, supporting role)
4. Refine the question for each specialist's domain

Output format (JSON):
{
  "assignments": [
    {
      "specialist": "specialist-name",
      "role": "investigate" | "collaborate",
      "question": "Refined question specific to this specialist's domain",
      "reason": "Why this specialist is needed"
    }
  ],
  "strategy": "Brief explanation of your delegation strategy"
}

RULES:
1. Assign 1 primary investigator (role: "investigate")
2. Add collaborators only if the question crosses domain boundaries
3. Maximum 3 specialists total
4. If no specialist matches, return empty assignments`;

const MANAGER_SYNTHESIS_SYSTEM = `You are the Manager AI synthesizing investigation results from multiple domain specialists.

You received:
- Investigation results from the primary specialist
- Supporting context from collaborating specialists
- Fact-check results for each specialist's response

Your job:
1. Combine into a coherent, unified answer
2. Clearly indicate which specialist provided which information
3. Highlight fact-check results (verified/partial/unverified counts)
4. Flag any contradictions between specialists
5. If a specialist's response had unverified claims, note this as a caveat

RULES:
1. Preserve ALL source citations from specialists
2. Show fact-check summary per specialist
3. Respond in the same language as the question
4. Do NOT add information not provided by specialists`;

// --- Types ---

export interface ManagerResult {
  answer: string;
  specialistsConsulted: Array<{ name: string; role: "investigate" | "collaborate" }>;
  rawSpecialistAnswers: Array<{ name: string; answer: string; role: string }>;
  factCheckResults: Array<{ specialist: string; report: FactCheckReport }>;
}

interface Assignment {
  specialist: string;
  role: "investigate" | "collaborate";
  question: string;
  reason: string;
}

// --- Main Flow ---

/**
 * Manager delegation flow:
 * 1. Route to domain specialists (investigate + collaborate)
 * 2. Each specialist answers using full search pipeline
 * 3. Each answer is fact-checked
 * 4. Manager synthesizes with fact-check annotations
 */
export async function manageQuestion(
  question: string,
  rootPath: string,
  scribePath: string,
  config: ScribeConfig
): Promise<ManagerResult> {
  // Step 1: Load project map + specialist list
  const projectOverview = await loadFile(join(scribePath, "index.md"));
  const specialistList = await loadSpecialistList(scribePath);

  // Step 2: Delegate to specialists
  const assignments = await delegateQuestion(
    question,
    projectOverview,
    specialistList,
    config
  );

  if (assignments.length === 0) {
    return {
      answer: "この質問に対応できるスペシャリストが見つかりませんでした。",
      specialistsConsulted: [],
      rawSpecialistAnswers: [],
      factCheckResults: [],
    };
  }

  logger.info(
    `Manager delegating: ${assignments.map((a) => `${a.specialist}(${a.role})`).join(", ")}`
  );

  // Step 3: Query each specialist + fact-check each response
  const specialistAnswers: Array<{ name: string; answer: string; role: string }> = [];
  const factCheckResults: Array<{ specialist: string; report: FactCheckReport }> = [];

  for (const assignment of assignments) {
    logger.info(`Querying ${assignment.role}: ${assignment.specialist}`);

    try {
      const answer = await askSpecialist(
        assignment.specialist,
        assignment.question,
        scribePath,
        config
      );
      specialistAnswers.push({
        name: assignment.specialist,
        answer,
        role: assignment.role,
      });

      // Fact-check EVERY specialist response
      logger.info(`Fact-checking ${assignment.specialist}...`);
      try {
        const fcReport = await factCheckAnswer(
          answer,
          rootPath,
          scribePath,
          config
        );
        factCheckResults.push({ specialist: assignment.specialist, report: fcReport });
        logger.info(
          `${assignment.specialist} fact-check: ${fcReport.summary.verified}v/${fcReport.summary.partial}p/${fcReport.summary.unverified}u`
        );
      } catch (err) {
        logger.warn(`Fact-check failed for ${assignment.specialist}: ${err}`);
      }
    } catch (err) {
      logger.error(`Specialist ${assignment.specialist} failed: ${err}`);
      specialistAnswers.push({
        name: assignment.specialist,
        answer: `[Error: ${assignment.specialist} could not respond]`,
        role: assignment.role,
      });
    }
  }

  // Step 4: Synthesize with fact-check annotations
  let finalAnswer: string;
  if (specialistAnswers.length === 1 && factCheckResults.length <= 1) {
    finalAnswer = specialistAnswers[0].answer;
    // Append fact-check summary
    if (factCheckResults.length > 0) {
      const fc = factCheckResults[0].report.summary;
      finalAnswer += `\n\n_Fact Check: ${fc.verified} verified, ${fc.partial} partial, ${fc.unverified} unverified_`;
    }
  } else {
    finalAnswer = await synthesizeWithFactCheck(
      question,
      specialistAnswers,
      factCheckResults,
      config
    );
  }

  return {
    answer: finalAnswer,
    specialistsConsulted: assignments.map((a) => ({ name: a.specialist, role: a.role })),
    rawSpecialistAnswers: specialistAnswers,
    factCheckResults,
  };
}

// --- Delegation (Programmatic — no AI call needed) ---

async function delegateQuestion(
  question: string,
  _projectOverview: string,
  _specialistList: string,
  config: ScribeConfig
): Promise<Assignment[]> {
  // Programmatic routing: match question keywords against specialist metadata
  // This is faster and more reliable than AI routing via Claude CLI
  return programmaticRoute(question, config);
}

/**
 * Programmatic specialist routing using keyword matching.
 * Scores each specialist by how well their keywords, files, and exports match the question.
 * No AI call needed — instant routing with high accuracy.
 */
async function programmaticRoute(
  question: string,
  _config: ScribeConfig
): Promise<Assignment[]> {
  // Load global index for specialist metadata
  const scribePath = currentScribePath;
  if (!scribePath) return [];

  try {
    const raw = await readFile(join(scribePath, "_global-index.json"), "utf-8");
    const index: GlobalIndex = JSON.parse(raw);

    const questionLower = question.toLowerCase();
    const questionWords = questionLower.split(/[\s?!.,;:]+/).filter(w => w.length > 2);
    // Build word-boundary regex for precise matching
    const wordBoundaryMatch = (text: string, word: string): boolean => {
      if (word.length < 4) {
        return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
      }
      return text.includes(word);
    };

    // Prefix match: "cache" matches "caching", "migrate" matches "migration"
    const prefixMatch = (a: string, b: string): boolean => {
      const minLen = Math.min(a.length, b.length);
      if (minLen < 4) return false;
      const prefixLen = Math.min(minLen, 5); // Compare first 4-5 chars
      return a.slice(0, prefixLen) === b.slice(0, prefixLen);
    };

    const scores: Array<{ name: string; score: number }> = [];

    for (const [name, info] of Object.entries(index.specialists)) {
      let score = 0;

      // Match against specialist keywords (both directions)
      for (const kw of info.keywords) {
        const kwLower = kw.toLowerCase();
        // Forward: question contains keyword
        if (kwLower.length >= 4 && questionLower.includes(kwLower)) {
          score += 3;
        }
        // Reverse: keyword contains a question word (e.g., "migrationexecutor" contains "migration")
        for (const qw of questionWords) {
          if (qw.length >= 4 && kwLower.includes(qw)) {
            score += 2;
          } else if (qw.length >= 4 && prefixMatch(kwLower, qw)) {
            score += 1; // Prefix match: weaker signal
          }
        }
      }

      // Match against specialist name parts
      const nameParts = name.split("-").filter(p => p !== "src" && p.length > 2);
      for (const part of nameParts) {
        const partLower = part.toLowerCase();
        if (wordBoundaryMatch(questionLower, partLower)) {
          score += 5;
        } else {
          // Prefix match: "cache" matches question word "caching"
          for (const qw of questionWords) {
            if (prefixMatch(partLower, qw)) {
              score += 4;
              break;
            }
          }
        }
      }

      // Match against file basenames
      for (const file of info.files) {
        const basename = file.split("/").pop()?.replace(/\.\w+$/, "").toLowerCase() || "";
        if (basename.length > 3 && questionLower.includes(basename)) {
          score += 4;
        }
      }

      // Match specialist description words
      const descWords = info.description.toLowerCase().split(/\s+/);
      for (const word of questionWords) {
        if (descWords.includes(word)) {
          score += 1;
        }
      }

      // Try loading code index for export name matching
      try {
        const codeIndexRaw = await readFile(
          join(scribePath, "specialists", name, "_code-index.json"),
          "utf-8"
        );
        const codeIndex = JSON.parse(codeIndexRaw) as Array<{
          file: string;
          exports: { name: string; kind: string; line: number }[];
        }>;
        for (const entry of codeIndex) {
          for (const exp of entry.exports) {
            const expLower = exp.name.toLowerCase();
            // Only match exports with 4+ char names to avoid false positives
            if (expLower.length >= 4 && wordBoundaryMatch(questionLower, expLower)) {
              score += 6;
            }
            // Reverse: export name contains question word
            for (const qw of questionWords) {
              if (qw.length >= 4 && expLower.includes(qw)) {
                score += 3;
              }
            }
          }
        }
      } catch {
        // No code index
      }

      if (score > 0) {
        scores.push({ name, score });
      }
    }

    // Sort by score, take top 1-2
    scores.sort((a, b) => b.score - a.score);

    if (scores.length === 0) {
      // Fallback: use "other" specialist if it exists
      if (index.specialists["other"]) {
        return [{
          specialist: "other",
          role: "investigate",
          question,
          reason: "Fallback to general specialist",
        }];
      }
      return [];
    }

    const assignments: Assignment[] = [{
      specialist: scores[0].name,
      role: "investigate",
      question,
      reason: `Best keyword match (score: ${scores[0].score})`,
    }];

    logger.info(`Programmatic routing: ${assignments.map(a => `${a.specialist}(${a.role}:${scores.find(s=>s.name===a.specialist)?.score})`).join(", ")}`);

    return assignments;
  } catch (err) {
    logger.warn(`Programmatic routing failed: ${err}`);
    return [];
  }
}

// Track current scribePath for programmatic routing
let currentScribePath: string | null = null;
export function setScribePath(path: string): void {
  currentScribePath = path;
}

// --- Synthesis with Fact-Check ---

async function synthesizeWithFactCheck(
  question: string,
  specialistAnswers: Array<{ name: string; answer: string; role: string }>,
  factCheckResults: Array<{ specialist: string; report: FactCheckReport }>,
  config: ScribeConfig
): Promise<string> {
  // Build fact-check annotated answers
  const annotated = specialistAnswers.map((sa) => {
    const fc = factCheckResults.find((f) => f.specialist === sa.name);
    let text = `## From: ${sa.name} (${sa.role})\n${sa.answer}`;
    if (fc) {
      text += `\n\n### Fact Check\n- Verified: ${fc.report.summary.verified}\n- Partial: ${fc.report.summary.partial}\n- Unverified: ${fc.report.summary.unverified}`;
    }
    return text;
  });

  const task: AgentTask = {
    id: "manager-synthesis",
    model: config.agents.responseModel,
    systemPrompt: MANAGER_SYNTHESIS_SYSTEM,
    userPrompt: `# Original Question\n${question}\n\n# Specialist Results\n${annotated.join("\n\n---\n\n")}\n\n---\nSynthesize with fact-check annotations. Preserve all citations.`,
    maxTokens: 4096,
  };

  const result = await runSingleAgent(task);
  return result.response.content;
}

// --- Helpers ---

async function loadFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function loadSpecialistList(scribePath: string): Promise<string> {
  try {
    const raw = await readFile(join(scribePath, "_global-index.json"), "utf-8");
    const index: GlobalIndex = JSON.parse(raw);

    const entries: string[] = [];
    for (const [name, info] of Object.entries(index.specialists)) {
      let entry = `- **${name}**: ${info.description}\n  Keywords: ${info.keywords.slice(0, 15).join(", ")}\n  Files: ${info.files.slice(0, 5).join(", ")}`;

      // Load code index to show key exports (helps routing accuracy)
      try {
        const codeIndexRaw = await readFile(
          join(scribePath, "specialists", name, "_code-index.json"),
          "utf-8"
        );
        const codeIndex = JSON.parse(codeIndexRaw) as Array<{
          file: string;
          exports: { name: string; kind: string; line: number }[];
        }>;
        const keyExports = codeIndex
          .flatMap((e) => e.exports.filter((x) => x.kind === "class" || x.kind === "function" || x.kind === "interface"))
          .slice(0, 10)
          .map((e) => `${e.kind}:${e.name}`);
        if (keyExports.length > 0) {
          entry += `\n  Key exports: ${keyExports.join(", ")}`;
        }
      } catch {
        // No code index
      }

      entries.push(entry);
    }

    return entries.join("\n\n");
  } catch {
    return "No specialists available.";
  }
}
