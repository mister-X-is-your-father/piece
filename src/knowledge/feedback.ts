/**
 * Feedback Evolution System
 *
 * フィードバックを完全に自分の進化に変える。
 * コンテキストに依存しない形で、仕組みに落とし込む。
 *
 * Flow:
 *   1. ユーザーがフィードバック送信（rating + text）
 *   2. Feedback Analyzer AIが原因分析
 *   3. 分析結果を自動適用（confidence/weight/rules/cache）
 *   4. 次回のaskで自動的に改善された回答
 */

import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { runSingleAgent, type AgentTask } from "../agents/agent-runner.js";
import {
  FEEDBACK_ANALYZER_SYSTEM,
  buildFeedbackAnalysisPrompt,
} from "../agents/prompts/feedback-analyzer.js";
import { learnConceptLink } from "./neuron.js";
import { logger } from "../utils/logger.js";

// --- Types ---

export interface FeedbackEvent {
  id: string;
  query_cache_id: string | null;
  question: string;
  answer_summary: string;
  rating: number;
  feedback_text: string | null;
  created_at: string;
}

export interface LearnedRule {
  id: string;
  rule_type: string;
  condition_text: string;
  action_text: string;
  strength: number;
  applied_count: number;
  created_at: string;
}

// --- Confidence Multipliers ---

const VERDICT_MULTIPLIERS: Record<string, number> = {
  incorrect: 0.3,
  misleading: 0.7,
  outdated: 0.5,
  incomplete: 0.9,
  correct: 1.2,
};

// --- FeedbackStore ---

export class FeedbackStore {
  constructor(private db: Database.Database) {}

  // --- Record Feedback ---

  recordFeedback(input: {
    question: string;
    answer: string;
    rating: number;
    text?: string;
    queryCacheId?: string;
  }): FeedbackEvent {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO feedback_events (id, query_cache_id, question, answer_summary, rating, feedback_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.queryCacheId ?? null, input.question, input.answer.slice(0, 500), input.rating, input.text ?? null);

    return this.db.prepare("SELECT * FROM feedback_events WHERE id = ?").get(id) as FeedbackEvent;
  }

  // --- Apply Analysis Results ---

  applyAnalysis(
    feedbackEventId: string,
    analysis: FeedbackAnalysis
  ): ApplyResult {
    const result: ApplyResult = {
      nodesUpdated: 0,
      nodesCreated: 0,
      linksAdjusted: 0,
      rulesCreated: 0,
      cachesInvalidated: 0,
    };

    // 1. Apply node corrections
    for (const correction of analysis.corrections) {
      switch (correction.type) {
        case "update_node": {
          // Find node by summary match
          const node = this.db
            .prepare("SELECT id, confidence FROM knowledge_nodes WHERE summary LIKE ? LIMIT 1")
            .get(`%${correction.node_summary}%`) as { id: string; confidence: number } | undefined;

          if (node) {
            const newConf = correction.new_confidence ?? node.confidence * 0.5;

            // Record node feedback
            this.db
              .prepare(
                `INSERT INTO node_feedback (id, feedback_event_id, node_id, verdict, correction, before_confidence, after_confidence)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              .run(generateId(), feedbackEventId, node.id, "incorrect", correction.new_content ?? null, node.confidence, newConf);

            // Update confidence
            this.db
              .prepare("UPDATE knowledge_nodes SET confidence = ?, updated_at = datetime('now') WHERE id = ?")
              .run(newConf, node.id);

            // Reverse Hebbian: weaken links from this node
            this.db
              .prepare(
                `UPDATE node_links SET weight = MAX(weight * 0.5, 0.1)
                 WHERE source_id = ? OR target_id = ?`
              )
              .run(node.id, node.id);

            result.nodesUpdated++;
            result.linksAdjusted++;
          }
          break;
        }

        case "create_node": {
          const nodeId = generateId();
          this.db
            .prepare(
              `INSERT INTO knowledge_nodes (id, content, summary, node_type, confidence, source_question)
               VALUES (?, ?, ?, 'resolution', ?, ?)`
            )
            .run(nodeId, correction.content, correction.summary, correction.confidence ?? 0.8, `feedback:${feedbackEventId}`);

          // Add tags
          for (const tag of correction.tags ?? []) {
            this.db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(nodeId, tag);
          }

          result.nodesCreated++;
          break;
        }

        case "concept_correction": {
          if (correction.action === "weaken") {
            this.db
              .prepare(
                `UPDATE concept_links SET weight = MAX(weight * 0.5, 0.1), updated_at = datetime('now')
                 WHERE (term_a = ? AND term_b = ?) OR (term_a = ? AND term_b = ?)`
              )
              .run(correction.term_a, correction.term_b, correction.term_b, correction.term_a);
          } else if (correction.action === "strengthen") {
            if (correction.term_a && correction.term_b) {
              learnConceptLink(this.db, correction.term_a, correction.term_b, "extraction");
            }
          }
          result.linksAdjusted++;
          break;
        }

        case "invalidate_cache": {
          // Delete the cached answer that was wrong
          const feedbackEvent = this.db
            .prepare("SELECT query_cache_id FROM feedback_events WHERE id = ?")
            .get(feedbackEventId) as { query_cache_id: string | null } | undefined;

          if (feedbackEvent?.query_cache_id) {
            this.db.prepare("DELETE FROM query_cache WHERE id = ?").run(feedbackEvent.query_cache_id);
            result.cachesInvalidated++;
          }
          break;
        }
      }
    }

    // 2. Apply affected node verdicts
    for (const affected of analysis.diagnosis.affected_nodes) {
      if (!affected.node_id) continue;

      const node = this.db
        .prepare("SELECT id, confidence FROM knowledge_nodes WHERE id = ?")
        .get(affected.node_id) as { id: string; confidence: number } | undefined;

      if (node) {
        const multiplier = VERDICT_MULTIPLIERS[affected.verdict] ?? 0.7;
        const newConf = Math.min(node.confidence * multiplier, 1.0);

        this.db
          .prepare(
            `INSERT INTO node_feedback (id, feedback_event_id, node_id, verdict, correction, before_confidence, after_confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(generateId(), feedbackEventId, node.id, affected.verdict, affected.reason, node.confidence, newConf);

        this.db
          .prepare("UPDATE knowledge_nodes SET confidence = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newConf, node.id);

        result.nodesUpdated++;
      }
    }

    // 3. Store learned rules
    for (const rule of analysis.learned_rules) {
      // Check if similar rule exists
      const existing = this.db
        .prepare("SELECT id, strength FROM learned_rules WHERE condition_text = ? AND rule_type = ?")
        .get(rule.condition, rule.rule_type) as { id: string; strength: number } | undefined;

      if (existing) {
        // Strengthen existing rule
        this.db
          .prepare("UPDATE learned_rules SET strength = MIN(strength + 0.5, 5.0), updated_at = datetime('now') WHERE id = ?")
          .run(existing.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO learned_rules (id, rule_type, condition_text, action_text, strength)
             VALUES (?, ?, ?, ?, 1.0)`
          )
          .run(generateId(), rule.rule_type, rule.condition, rule.action);
        result.rulesCreated++;
      }
    }

    // 4. Record strategy performance (unhelpful strategies from search_issues)
    for (const issue of analysis.diagnosis.search_issues) {
      this.db
        .prepare(
          `INSERT INTO strategy_performance (id, feedback_event_id, strategy_name, contributed_node_ids, was_helpful)
           VALUES (?, ?, ?, '[]', 0)`
        )
        .run(generateId(), feedbackEventId, issue.strategy);
    }

    // 5. Record helpful strategies (for positive feedback, rating >= 4)
    const feedbackEvent = this.db
      .prepare("SELECT rating FROM feedback_events WHERE id = ?")
      .get(feedbackEventId) as { rating: number } | undefined;

    if (feedbackEvent && feedbackEvent.rating >= 4) {
      // All strategies that contributed nodes are considered helpful
      const helpfulStrategies = new Set<string>();
      for (const correction of analysis.corrections) {
        if (correction.type === "update_node" || correction.type === "create_node") {
          // These are corrections, not helpful — skip
        }
      }
      // If no issues were reported, mark all known strategies as helpful
      const issueStrategies = new Set(analysis.diagnosis.search_issues.map((i) => i.strategy));
      for (const strategyName of ["synapse", "structural", "temporal", "graph_walk", "tag_cluster", "vector"]) {
        if (!issueStrategies.has(strategyName)) {
          helpfulStrategies.add(strategyName);
        }
      }
      for (const strategyName of helpfulStrategies) {
        this.db
          .prepare(
            `INSERT INTO strategy_performance (id, feedback_event_id, strategy_name, contributed_node_ids, was_helpful)
             VALUES (?, ?, ?, '[]', 1)`
          )
          .run(generateId(), feedbackEventId, strategyName);
      }
    }

    return result;
  }

  // --- Query Methods ---

  listFeedback(limit: number = 20): FeedbackEvent[] {
    return this.db
      .prepare("SELECT * FROM feedback_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as FeedbackEvent[];
  }

  listRules(): LearnedRule[] {
    return this.db
      .prepare("SELECT * FROM learned_rules ORDER BY strength DESC, applied_count DESC")
      .all() as LearnedRule[];
  }

  getStats(): {
    totalFeedback: number;
    avgRating: number;
    rulesCount: number;
    nodesUpdated: number;
    improvementRate: number;
  } {
    const feedback = this.db
      .prepare("SELECT COUNT(*) as count, AVG(rating) as avg FROM feedback_events")
      .get() as { count: number; avg: number | null };

    const rules = (this.db
      .prepare("SELECT COUNT(*) as c FROM learned_rules")
      .get() as { c: number }).c;

    const nodesUpdated = (this.db
      .prepare("SELECT COUNT(DISTINCT node_id) as c FROM node_feedback")
      .get() as { c: number }).c;

    // Improvement: compare avg rating of first half vs second half
    const all = this.db
      .prepare("SELECT rating FROM feedback_events ORDER BY created_at")
      .all() as Array<{ rating: number }>;

    let improvementRate = 0;
    if (all.length >= 4) {
      const mid = Math.floor(all.length / 2);
      const firstHalf = all.slice(0, mid).reduce((s, r) => s + r.rating, 0) / mid;
      const secondHalf = all.slice(mid).reduce((s, r) => s + r.rating, 0) / (all.length - mid);
      improvementRate = secondHalf - firstHalf;
    }

    return {
      totalFeedback: feedback.count,
      avgRating: feedback.avg ?? 0,
      rulesCount: rules,
      nodesUpdated,
      improvementRate,
    };
  }

  /**
   * Get learned rules applicable to a search context.
   * Called during searchForAnswer to apply rules.
   */
  getApplicableRules(question: string): LearnedRule[] {
    // Get all active rules and check condition match
    const rules = this.db
      .prepare("SELECT * FROM learned_rules WHERE strength >= 0.5 ORDER BY strength DESC")
      .all() as LearnedRule[];

    const questionLower = question.toLowerCase();
    return rules.filter((r) => {
      // Simple keyword match on condition
      const keywords = r.condition_text.toLowerCase().split(/[\s、。]+/).filter(w => w.length > 1);
      return keywords.some((kw) => questionLower.includes(kw));
    });
  }

  /**
   * Mark a rule as applied (increment counter).
   */
  markRuleApplied(ruleId: string): void {
    this.db
      .prepare("UPDATE learned_rules SET applied_count = applied_count + 1, updated_at = datetime('now') WHERE id = ?")
      .run(ruleId);
  }
}

// --- Feedback Analysis (AI-powered) ---

export interface FeedbackAnalysis {
  diagnosis: {
    root_cause: string;
    explanation: string;
    severity: number;
    affected_nodes: Array<{
      node_id: string | null;
      node_summary: string;
      verdict: string;
      reason: string;
    }>;
    search_issues: Array<{
      strategy: string;
      issue: string;
    }>;
  };
  corrections: Array<{
    type: string;
    node_summary?: string;
    new_content?: string;
    new_confidence?: number;
    summary?: string;
    content?: string;
    confidence?: number;
    tags?: string[];
    term_a?: string;
    term_b?: string;
    action?: string;
    reason?: string;
  }>;
  learned_rules: Array<{
    rule_type: string;
    condition: string;
    action: string;
  }>;
}

export interface ApplyResult {
  nodesUpdated: number;
  nodesCreated: number;
  linksAdjusted: number;
  rulesCreated: number;
  cachesInvalidated: number;
}

export async function analyzeFeedback(
  question: string,
  answer: string,
  feedbackText: string,
  rating: number,
  relatedNodeSummaries: string[],
  model: string
): Promise<FeedbackAnalysis> {
  const task: AgentTask = {
    id: "feedback-analyzer",
    model,
    systemPrompt: FEEDBACK_ANALYZER_SYSTEM,
    userPrompt: buildFeedbackAnalysisPrompt(
      question,
      answer,
      feedbackText,
      rating,
      relatedNodeSummaries
    ),
    maxTokens: 4096,
  };

  const result = await runSingleAgent(task);

  try {
    const jsonStr = result.response.content
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse feedback analysis");
  }
}
