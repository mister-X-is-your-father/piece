import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import type { ScribeConfig } from "../config/schema.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { InvestigationStore } from "../knowledge/investigation-store.js";
import { closeKnowledgeDB } from "../knowledge/db.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import {
  INVESTIGATOR_SYSTEM,
  buildInvestigationPrompt,
} from "./prompts/investigator.js";
import { readFileWithLineNumbers } from "../utils/fs.js";
import { truncateToTokenBudget } from "../claude/token-counter.js";
import { logger } from "../utils/logger.js";
import type { GlobalIndex } from "../config/schema.js";

export interface InvestigateOptions {
  mysteryId?: string;
  explore?: string;
  loop?: number;
  verbose?: boolean;
}

export async function runInvestigate(
  targetPath: string,
  options: InvestigateOptions
): Promise<void> {
  const { resolve } = await import("node:path");
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);

  const knowledgeStore = new KnowledgeStore(scribePath);
  const mysteryStore = new MysteryStore(scribePath);
  const investigationStore = new InvestigationStore(scribePath);

  const loops = options.loop || 1;

  try {
    for (let i = 0; i < loops; i++) {
      if (loops > 1) {
        console.log(chalk.cyan(`\n━━━ Investigation Cycle ${i + 1}/${loops} ━━━\n`));
      }

      let goal: string;
      let context: string | null = null;
      let mysteryId: string | null = null;

      if (options.explore) {
        goal = options.explore;
      } else if (options.mysteryId) {
        const mystery = mysteryStore.getMystery(options.mysteryId);
        if (!mystery) {
          console.error(chalk.red(`Mystery not found: ${options.mysteryId}`));
          return;
        }
        goal = `Investigate: ${mystery.title}\n${mystery.description}`;
        context = mystery.context;
        mysteryId = mystery.id;
        mysteryStore.setInvestigating(mystery.id);
      } else {
        // Auto-pick highest priority mystery
        const next = mysteryStore.getNextToInvestigate();
        if (!next) {
          console.log(chalk.green("No open mysteries to investigate!"));
          return;
        }
        goal = `Investigate: ${next.title}\n${next.description}`;
        context = next.context;
        mysteryId = next.id;
        mysteryStore.setInvestigating(next.id);
        console.log(chalk.yellow(`Auto-selected mystery: ${next.title}`));
      }

      // Create investigation record
      const investigation = investigationStore.create({
        mystery_id: mysteryId,
        goal,
      });
      investigationStore.start(investigation.id);

      const spinner = ora("Investigating...").start();

      try {
        const result = await performInvestigation(
          rootPath,
          scribePath,
          goal,
          context,
          config,
          knowledgeStore
        );

        // Save findings as knowledge nodes
        let nodesCreated = 0;
        const nodeIds: string[] = [];

        for (const finding of result.findings) {
          const node = knowledgeStore.insertNode({
            content: finding.content,
            summary: finding.summary,
            node_type: (finding.node_type as "fact") || "fact",
            confidence: finding.confidence || 0.7,
            specialist: null,
            source_question: goal,
            tags: finding.tags || [],
          });
          nodeIds.push(node.id);
          nodesCreated++;

          for (const cit of finding.citations || []) {
            knowledgeStore.addCitation({
              node_id: node.id,
              file_path: cit.file_path,
              start_line: cit.start_line ?? null,
              end_line: cit.end_line ?? null,
              code_snippet: cit.code_snippet ?? null,
            });
          }
        }

        // Save connections
        for (const conn of result.connections || []) {
          const fromId = nodeIds[conn.from_index];
          const toId = nodeIds[conn.to_index];
          if (fromId && toId) {
            knowledgeStore.linkNodes({
              source_id: fromId,
              target_id: toId,
              link_type: (conn.link_type as "related") || "related",
              description: conn.description || null,
            });
          }
        }

        // Hebbian learning + concept mesh growth from investigation
        if (nodeIds.length >= 2) {
          knowledgeStore.recordCoAccess(nodeIds);
        }
        // Learn concept links from tags
        const { learnConceptLink } = await import("../knowledge/neuron.js");
        const { getKnowledgeDB } = await import("../knowledge/db.js");
        const db = getKnowledgeDB(scribePath);
        const allTags = new Set<string>();
        for (const nid of nodeIds) {
          for (const t of knowledgeStore.getNodeTags(nid)) {
            allTags.add(t.toLowerCase());
          }
        }
        const tagArr = [...allTags];
        for (let i = 0; i < tagArr.length; i++) {
          for (let j = i + 1; j < tagArr.length; j++) {
            learnConceptLink(db, tagArr[i], tagArr[j], "co_occurrence");
          }
        }

        // Create new mysteries
        let newMysteries = 0;
        for (const m of result.new_mysteries || []) {
          mysteryStore.insertMystery({
            title: m.title,
            description: m.description,
            priority: m.priority || 5,
            specialist: null,
            source: "investigation",
          });
          newMysteries++;
        }

        // Resolve original mystery if applicable
        let mysteriesResolved = 0;
        if (mysteryId && result.resolution) {
          const resolutionNode = nodeIds[0];
          if (resolutionNode) {
            mysteryStore.resolveMystery(mysteryId, resolutionNode);
            mysteriesResolved++;
          }
        }

        // Complete investigation
        investigationStore.complete(investigation.id, result.resolution || "Investigation completed", {
          nodes_created: nodesCreated,
          nodes_updated: 0,
          mysteries_resolved: mysteriesResolved,
        });

        spinner.succeed(
          `Investigation complete: ${nodesCreated} nodes created, ${newMysteries} new mysteries, ${mysteriesResolved} mysteries resolved`
        );

        // Display findings
        for (const finding of result.findings) {
          console.log(chalk.green(`  + ${finding.summary}`));
        }
        for (const m of result.new_mysteries || []) {
          console.log(chalk.yellow(`  ? ${m.title}`));
        }
        if (result.resolution) {
          console.log(chalk.green(`  ✓ Resolved: ${result.resolution.slice(0, 100)}`));
        }
      } catch (err) {
        spinner.fail(`Investigation failed: ${err}`);
        investigationStore.fail(investigation.id, String(err));
      }
    }
  } finally {
    closeKnowledgeDB();
  }
}

interface InvestigationResult {
  findings: Array<{
    summary: string;
    content: string;
    confidence: number;
    node_type: string;
    tags: string[];
    citations: Array<{
      file_path: string;
      start_line?: number;
      end_line?: number;
      code_snippet?: string;
    }>;
  }>;
  connections: Array<{
    from_index: number;
    to_index: number;
    link_type: string;
    description: string;
  }>;
  new_mysteries: Array<{
    title: string;
    description: string;
    priority: number;
  }>;
  resolution: string | null;
}

async function performInvestigation(
  rootPath: string,
  scribePath: string,
  goal: string,
  context: string | null,
  config: ScribeConfig,
  knowledgeStore: KnowledgeStore
): Promise<InvestigationResult> {
  // Load relevant source files
  const filesContent = await loadRelevantFiles(rootPath, scribePath, goal);

  // Load existing knowledge for context
  const existingNodes = knowledgeStore.searchNodes(goal, 5);
  const existingKnowledge = existingNodes
    .map((r) => `- ${r.node.summary}: ${r.node.content.slice(0, 200)}`)
    .join("\n");

  const prompt = buildInvestigationPrompt(
    goal,
    context,
    truncateToTokenBudget(filesContent, 80000),
    existingKnowledge
  );

  const task: AgentTask = {
    id: "investigator",
    model: config.knowledge.investigationModel,
    systemPrompt: INVESTIGATOR_SYSTEM,
    userPrompt: prompt,
    maxTokens: 8192,
  };

  const result = await runSingleAgent(task);

  try {
    const jsonStr = result.response.content
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse investigator response");
  }
}

async function loadRelevantFiles(
  rootPath: string,
  scribePath: string,
  goal: string
): Promise<string> {
  const parts: string[] = [];

  // Load global index to find relevant files
  try {
    const indexRaw = await readFile(
      join(scribePath, "_global-index.json"),
      "utf-8"
    );
    const index: GlobalIndex = JSON.parse(indexRaw);

    // Extract keywords from goal
    const keywords = goal
      .split(/[\s、。？！?!,.;:]+/)
      .filter((t) => t.length > 2);

    const relevantFiles = new Set<string>();

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      // Search file paths
      for (const [file] of Object.entries(index.files)) {
        if (file.toLowerCase().includes(kwLower)) {
          relevantFiles.add(file);
        }
      }
      // Search keywords
      for (const [keyword, specialists] of Object.entries(index.keywords)) {
        if (keyword.toLowerCase().includes(kwLower)) {
          for (const sp of specialists) {
            const spInfo = index.specialists[sp];
            if (spInfo) {
              for (const f of spInfo.files.slice(0, 5)) {
                relevantFiles.add(f);
              }
            }
          }
        }
      }
    }

    // Load up to 10 relevant files
    const filesToLoad = [...relevantFiles].slice(0, 10);
    for (const file of filesToLoad) {
      try {
        const content = await readFileWithLineNumbers(join(rootPath, file));
        parts.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        // File not found
      }
    }
  } catch {
    logger.warn("Could not load global index for investigation");
  }

  return parts.join("\n\n");
}
