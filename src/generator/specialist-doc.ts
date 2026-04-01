import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cluster, DomainJson, FileEntry } from "../config/schema.js";
import { renderMarkdown, sanitizeFilename, type DocFrontmatter } from "./renderer.js";
import { logger } from "../utils/logger.js";

/**
 * Generate specialist documentation from analysis results.
 * Creates the .scribe/specialists/<name>/ directory structure.
 */
export async function generateSpecialistDocs(
  scribePath: string,
  cluster: Cluster,
  analysisContent: string,
  fileEntries: FileEntry[]
): Promise<void> {
  const specialistDir = join(scribePath, "specialists", cluster.name);
  const filesDir = join(specialistDir, "files");
  await mkdir(filesDir, { recursive: true });

  // 1. Write domain.json
  const now = new Date().toISOString();
  const fileHashes: Record<string, string> = {};
  for (const f of fileEntries) {
    if (cluster.files.includes(f.relativePath)) {
      fileHashes[f.relativePath] = f.hash;
    }
  }

  const domain: DomainJson = {
    name: cluster.name,
    description: cluster.description,
    files: cluster.files,
    keywords: cluster.keywords,
    dependencies: cluster.dependencies,
    analyzedAt: now,
    fileHashes,
  };

  await writeFile(
    join(specialistDir, "domain.json"),
    JSON.stringify(domain, null, 2),
    "utf-8"
  );

  // 2. Write overview.md (the specialist's "brain")
  const overviewFrontmatter: DocFrontmatter = {
    type: "specialist_overview",
    specialist: cluster.name,
    source_files: cluster.files.map((f) => ({
      path: f,
      hash: fileHashes[f] || "",
      last_analyzed: now,
    })),
  };

  const overviewContent = renderMarkdown(overviewFrontmatter, analysisContent);
  await writeFile(join(specialistDir, "overview.md"), overviewContent, "utf-8");

  // 3. Split analysis into per-file docs if the analysis contains file sections
  const fileSections = splitByFileSection(analysisContent, cluster.files);
  for (const [filePath, content] of fileSections) {
    const docName = sanitizeFilename(filePath) + ".md";
    const fileFrontmatter: DocFrontmatter = {
      type: "file_doc",
      specialist: cluster.name,
      source_files: [
        {
          path: filePath,
          hash: fileHashes[filePath] || "",
          last_analyzed: now,
        },
      ],
    };

    const fileContent = renderMarkdown(fileFrontmatter, content);
    await writeFile(join(filesDir, docName), fileContent, "utf-8");
  }

  // 4. Write search index
  const searchIndex = buildSearchIndex(cluster, analysisContent);
  await writeFile(
    join(specialistDir, "_index.json"),
    JSON.stringify(searchIndex, null, 2),
    "utf-8"
  );

  logger.debug(`Generated specialist docs for: ${cluster.name}`);
}

function splitByFileSection(
  analysis: string,
  files: string[]
): Map<string, string> {
  const sections = new Map<string, string>();

  for (const file of files) {
    // Look for sections that mention this file
    const patterns = [
      new RegExp(`###?\\s+(?:File:\\s*)?${escapeRegex(file)}[\\s\\S]*?(?=###?\\s+(?:File:|$))`, "i"),
      new RegExp(`###?\\s+${escapeRegex(file.split("/").pop() || "")}[\\s\\S]*?(?=###?\\s|$)`, "i"),
    ];

    for (const pattern of patterns) {
      const match = analysis.match(pattern);
      if (match) {
        sections.set(file, match[0].trim());
        break;
      }
    }
  }

  return sections;
}

function buildSearchIndex(
  cluster: Cluster,
  analysis: string
): { keywords: Record<string, string[]>; functions: Record<string, string> } {
  const keywords: Record<string, string[]> = {};
  const functions: Record<string, string> = {};

  // Index cluster keywords
  for (const kw of cluster.keywords) {
    keywords[kw] = [`specialists/${cluster.name}/overview.md`];
  }

  // Extract function mentions from analysis
  const funcRegex = /`(\w+)\(`/g;
  let match: RegExpExecArray | null;
  while ((match = funcRegex.exec(analysis)) !== null) {
    functions[match[1]] = `specialists/${cluster.name}/overview.md`;
  }

  return { keywords, functions };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
