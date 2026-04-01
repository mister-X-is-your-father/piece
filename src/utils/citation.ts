import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Citation, FactCheckResult } from "../config/schema.js";

const CITATION_REGEX = /\[source:([^:]+):L(\d+)(?:-L?(\d+))?\]/g;

export function parseCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(CITATION_REGEX.source, "g");

  while ((match = regex.exec(text)) !== null) {
    citations.push({
      file: match[1],
      startLine: parseInt(match[2], 10),
      endLine: match[3] ? parseInt(match[3], 10) : undefined,
    });
  }
  return citations;
}

export function formatCitation(citation: Citation): string {
  if (citation.endLine) {
    return `[source:${citation.file}:L${citation.startLine}-L${citation.endLine}]`;
  }
  return `[source:${citation.file}:L${citation.startLine}]`;
}

export async function verifyCitation(
  rootPath: string,
  citation: Citation
): Promise<{
  result: FactCheckResult;
  snippet: string;
  reason?: string;
}> {
  const filePath = join(rootPath, citation.file);
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (citation.startLine < 1 || citation.startLine > totalLines) {
      return {
        result: "unverified",
        snippet: "",
        reason: `Line ${citation.startLine} out of range (file has ${totalLines} lines)`,
      };
    }

    const start = citation.startLine - 1;
    const end = citation.endLine
      ? Math.min(citation.endLine, totalLines)
      : citation.startLine;
    const snippet = lines.slice(start, end).join("\n");

    return { result: "verified", snippet };
  } catch {
    return {
      result: "unverified",
      snippet: "",
      reason: `File not found: ${citation.file}`,
    };
  }
}

export function formatVerificationBadge(result: FactCheckResult): string {
  switch (result) {
    case "verified":
      return "VERIFIED";
    case "partial":
      return "PARTIAL";
    case "unverified":
      return "UNVERIFIED";
  }
}
