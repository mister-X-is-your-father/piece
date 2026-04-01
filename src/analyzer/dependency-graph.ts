import { dirname, join, resolve } from "node:path";
import type { FileStructure } from "../config/schema.js";

export interface DependencyGraph {
  /** file -> set of files it imports */
  imports: Map<string, Set<string>>;
  /** file -> set of files that import it */
  importedBy: Map<string, Set<string>>;
  /** files that are not imported by anything */
  entryPoints: string[];
  /** files with the most connections (imported by many) */
  hubs: string[];
}

export function buildDependencyGraph(
  structures: FileStructure[],
  allFiles: Set<string>
): DependencyGraph {
  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();

  // Initialize all files
  for (const file of allFiles) {
    imports.set(file, new Set());
    importedBy.set(file, new Set());
  }

  for (const structure of structures) {
    const dir = dirname(structure.path);

    for (const imp of structure.imports) {
      // Resolve relative imports
      if (imp.source.startsWith(".")) {
        const resolved = resolveImport(dir, imp.source, allFiles);
        if (resolved) {
          imports.get(structure.path)?.add(resolved);
          importedBy.get(resolved)?.add(structure.path);
        }
      }
    }
  }

  // Find entry points (not imported by anything)
  const entryPoints = [...allFiles].filter(
    (f) => (importedBy.get(f)?.size ?? 0) === 0
  );

  // Find hubs (imported by many files)
  const hubThreshold = 3;
  const hubs = [...allFiles]
    .filter((f) => (importedBy.get(f)?.size ?? 0) >= hubThreshold)
    .sort(
      (a, b) =>
        (importedBy.get(b)?.size ?? 0) - (importedBy.get(a)?.size ?? 0)
    );

  return { imports, importedBy, entryPoints, hubs };
}

function resolveImport(
  fromDir: string,
  importPath: string,
  allFiles: Set<string>
): string | null {
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];

  for (const ext of extensions) {
    const candidate = join(fromDir, importPath + ext).replace(/\\/g, "/");
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/** Get files strongly connected to a given file (direct imports + importers) */
export function getRelatedFiles(
  graph: DependencyGraph,
  file: string
): Set<string> {
  const related = new Set<string>();
  const importsOf = graph.imports.get(file);
  const importersOf = graph.importedBy.get(file);

  if (importsOf) for (const f of importsOf) related.add(f);
  if (importersOf) for (const f of importersOf) related.add(f);

  return related;
}
