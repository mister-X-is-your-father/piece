import { resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { getKnowledgeDB, closeKnowledgeDB } from "../knowledge/db.js";
import {
  FeedbackStore,
  analyzeFeedback,
} from "../knowledge/feedback.js";
import { logger } from "../utils/logger.js";

export interface FeedbackOptions {
  rating?: number;
  text?: string;
  queryId?: string;
  list?: boolean;
  rules?: boolean;
  stats?: boolean;
  verbose?: boolean;
}

export async function runFeedback(
  targetPath: string,
  options: FeedbackOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);
  const db = getKnowledgeDB(scribePath);
  const store = new FeedbackStore(db);

  try {
    // List feedback history
    if (options.list) {
      const events = store.listFeedback();
      console.log(chalk.cyan("━━━ Feedback History ━━━\n"));
      if (events.length === 0) {
        console.log(chalk.gray("  No feedback yet."));
        return;
      }
      for (const e of events) {
        const stars = "★".repeat(e.rating) + "☆".repeat(5 - e.rating);
        console.log(`  ${stars} ${e.question.slice(0, 60)}`);
        if (e.feedback_text) {
          console.log(chalk.gray(`    "${e.feedback_text.slice(0, 80)}"`));
        }
        console.log(chalk.gray(`    ${e.created_at}`));
        console.log();
      }
      return;
    }

    // List learned rules
    if (options.rules) {
      const rules = store.listRules();
      console.log(chalk.cyan("━━━ Learned Rules ━━━\n"));
      if (rules.length === 0) {
        console.log(chalk.gray("  No rules learned yet."));
        return;
      }
      for (const r of rules) {
        const strength = "█".repeat(Math.round(r.strength)) + "░".repeat(5 - Math.round(r.strength));
        console.log(`  [${r.rule_type}] ${strength} (applied ${r.applied_count}x)`);
        console.log(`    IF: ${r.condition_text}`);
        console.log(`    THEN: ${r.action_text}`);
        console.log();
      }
      return;
    }

    // Stats
    if (options.stats) {
      const stats = store.getStats();
      console.log(chalk.cyan("━━━ Feedback Stats ━━━\n"));
      console.log(`  Total feedback: ${stats.totalFeedback}`);
      console.log(`  Average rating: ${stats.avgRating.toFixed(1)}/5`);
      console.log(`  Learned rules: ${stats.rulesCount}`);
      console.log(`  Nodes corrected: ${stats.nodesUpdated}`);
      if (stats.improvementRate !== 0) {
        const direction = stats.improvementRate > 0 ? chalk.green("↑") : chalk.red("↓");
        console.log(`  Improvement trend: ${direction} ${Math.abs(stats.improvementRate).toFixed(2)}`);
      }
      return;
    }

    // Submit feedback
    if (!options.rating) {
      console.error(chalk.red("--rating (1-5) is required to submit feedback"));
      return;
    }

    // Find the most recent query
    let question: string;
    let answer: string;
    let queryCacheId: string | null = null;

    if (options.queryId) {
      const cached = db
        .prepare("SELECT * FROM query_cache WHERE id = ?")
        .get(options.queryId) as { id: string; question: string; answer: string } | undefined;
      if (!cached) {
        console.error(chalk.red(`Query not found: ${options.queryId}`));
        return;
      }
      question = cached.question;
      answer = cached.answer;
      queryCacheId = cached.id;
    } else {
      // Get most recent query
      const recent = db
        .prepare("SELECT * FROM query_cache ORDER BY created_at DESC LIMIT 1")
        .get() as { id: string; question: string; answer: string } | undefined;
      if (!recent) {
        console.error(chalk.red("No previous queries found. Run 'piece ask' first."));
        return;
      }
      question = recent.question;
      answer = recent.answer;
      queryCacheId = recent.id;
    }

    // Record feedback
    const event = store.recordFeedback({
      question,
      answer,
      rating: options.rating,
      text: options.text,
      queryCacheId: queryCacheId ?? undefined,
    });

    console.log(chalk.cyan(`Feedback recorded (rating: ${options.rating}/5)`));

    // If rating is low, run analysis
    if (options.rating <= 3 && (options.text || options.rating <= 2)) {
      const spinner = ora("Analyzing feedback...").start();

      try {
        // Get related node summaries
        const nodes = db
          .prepare(
            `SELECT DISTINCT kn.id, kn.summary FROM knowledge_nodes kn
             JOIN node_tags nt ON nt.node_id = kn.id
             ORDER BY kn.access_count DESC LIMIT 10`
          )
          .all() as Array<{ id: string; summary: string }>;

        const analysis = await analyzeFeedback(
          question,
          answer,
          options.text || `Rating: ${options.rating}/5 — answer was inadequate`,
          options.rating,
          nodes.map((n) => `[${n.id.slice(0, 8)}] ${n.summary}`),
          config.knowledge.knowledgeExtractorModel
        );

        spinner.text = "Applying corrections...";

        const result = store.applyAnalysis(event.id, analysis);

        spinner.succeed("Feedback applied");

        // Display what changed
        console.log(chalk.cyan("\n━━━ Changes Applied ━━━\n"));
        console.log(`  Root cause: ${chalk.yellow(analysis.diagnosis.root_cause)}`);
        console.log(`  ${analysis.diagnosis.explanation}`);

        if (result.nodesUpdated > 0) {
          console.log(chalk.red(`  Nodes confidence adjusted: ${result.nodesUpdated}`));
        }
        if (result.nodesCreated > 0) {
          console.log(chalk.green(`  Correction nodes created: ${result.nodesCreated}`));
        }
        if (result.linksAdjusted > 0) {
          console.log(chalk.yellow(`  Links weight adjusted: ${result.linksAdjusted}`));
        }
        if (result.rulesCreated > 0) {
          console.log(chalk.blue(`  New rules learned: ${result.rulesCreated}`));
        }
        if (result.cachesInvalidated > 0) {
          console.log(chalk.red(`  Wrong caches deleted: ${result.cachesInvalidated}`));
        }
      } catch (err) {
        spinner.fail(`Analysis failed: ${err}`);
      }
    }
  } finally {
    closeKnowledgeDB();
  }
}
