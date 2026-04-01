import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { manageQuestion } from "../agents/manager.js";
import { formatFactCheckReport } from "../agents/fact-checker.js";
import { runSingleAgent, type AgentTask } from "../agents/agent-runner.js";
import {
  KNOWLEDGE_EXTRACTOR_SYSTEM,
  buildKnowledgeExtractionPrompt,
} from "../agents/prompts/knowledge-extractor.js";
import { KnowledgeStore } from "../knowledge/knowledge-store.js";
import { MysteryStore } from "../knowledge/mystery-store.js";
import { closeKnowledgeDB, getKnowledgeDB } from "../knowledge/db.js";
import { learnConceptLink } from "../knowledge/neuron.js";
import { tokenizeQuery } from "../knowledge/tokenizer.js";
import type { ScribeMetadata } from "../config/schema.js";
import type { KnowledgeSearchResult } from "../knowledge/schemas.js";
import { logger } from "../utils/logger.js";

export interface AskOptions {
  config?: string;
  docs?: string;
  maxDocs?: number;
  skipFactCheck?: boolean;
  skipKnowledge?: boolean;
  verbose?: boolean;
}

export async function runAsk(
  targetPath: string,
  question: string,
  options: AskOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath, options.config);

  const scribePath = options.docs
    ? resolve(options.docs)
    : resolve(rootPath, config.output.directory);

  // Verify .scribe exists
  let metadata: ScribeMetadata;
  try {
    const raw = await readFile(resolve(scribePath, "scribe.json"), "utf-8");
    metadata = JSON.parse(raw);
  } catch {
    console.error(
      chalk.red(
        `No analysis found at ${scribePath}. Run 'piece analyze ${targetPath}' first.`
      )
    );
    process.exit(1);
  }

  console.log(chalk.gray(`Project: ${metadata.projectPath}`));
  console.log(chalk.gray(`Analyzed: ${metadata.analyzedAt}`));
  console.log(chalk.gray(`Specialists: ${metadata.specialists.join(", ")}`));
  console.log();

  const knowledgeEnabled =
    config.knowledge.enabled && !options.skipKnowledge;

  let knowledgeStore: KnowledgeStore | null = null;
  let mysteryStore: MysteryStore | null = null;

  if (knowledgeEnabled) {
    knowledgeStore = new KnowledgeStore(scribePath);
    mysteryStore = new MysteryStore(scribePath);
  }

  try {
    // === Phase 0: Check query cache & knowledge DB ===
    if (knowledgeStore) {
      // Check exact/similar query cache first
      const cached = knowledgeStore.findSimilarQuery(question);
      if (cached) {
        console.log(chalk.green("⚡ Cache hit — answering from past query\n"));
        console.log(chalk.cyan("━━━ Answer (cached) ━━━\n"));
        console.log(cached.answer);
        if (cached.investigation_method) {
          console.log(
            chalk.gray(`\nMethod: ${cached.investigation_method}`)
          );
        }
        console.log(
          chalk.gray(`\nCached: ${cached.created_at} | Hits: ${cached.hit_count + 1}`)
        );
        return;
      }

      // Prepare query vector for semantic search (async)
      await knowledgeStore.prepareQueryVector(question);

      // Check knowledge DB for sufficient knowledge (6 strategies)
      const knowledgeResults = knowledgeStore.searchForAnswer(question);
      const highConfidence = knowledgeResults.filter(
        (r) => r.node.confidence >= config.knowledge.knowledgeAnswerThreshold
      );

      if (highConfidence.length >= 3) {
        console.log(
          chalk.green(
            `📚 Answering from knowledge base (${highConfidence.length} relevant nodes)\n`
          )
        );
        displayKnowledgeAnswer(highConfidence);

        // Update access counts
        for (const r of highConfidence) {
          knowledgeStore.incrementAccessCount(r.node.id);
        }

        // Cache this query
        knowledgeStore.cacheQuery({
          question,
          answer: formatKnowledgeAsAnswer(highConfidence),
          specialists_consulted: [],
          fact_check_summary: null,
          investigation_method: "knowledge_db_direct",
          knowledge_node_ids: highConfidence.map((r) => r.node.id),
        });

        return;
      }

      if (knowledgeResults.length > 0) {
        console.log(
          chalk.yellow(
            `📚 Found ${knowledgeResults.length} related knowledge nodes (insufficient confidence, querying AI...)\n`
          )
        );
      }
    }

    // === Phase 1: Manager delegates to domain specialists ===
    const spinner = ora("Manager delegating to specialists...").start();

    let result;
    try {
      result = await manageQuestion(question, rootPath, scribePath, config);
      const consultedDisplay = result.specialistsConsulted
        .map((s) => `${s.name}(${s.role})`)
        .join(", ");
      spinner.succeed(`Consulted: ${consultedDisplay || "none"}`);
    } catch (err) {
      spinner.fail(`Query failed: ${err}`);
      throw err;
    }

    // Extract specialist names for backward compatibility
    const consultedSpecialistNames = result.specialistsConsulted.map((s) => s.name);

    // === Phase 2: Fact check already done per-specialist by Manager ===
    // Manager fact-checks each specialist response individually
    const factCheckReport = result.factCheckResults.length > 0
      ? result.factCheckResults[0].report // Use primary investigator's fact check
      : undefined;

    if (factCheckReport) {
      const { summary } = factCheckReport;
      console.log(
        chalk.gray(`  Fact check: ${summary.verified} verified, ${summary.partial} partial, ${summary.unverified} unverified`)
      );
    }

    // === Phase 3: Extract & save knowledge ===
    let nodesSaved = 0;
    if (knowledgeStore && config.knowledge.autoSaveKnowledge) {
      const spinner3 = ora("Extracting knowledge...").start();

      try {
        nodesSaved = await extractAndSaveKnowledge(
          question,
          result.answer,
          consultedSpecialistNames,
          knowledgeStore,
          config.knowledge.knowledgeExtractorModel,
          scribePath
        );
        spinner3.succeed(`Saved ${nodesSaved} knowledge nodes`);
      } catch (err) {
        spinner3.warn(`Knowledge extraction failed: ${err}`);
      }

      // Cache the query
      knowledgeStore.cacheQuery({
        question,
        answer: result.answer,
        specialists_consulted: consultedSpecialistNames,
        fact_check_summary: factCheckReport
          ? `${factCheckReport.summary.verified}v/${factCheckReport.summary.partial}p/${factCheckReport.summary.unverified}u`
          : null,
        investigation_method: `orchestrator → ${consultedSpecialistNames.join(", ")}`,
        knowledge_node_ids: [],
      });
    }

    // === Phase 4: Mystery detection ===
    let mysteriesCreated = 0;
    if (mysteryStore && config.knowledge.autoDetectMysteries) {
      mysteriesCreated = detectAndSaveMysteries(
        question,
        { answer: result.answer, specialistsConsulted: consultedSpecialistNames },
        factCheckReport,
        mysteryStore
      );
    }

    // === Phase 5: Display ===
    console.log(chalk.cyan("\n━━━ Answer ━━━\n"));
    console.log(result.answer);

    if (factCheckReport && factCheckReport.statements.length > 0) {
      console.log(chalk.cyan("\n━━━ Fact Check ━━━\n"));
      console.log(formatFactCheckReport(factCheckReport));
    }

    if (consultedSpecialistNames.length > 0) {
      console.log(
        chalk.gray(
          `\nSpecialists consulted: ${consultedSpecialistNames.join(", ")}`
        )
      );
    }

    // Knowledge growth summary
    if (nodesSaved > 0 || mysteriesCreated > 0) {
      const parts: string[] = [];
      if (nodesSaved > 0) parts.push(`${nodesSaved} knowledge nodes saved`);
      if (mysteriesCreated > 0)
        parts.push(`${mysteriesCreated} mysteries detected`);
      console.log(chalk.green(`\n🧠 Growth: ${parts.join(", ")}`));
    }
  } finally {
    closeKnowledgeDB();
  }
}

// --- Knowledge Extraction ---

async function extractAndSaveKnowledge(
  question: string,
  answer: string,
  specialistsConsulted: string[],
  store: KnowledgeStore,
  model: string,
  scribePath?: string
): Promise<number> {
  const task: AgentTask = {
    id: "knowledge-extractor",
    model,
    systemPrompt: KNOWLEDGE_EXTRACTOR_SYSTEM,
    userPrompt: buildKnowledgeExtractionPrompt(
      question,
      answer,
      specialistsConsulted
    ),
    maxTokens: 4096,
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
    logger.warn("Failed to parse knowledge extraction response");
    return 0;
  }

  const nodeIds: string[] = [];

  // Save nodes
  for (const nodeData of parsed.nodes || []) {
    const node = store.insertNode({
      content: nodeData.content,
      summary: nodeData.summary,
      node_type: nodeData.node_type || "fact",
      confidence: nodeData.confidence || 0.5,
      specialist: specialistsConsulted[0] || null,
      source_question: question,
      tags: nodeData.tags || [],
    });
    nodeIds.push(node.id);

    // Save citations
    for (const cit of nodeData.citations || []) {
      store.addCitation({
        node_id: node.id,
        file_path: cit.file_path,
        start_line: cit.start_line ?? null,
        end_line: cit.end_line ?? null,
        code_snippet: cit.code_snippet ?? null,
      });
    }
  }

  // Save connections between new nodes
  for (const conn of parsed.connections || []) {
    const fromId = nodeIds[conn.from_index];
    const toId = nodeIds[conn.to_index];
    if (fromId && toId) {
      store.linkNodes({
        source_id: fromId,
        target_id: toId,
        link_type: conn.link_type || "related",
        description: conn.description || null,
      });
    }
  }

  // Auto-link to existing related nodes
  for (const newId of nodeIds) {
    const newNode = store.getNode(newId);
    if (!newNode) continue;

    const related = store.searchNodes(newNode.summary, 3);
    for (const r of related) {
      if (r.node.id !== newId) {
        store.linkNodes({
          source_id: newId,
          target_id: r.node.id,
          link_type: "related",
          description: "Auto-linked by keyword similarity",
        });
      }
    }
  }

  // --- Auto-grow concept mesh ---
  if (scribePath) {
    const db = getKnowledgeDB(scribePath);
    autoGrowConceptMesh(db, question, answer, nodeIds, store);
  }

  // --- Hebbian learning: co-accessed nodes strengthen links ---
  if (nodeIds.length >= 2) {
    store.recordCoAccess(nodeIds);
  }

  return nodeIds.length;
}

// --- Concept Mesh Auto-Growth ---

/**
 * Automatically learn concept links from question + answer pairs.
 *
 * Strategy:
 * 1. Extract terms from question and answer
 * 2. Terms that appear in both → strong co-occurrence link
 * 3. Tags from created nodes → link to question terms
 * 4. Cross-language pairs (Japanese term in question, English in answer) → bilingual link
 */
function autoGrowConceptMesh(
  db: Parameters<typeof learnConceptLink>[0],
  question: string,
  answer: string,
  nodeIds: string[],
  store: KnowledgeStore
): void {
  try {
    const { originalTerms: questionTerms } = tokenizeQuery(question);
    const { originalTerms: answerTerms } = tokenizeQuery(answer);

    // 1. Question terms × Answer terms co-occurrence
    // (Terms appearing in both question context and answer context are related)
    for (const qt of questionTerms) {
      for (const at of answerTerms) {
        if (qt === at) continue;
        if (qt.length < 2 || at.length < 2) continue;
        // Only learn cross-script pairs (JP↔EN) or semantically distinct terms
        const qtIsJp = /[\u3040-\u9fff]/.test(qt);
        const atIsJp = /[\u3040-\u9fff]/.test(at);
        if (qtIsJp !== atIsJp) {
          // Cross-language pair — high value
          learnConceptLink(db, qt, at, "co_occurrence");
        }
      }
    }

    // 2. Tags from new nodes → link to question terms
    for (const nodeId of nodeIds) {
      const tags = store.getNodeTags(nodeId);
      for (const tag of tags) {
        for (const qt of questionTerms) {
          if (tag.toLowerCase() === qt.toLowerCase()) continue;
          if (tag.length < 2 || qt.length < 2) continue;
          learnConceptLink(db, qt, tag, "co_occurrence");
        }
      }
    }

    // 3. Inter-tag links (tags that co-occur in the same answer context)
    const allTags = new Set<string>();
    for (const nodeId of nodeIds) {
      for (const tag of store.getNodeTags(nodeId)) {
        allTags.add(tag.toLowerCase());
      }
    }
    const tagList = [...allTags];
    for (let i = 0; i < tagList.length; i++) {
      for (let j = i + 1; j < tagList.length; j++) {
        learnConceptLink(db, tagList[i], tagList[j], "co_occurrence");
      }
    }

    logger.debug(
      `Concept mesh growth: ${questionTerms.length} question terms × ${answerTerms.length} answer terms, ${allTags.size} tags`
    );
  } catch (err) {
    logger.debug(`Concept mesh growth failed: ${err}`);
  }
}

// --- Mystery Detection ---

function detectAndSaveMysteries(
  question: string,
  result: { answer: string; specialistsConsulted: string[] },
  factCheckReport: { statements: Array<{ statement: string; result: string }> } | undefined,
  store: MysteryStore
): number {
  let count = 0;

  // From unverified fact-check statements
  if (factCheckReport) {
    for (const stmt of factCheckReport.statements) {
      if (stmt.result === "unverified") {
        store.insertMystery({
          title: `Unverified: ${stmt.statement.slice(0, 80)}`,
          description: `Fact check could not verify: "${stmt.statement}"`,
          context: `Question: ${question}`,
          priority: 6,
          specialist: result.specialistsConsulted[0] || null,
          source: "fact_check",
        });
        count++;
      }
    }
  }

  // If no specialists could answer
  if (result.specialistsConsulted.length === 0) {
    store.insertMystery({
      title: `No specialist for: ${question.slice(0, 80)}`,
      description: `No specialist could handle this question. The knowledge gap may indicate a missing analysis domain.`,
      context: `Question: ${question}`,
      priority: 7,
      specialist: null,
      source: "ask",
    });
    count++;
  }

  return count;
}

// --- Knowledge Display ---

function displayKnowledgeAnswer(results: KnowledgeSearchResult[]): void {
  console.log(chalk.cyan("━━━ Answer (from Knowledge DB) ━━━\n"));

  for (const r of results) {
    const badge =
      r.node.confidence >= 0.8
        ? chalk.green("HIGH")
        : r.node.confidence >= 0.5
          ? chalk.yellow("MED")
          : chalk.red("LOW");

    console.log(`  ${badge} ${r.node.summary}`);
    console.log(chalk.gray(`     ${r.node.content.slice(0, 200)}...`));

    for (const cit of r.citations) {
      const loc = cit.end_line
        ? `${cit.file_path}:L${cit.start_line}-L${cit.end_line}`
        : `${cit.file_path}:L${cit.start_line}`;
      console.log(chalk.gray(`     📎 ${loc}`));
      if (cit.code_snippet) {
        const lines = cit.code_snippet.split("\n").slice(0, 2);
        for (const line of lines) {
          console.log(chalk.gray(`     > ${line}`));
        }
      }
    }
    console.log();
  }
}

function formatKnowledgeAsAnswer(results: KnowledgeSearchResult[]): string {
  return results
    .map((r) => `[${r.node.node_type}] ${r.node.summary}\n${r.node.content}`)
    .join("\n\n---\n\n");
}
