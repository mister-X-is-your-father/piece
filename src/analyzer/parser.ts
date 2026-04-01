import { readFile } from "node:fs/promises";
import type { FileStructure, ImportInfo, ExportInfo, FunctionInfo } from "../config/schema.js";

// Language-agnostic regex-based structure extraction
// Prioritizes TypeScript/JavaScript but handles common patterns in other languages

const TS_IMPORT_RE =
  /^(?:import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?|\*\s+as\s+\w+)(?:\s*,\s*(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?))*\s+from\s+)?["']([^"']+)["']|require\(["']([^"']+)["']\))/gm;

const PY_IMPORT_RE =
  /^(?:from\s+([\w.]+)\s+import\s+([\w*,\s]+)|import\s+([\w.,\s]+))/gm;

const TS_EXPORT_RE =
  /^export\s+(?:(default)\s+)?(?:(async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+)?(\w+)?/gm;

const TS_FUNCTION_RE =
  /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>|(?:class\s+(\w+)))/gm;

const PY_FUNCTION_RE = /^(?:def|class)\s+(\w+)/gm;
const GO_FUNCTION_RE = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm;
const RUST_FUNCTION_RE = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm;

export async function parseFileStructure(
  filePath: string,
  relativePath: string
): Promise<FileStructure> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";

  const imports = extractImports(content, lines, ext);
  const exports = extractExports(content, lines, ext);
  const functions = extractFunctions(content, lines, ext);

  return { path: relativePath, imports, exports, functions };
}

function extractImports(
  content: string,
  lines: string[],
  ext: string
): ImportInfo[] {
  const results: ImportInfo[] = [];

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^\s*import\s/) || line.match(/require\(/)) {
        const sourceMatch = line.match(/["']([^"']+)["']/);
        if (sourceMatch) {
          const namesMatch = line.match(/\{([^}]+)\}/);
          const names = namesMatch
            ? namesMatch[1].split(",").map((n) => n.trim().split(" as ")[0].trim()).filter(Boolean)
            : ["*"];
          results.push({ source: sourceMatch[1], names, line: i + 1 });
        }
      }
    }
  } else if (["py", "pyw"].includes(ext)) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(PY_IMPORT_RE.source, "gm");
    while ((match = regex.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split("\n").length;
      const source = match[1] || match[3] || "";
      const names = match[2]
        ? match[2].split(",").map((n) => n.trim()).filter(Boolean)
        : [source];
      results.push({ source, names, line: lineNum });
    }
  }

  return results;
}

function extractExports(
  content: string,
  lines: string[],
  ext: string
): ExportInfo[] {
  const results: ExportInfo[] = [];

  if (!["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return results;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();
    if (!line.startsWith("export")) continue;

    const isDefault = line.includes("export default");
    let kind: ExportInfo["kind"] = "other";
    let name = "";

    if (line.match(/export\s+(default\s+)?function\s+(\w+)/)) {
      kind = "function";
      name = line.match(/function\s+(\w+)/)?.[1] ?? "default";
    } else if (line.match(/export\s+(default\s+)?class\s+(\w+)/)) {
      kind = "class";
      name = line.match(/class\s+(\w+)/)?.[1] ?? "default";
    } else if (line.match(/export\s+(default\s+)?interface\s+(\w+)/)) {
      kind = "interface";
      name = line.match(/interface\s+(\w+)/)?.[1] ?? "default";
    } else if (line.match(/export\s+type\s+(\w+)/)) {
      kind = "type";
      name = line.match(/type\s+(\w+)/)?.[1] ?? "";
    } else if (line.match(/export\s+(default\s+)?(?:const|let|var)\s+(\w+)/)) {
      kind = "variable";
      name = line.match(/(?:const|let|var)\s+(\w+)/)?.[1] ?? "";
    } else if (isDefault) {
      kind = "default";
      name = "default";
    }

    if (name) {
      results.push({ name, line: i + 1, kind: isDefault ? "default" : kind });
    }
  }

  return results;
}

function extractFunctions(
  content: string,
  lines: string[],
  ext: string
): FunctionInfo[] {
  const results: FunctionInfo[] = [];

  const patterns: Record<string, RegExp> = {
    ts: TS_FUNCTION_RE,
    tsx: TS_FUNCTION_RE,
    js: TS_FUNCTION_RE,
    jsx: TS_FUNCTION_RE,
    mjs: TS_FUNCTION_RE,
    cjs: TS_FUNCTION_RE,
    py: PY_FUNCTION_RE,
    pyw: PY_FUNCTION_RE,
    go: GO_FUNCTION_RE,
    rs: RUST_FUNCTION_RE,
  };

  const pattern = patterns[ext];
  if (!pattern) return results;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const regex = new RegExp(pattern.source, "g");
    const match = regex.exec(line);
    if (match) {
      const name = match[1] || match[2] || match[3] || "";
      if (name) {
        // Estimate end line by finding next function or end of file
        const endLine = findFunctionEnd(lines, i, ext);
        results.push({ name, startLine: i + 1, endLine });
      }
    }
  }

  return results;
}

function findFunctionEnd(lines: string[], startIdx: number, ext: string): number {
  // For brace-based languages, track brace depth
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "java", "c", "cpp"].includes(ext)) {
    let depth = 0;
    let foundOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") {
          depth++;
          foundOpen = true;
        }
        if (ch === "}") depth--;
        if (foundOpen && depth === 0) return i + 1;
      }
    }
  }

  // For Python, track indentation
  if (["py", "pyw"].includes(ext)) {
    const baseIndent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent) return i;
    }
  }

  return Math.min(startIdx + 50, lines.length);
}
