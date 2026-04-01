import matter from "gray-matter";

export interface DocFrontmatter {
  source_files?: Array<{ path: string; hash: string; last_analyzed: string }>;
  module?: string;
  type: "project_overview" | "specialist_overview" | "file_doc" | "cross_references";
  specialist?: string;
}

export function renderMarkdown(
  frontmatter: DocFrontmatter,
  content: string
): string {
  return matter.stringify(content, frontmatter);
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, "--")
    .replace(/[^a-zA-Z0-9\-_.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function makeObsidianLink(target: string, label?: string): string {
  const display = label || target;
  return `[[${target}|${display}]]`;
}
