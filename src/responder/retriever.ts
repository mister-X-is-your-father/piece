import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalIndex } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface RetrievalResult {
  specialists: string[];
  scores: Map<string, number>;
}

// Common stop words to filter from questions
const STOP_WORDS = new Set([
  "の", "は", "が", "を", "に", "で", "と", "も", "か", "から", "まで", "より",
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "how", "what", "which", "who", "where", "when", "why",
  "this", "that", "these", "those", "it", "its",
  "and", "or", "but", "not", "no", "if", "then",
  "どう", "どの", "どこ", "なに", "いつ", "なぜ",
  "ている", "てる", "する", "した", "している",
]);

/**
 * Find relevant specialists for a question using keyword matching.
 * No vector DB — uses the _global-index.json for matching.
 */
export async function findRelevantSpecialists(
  question: string,
  scribePath: string,
  maxSpecialists: number = 3
): Promise<RetrievalResult> {
  const indexPath = join(scribePath, "_global-index.json");
  let index: GlobalIndex;

  try {
    const raw = await readFile(indexPath, "utf-8");
    index = JSON.parse(raw);
  } catch {
    logger.error("Could not load _global-index.json");
    return { specialists: [], scores: new Map() };
  }

  // Extract keywords from question
  const queryKeywords = extractKeywords(question);
  logger.debug(`Query keywords: ${queryKeywords.join(", ")}`);

  // Score each specialist
  const scores = new Map<string, number>();

  for (const [name, info] of Object.entries(index.specialists)) {
    let score = 0;

    for (const qk of queryKeywords) {
      const qkLower = qk.toLowerCase();

      // Match against specialist keywords
      for (const sk of info.keywords) {
        if (sk.toLowerCase().includes(qkLower) || qkLower.includes(sk.toLowerCase())) {
          score += 3;
        }
      }

      // Match against specialist description
      if (info.description.toLowerCase().includes(qkLower)) {
        score += 2;
      }

      // Match against file paths
      for (const file of info.files) {
        if (file.toLowerCase().includes(qkLower)) {
          score += 1;
        }
      }
    }

    // Check global keyword index
    for (const qk of queryKeywords) {
      const specialists = index.keywords[qk.toLowerCase()];
      if (specialists?.includes(name)) {
        score += 5;
      }
    }

    if (score > 0) {
      scores.set(name, score);
    }
  }

  // Sort by score descending, take top N
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSpecialists);

  const specialists = sorted.map(([name]) => name);

  logger.debug(
    `Specialist scores: ${sorted.map(([n, s]) => `${n}=${s}`).join(", ")}`
  );

  return { specialists, scores };
}

function extractKeywords(text: string): string[] {
  // Split on common delimiters
  const tokens = text
    .split(/[\s、。？！?!,.;:]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t.toLowerCase()));

  return [...new Set(tokens)];
}
