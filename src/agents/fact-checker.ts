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

  // Fallback: if no citations extracted, load key files from specialist docs
  if (sourceFiles.length === 0) {
    logger.info("No citations in answer. Fallback: loading key files from specialist docs...");
    const fallbackFiles = await extractFilesFromSpecialistDocs(answer, rootPath, scribePath);
    for (const f of fallbackFiles) {
      sourceFiles.push(f);
    }
  }

  // Truncate source files to limit token budget (speed optimization)
  const MAX_LINES_PER_FILE = 200;
  for (const sf of sourceFiles) {
    const lines = sf.content.split("\n");
    if (lines.length > MAX_LINES_PER_FILE) {
      sf.content = lines.slice(0, MAX_LINES_PER_FILE).join("\n") + "\n[... truncated]";
    }
  }

  if (sourceFiles.length === 0) {
    logger.warn("No source files could be loaded for fact checking (even with fallback)");
    return {
      statements: [],
      summary: { verified: 0, partial: 0, unverified: 0, total: 0 },
    };
  }

  // Step 3: Fast programmatic verification first (no AI needed)
  // Extract all [source:path:Lx] citations and verify file/line existence
  const programmaticStatements = await fastProgrammaticCheck(answer, rootPath);

  // Step 4: AI-based fact check only if programmatic check found few citations
  // AND we have source files loaded. Skip AI if programmatic check covered enough.
  let statements: VerifiedStatement[];

  if (programmaticStatements.length >= 3) {
    // Programmatic check found enough citations — use those, skip expensive AI call
    logger.info(`Fast programmatic check: ${programmaticStatements.length} statements verified without AI`);
    statements = programmaticStatements;
  } else {
    // Fall back to AI-based fact check (slower but more thorough)
    logger.info("Running AI-based fact check (programmatic check insufficient)...");
    const task: AgentTask = {
      id: "fact-checker",
      model: config.agents.factCheckModel,
      systemPrompt: FACT_CHECKER_SYSTEM,
      userPrompt: buildFactCheckPrompt(answer, sourceFiles),
      maxTokens: 4096,
    };

    const result = await runSingleAgent(task);

    try {
      const jsonStr = result.response.content
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      statements = JSON.parse(jsonStr) as VerifiedStatement[];
    } catch {
      logger.warn("Failed to parse fact checker response");
      statements = programmaticStatements; // Use programmatic results as fallback
    }

    // Additional programmatic verification on AI results
    if (config.factCheck.verifyLineContent) {
      statements = await programmaticVerify(statements, rootPath);
    }
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
 * Fast programmatic fact check — no AI call needed.
 * Extracts [source:path:Lx] citations from the answer and verifies:
 *   1. Does the file exist?
 *   2. Does the line number exist?
 *   3. Does the cited line contain relevant content?
 * Returns verified/unverified statements instantly.
 */
async function fastProgrammaticCheck(
  answer: string,
  rootPath: string
): Promise<VerifiedStatement[]> {
  const statements: VerifiedStatement[] = [];

  // Extract all [source:path:Lx] or [source:path:Lx-Ly] citations
  const citationRegex = /\[source:([^:\]]+):L(\d+)(?:-L?(\d+))?\]/g;
  let match;

  while ((match = citationRegex.exec(answer)) !== null) {
    const filePath = match[1];
    const startLine = parseInt(match[2]);
    const endLine = match[3] ? parseInt(match[3]) : startLine;

    // Find the statement this citation belongs to (text before the citation on same line)
    const lineStart = answer.lastIndexOf("\n", match.index) + 1;
    const statementText = answer.slice(lineStart, match.index).replace(/^[\s\-*]+/, "").trim();

    if (!statementText || statementText.length < 5) continue;

    const verification = await verifyCitation(rootPath, {
      file: filePath,
      startLine,
      endLine,
    });

    statements.push({
      statement: statementText.slice(0, 200),
      result: verification.result === "verified" ? "verified"
            : verification.result === "partial" ? "partial"
            : "unverified",
      reason: verification.reason,
      citation: { file: filePath, startLine, endLine },
      codeSnippet: verification.snippet || undefined,
    });
  }

  // Also check plain file path references (src/path/file.ts)
  const plainFileRegex = /((?:src|lib)\/[\w\-./]+\.(?:ts|js))/g;
  const checkedFiles = new Set(statements.map((s) => s.citation?.file));

  while ((match = plainFileRegex.exec(answer)) !== null) {
    const filePath = match[1];
    if (checkedFiles.has(filePath)) continue;
    checkedFiles.add(filePath);

    const fullPath = join(rootPath, filePath);
    const exists = await fileExists(fullPath);

    if (exists) {
      // Find surrounding statement text
      const lineStart = answer.lastIndexOf("\n", match.index) + 1;
      const lineEnd = answer.indexOf("\n", match.index);
      const lineText = answer.slice(lineStart, lineEnd > 0 ? lineEnd : undefined).trim();

      statements.push({
        statement: `References ${filePath}`,
        result: "verified",
        reason: "File exists at referenced path",
        citation: { file: filePath, startLine: 1 },
      });
    } else {
      statements.push({
        statement: `References ${filePath}`,
        result: "unverified",
        reason: "File does not exist at referenced path",
        citation: { file: filePath, startLine: 1 },
      });
    }
  }

  return statements;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback: extract source file paths from specialist documentation.
 * When the answer doesn't contain [source:...] citations, we look at the
 * specialist docs that were used to generate the answer and find the
 * source files they reference.
 */
async function extractFilesFromSpecialistDocs(
  answer: string,
  rootPath: string,
  scribePath: string
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  try {
    // Read all specialist overview docs to find [source:path:Lx] citations
    const { default: fg } = await import("fast-glob");
    const overviews = await fg("specialists/*/overview.md", {
      cwd: scribePath,
      absolute: true,
    });

    for (const overview of overviews) {
      const content = await readFile(overview, "utf-8");
      // Extract [source:path:Lx] from specialist docs
      const sourceRegex = /\[source:([^:\]]+)/g;
      let match;
      while ((match = sourceRegex.exec(content)) !== null) {
        const filePath = match[1];
        if (seen.has(filePath)) continue;
        seen.add(filePath);

        try {
          const fileContent = await readFile(join(rootPath, filePath), "utf-8");
          const numbered = fileContent
            .split("\n")
            .map((line, i) => `${i + 1}\t${line}`)
            .join("\n");
          files.push({ path: filePath, content: numbered });
        } catch {
          // file doesn't exist
        }

        // Limit to 3 files to stay within token budget (speed optimization)
        if (files.length >= 3) return files;
      }
    }
  } catch (err) {
    logger.debug(`Fallback file extraction failed: ${err}`);
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
        ? `${stmt.citation.file}:${stmt.citation.startLine}-${stmt.citation.endLine}`
        : `${stmt.citation.file}:${stmt.citation.startLine}`;
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
