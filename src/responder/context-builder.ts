import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens, truncateToTokenBudget } from "../claude/token-counter.js";
import { logger } from "../utils/logger.js";

export interface SpecialistContext {
  name: string;
  overview: string;
  fileDocs: Array<{ name: string; content: string }>;
  totalTokens: number;
}

/**
 * Build the context for a specialist to answer a question.
 * Loads the specialist's documentation within the token budget.
 */
export async function buildSpecialistContext(
  scribePath: string,
  specialistName: string,
  maxTokens: number = 100000
): Promise<SpecialistContext> {
  const specialistDir = join(scribePath, "specialists", specialistName);
  const fileDocs: Array<{ name: string; content: string }> = [];
  let overview = "";

  // Load overview first (highest priority)
  try {
    overview = await readFile(join(specialistDir, "overview.md"), "utf-8");
  } catch {
    logger.warn(`No overview for specialist ${specialistName}`);
  }

  let tokenCount = estimateTokens(overview);

  // Load file-level docs
  try {
    const { default: fg } = await import("fast-glob");
    const docFiles = await fg("files/*.md", {
      cwd: specialistDir,
      absolute: false,
    });

    for (const docFile of docFiles.sort()) {
      const content = await readFile(
        join(specialistDir, "files", docFile),
        "utf-8"
      );
      const tokens = estimateTokens(content);

      if (tokenCount + tokens > maxTokens) {
        logger.debug(
          `Token budget reached for ${specialistName}, skipping remaining docs`
        );
        break;
      }

      fileDocs.push({ name: docFile, content });
      tokenCount += tokens;
    }
  } catch {
    // No file docs
  }

  return {
    name: specialistName,
    overview,
    fileDocs,
    totalTokens: tokenCount,
  };
}
