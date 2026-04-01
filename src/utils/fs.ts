import { readFile, stat } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import {
  SOURCE_EXTENSIONS,
  CONFIG_FILENAMES,
  DOC_EXTENSIONS,
  TEST_PATTERNS,
} from "../config/defaults.js";
import type { FileCategory } from "../config/schema.js";

export async function loadGitignore(rootPath: string): Promise<ignore.Ignore> {
  const ig = ignore.default();
  try {
    const content = await readFile(join(rootPath, ".gitignore"), "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore
  }
  return ig;
}

export function categorizeFile(relativePath: string): FileCategory {
  const ext = extname(relativePath).toLowerCase();
  const base = basename(relativePath);

  // Test files first (before source check)
  if (TEST_PATTERNS.some((p) => p.test(relativePath))) {
    return "test";
  }

  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  if (CONFIG_FILENAMES.has(base)) return "config";
  if (DOC_EXTENSIONS.has(ext)) return "doc";

  return "other";
}

export async function discoverFiles(
  rootPath: string,
  includePatterns: string[],
  excludePatterns: string[]
): Promise<string[]> {
  const files = await fg(includePatterns, {
    cwd: rootPath,
    ignore: excludePatterns,
    absolute: false,
    dot: false,
    onlyFiles: true,
  });
  return files.sort();
}

export async function readFileContent(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

export async function readFileWithLineNumbers(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return content
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");
}

export async function getFileStat(filePath: string) {
  const s = await stat(filePath);
  return { sizeBytes: s.size, lastModified: s.mtimeMs };
}

export function getRelativePath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath);
}

export function readLines(
  content: string,
  startLine: number,
  endLine?: number
): string {
  const lines = content.split("\n");
  const start = Math.max(0, startLine - 1);
  const end = endLine ? Math.min(lines.length, endLine) : start + 1;
  return lines.slice(start, end).join("\n");
}
