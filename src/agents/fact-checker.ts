import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScribeConfig, VerifiedStatement } from "../config/schema.js";
import { parseCitations, verifyCitation } from "../utils/citation.js";
import {
  FACT_CHECKER_SYSTEM,
  buildFactCheckPrompt,
} from "./prompts/fact-checker.js";
import { runSingleAgent, type AgentTask } from "./agent-runner.js";
import { readLines } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

export interface FactCheckReport {
  statements: VerifiedStatement[];
  summary: {
    verified: number;
    partial: number;
    unverified: number;
    total: number;
  };
}

/**
 * Fact-check an answer against actual source code.
 *
 * Process:
 * 1. Extract all citations from the answer
 * 2. Load referenced source code files
 * 3. Ask Fact Checker agent to verify each statement
 * 4. Additionally verify citations programmatically (line existence)
 */
export async function factCheckAnswer(
  answer: string,
  rootPath: string,
  scribePath: string,
  config: ScribeConfig
): Promise<FactCheckReport> {
  if (!config.factCheck.enabled) {
    return {
      statements: [],
      summary: { verified: 0, partial: 0, unverified: 0, total: 0 },
    };
  }

  logger.info("Running fact check on answer...");

  // Step 1: Extract all citations from the answer and specialist docs
  const citations = extractAllCitations(answer);
  logger.debug(`Found ${citations.size} unique files referenced`);

  // Step 2: Load referenced source files with line numbers
  const sourceFiles: Array<{ path: string; content: string }> = [];
  for (const filePath of citations) {
    try {
      const content = await readFile(join(rootPath, filePath), "utf-8");
      const numbered = content
        .split("\n")
        .map((line, i) => `${i + 1}\t${line}`)
        .join("\n");
      sourceFiles.push({ path: filePath, content: numbered });
    } catch {
      logger.warn(`Referenced file not found: ${filePath}`);
    }
  }

  if (sourceFiles.length === 0) {
    logger.warn("No source files could be loaded for fact checking");
    return {
      statements: [],
      summary: { verified: 0, partial: 0, unverified: 0, total: 0 },
    };
  }

  // Step 3: Run AI-based fact check
  const task: AgentTask = {
    id: "fact-checker",
    model: config.agents.factCheckModel,
    systemPrompt: FACT_CHECKER_SYSTEM,
    userPrompt: buildFactCheckPrompt(answer, sourceFiles),
    maxTokens: 4096,
  };

  const result = await runSingleAgent(task);

  let statements: VerifiedStatement[];
  try {
    const jsonStr = result.response.content
      .replace(/```json?\n?/g, "")
      .replace(/```/g, "")
      .trim();
    statements = JSON.parse(jsonStr) as VerifiedStatement[];
  } catch {
    logger.warn("Failed to parse fact checker response");
    statements = [];
  }

  // Step 4: Programmatic citation verification (double-check)
  if (config.factCheck.verifyLineContent) {
    statements = await programmaticVerify(statements, rootPath);
  }

  const summary = {
    verified: statements.filter((s) => s.result === "verified").length,
    partial: statements.filter((s) => s.result === "partial").length,
    unverified: statements.filter((s) => s.result === "unverified").length,
    total: statements.length,
  };

  logger.info(
    `Fact check complete: ${summary.verified} verified, ${summary.partial} partial, ${summary.unverified} unverified`
  );

  return { statements, summary };
}

/**
 * Extract unique file paths from all citation formats in the text.
 * Supports multiple formats:
 *   - [source:path:Lx]
 *   - `src/path/file.ts`
 *   - src/path/file.ts (plain text file paths)
 *   - path/to/File.ts:123 (with line numbers)
 */
function extractAllCitations(text: string): Set<string> {
  const files = new Set<string>();

  // [source:path:Lx] format
  const sourceRegex = /\[source:([^:]+):L\d+/g;
  let match: RegExpExecArray | null;
  while ((match = sourceRegex.exec(text)) !== null) {
    files.add(match[1]);
  }

  // Backtick-quoted file paths: `src/foo/bar.ts`
  const backtickRegex = /`((?:src|lib|packages)\/[\w\-./]+\.(?:ts|js|tsx|jsx))`/g;
  while ((match = backtickRegex.exec(text)) !== null) {
    files.add(match[1]);
  }

  // Plain text file paths: src/foo/bar.ts or src/foo/bar.ts:123
  const plainRegex = /(?:^|\s)((?:src|lib|packages)\/[\w\-./]+\.(?:ts|js|tsx|jsx))(?::\d+)?/gm;
  while ((match = plainRegex.exec(text)) !== null) {
    files.add(match[1]);
  }

  // Bold/markdown paths: **`src/foo.ts`** or *src/foo.ts*
  const mdRegex = /\*{1,2}`?((?:src|lib|packages)\/[\w\-./]+\.(?:ts|js|tsx|jsx))`?\*{1,2}/g;
  while ((match = mdRegex.exec(text)) !== null) {
    files.add(match[1]);
  }

  return files;
}

/**
 * Programmatically verify that cited code lines actually exist.
 * This catches cases where the AI fact checker might be lenient.
 */
async function programmaticVerify(
  statements: VerifiedStatement[],
  rootPath: string
): Promise<VerifiedStatement[]> {
  return Promise.all(
    statements.map(async (stmt) => {
      if (!stmt.citation) return stmt;

      const verification = await verifyCitation(rootPath, stmt.citation);

      // Downgrade AI verification if programmatic check fails
      if (verification.result === "unverified" && stmt.result === "verified") {
        return {
          ...stmt,
          result: "partial" as const,
          reason: `${stmt.reason ?? ""} [Programmatic check: ${verification.reason}]`.trim(),
        };
      }

      // Attach code snippet if not already present
      if (!stmt.codeSnippet && verification.snippet) {
        return { ...stmt, codeSnippet: verification.snippet };
      }

      return stmt;
    })
  );
}

/**
 * Format fact check report for terminal display.
 */
export function formatFactCheckReport(report: FactCheckReport): string {
  const lines: string[] = [];

  for (const stmt of report.statements) {
    const badge =
      stmt.result === "verified"
        ? "VERIFIED"
        : stmt.result === "partial"
          ? "PARTIAL"
          : "UNVERIFIED";

    lines.push(`  ${badge} ${stmt.statement}`);

    if (stmt.citation) {
      const loc = stmt.citation.endLine
        ? `${stmt.citation.file}:L${stmt.citation.startLine}-L${stmt.citation.endLine}`
        : `${stmt.citation.file}:L${stmt.citation.startLine}`;
      lines.push(`     ${loc}`);
    }

    if (stmt.codeSnippet) {
      const snippetLines = stmt.codeSnippet.split("\n").slice(0, 3);
      for (const sl of snippetLines) {
        lines.push(`     > ${sl}`);
      }
    }

    lines.push("");
  }

  const { summary } = report;
  lines.push(
    `Sources: ${summary.verified} verified, ${summary.partial} partial, ${summary.unverified} unverified`
  );

  return lines.join("\n");
}
