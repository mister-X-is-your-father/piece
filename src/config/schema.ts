import { z } from "zod";

// --- Config Schemas ---

export const TargetConfigSchema = z.object({
  include: z.array(z.string()).default(["src/**", "lib/**"]),
  exclude: z
    .array(z.string())
    .default([
      "node_modules",
      "dist",
      "build",
      ".git",
      "*.min.js",
      "*.lock",
      "*.map",
    ]),
  maxFileSize: z.number().default(102400),
});

export const AgentsConfigSchema = z.object({
  analysisModel: z.string().default("claude-sonnet-4-20250514"),
  responseModel: z.string().default("claude-sonnet-4-20250514"),
  factCheckModel: z.string().default("claude-haiku-4-5-20251001"),
  concurrency: z.number().min(1).max(10).default(3),
  maxSpecialists: z.number().min(1).max(50).default(20),
});

export const ClusteringConfigSchema = z.object({
  strategy: z
    .enum(["directory", "dependency", "directory+dependency"])
    .default("directory+dependency"),
  minFilesPerSpecialist: z.number().default(2),
  maxFilesPerSpecialist: z.number().default(15),
});

export const OutputConfigSchema = z.object({
  directory: z.string().default(".scribe"),
  format: z.enum(["obsidian", "plain"]).default("obsidian"),
  crossLinks: z.boolean().default(true),
});

export const FactCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
  verifyLineContent: z.boolean().default(true),
});

export const ScribeConfigSchema = z.object({
  target: TargetConfigSchema.default({}),
  agents: AgentsConfigSchema.default({}),
  clustering: ClusteringConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
  factCheck: FactCheckConfigSchema.default({}),
});

export type ScribeConfig = z.infer<typeof ScribeConfigSchema>;

// --- Internal Data Schemas ---

export const FileCategorySchema = z.enum([
  "source",
  "config",
  "test",
  "doc",
  "other",
]);
export type FileCategory = z.infer<typeof FileCategorySchema>;

export const FileEntrySchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  category: FileCategorySchema,
  sizeBytes: z.number(),
  lastModified: z.number(),
  hash: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const ImportInfoSchema = z.object({
  source: z.string(),
  names: z.array(z.string()),
  line: z.number(),
});
export type ImportInfo = z.infer<typeof ImportInfoSchema>;

export const ExportInfoSchema = z.object({
  name: z.string(),
  line: z.number(),
  kind: z.enum(["function", "class", "interface", "type", "variable", "default", "other"]),
});
export type ExportInfo = z.infer<typeof ExportInfoSchema>;

export const FunctionInfoSchema = z.object({
  name: z.string(),
  startLine: z.number(),
  endLine: z.number(),
});
export type FunctionInfo = z.infer<typeof FunctionInfoSchema>;

export const FileStructureSchema = z.object({
  path: z.string(),
  imports: z.array(ImportInfoSchema),
  exports: z.array(ExportInfoSchema),
  functions: z.array(FunctionInfoSchema),
});
export type FileStructure = z.infer<typeof FileStructureSchema>;

export const ClusterSchema = z.object({
  name: z.string(),
  description: z.string(),
  files: z.array(z.string()),
  keywords: z.array(z.string()),
  dependencies: z.array(z.string()),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const DomainJsonSchema = z.object({
  name: z.string(),
  description: z.string(),
  files: z.array(z.string()),
  keywords: z.array(z.string()),
  dependencies: z.array(z.string()),
  analyzedAt: z.string(),
  fileHashes: z.record(z.string()),
});
export type DomainJson = z.infer<typeof DomainJsonSchema>;

export const CitationSchema = z.object({
  file: z.string(),
  startLine: z.number(),
  endLine: z.number().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const FactCheckResultSchema = z.enum(["verified", "partial", "unverified"]);
export type FactCheckResult = z.infer<typeof FactCheckResultSchema>;

export const VerifiedStatementSchema = z.object({
  statement: z.string(),
  result: FactCheckResultSchema,
  citation: CitationSchema.optional(),
  codeSnippet: z.string().optional(),
  reason: z.string().optional(),
});
export type VerifiedStatement = z.infer<typeof VerifiedStatementSchema>;

export const ScribeMetadataSchema = z.object({
  version: z.number().default(1),
  projectPath: z.string(),
  analyzedAt: z.string(),
  config: ScribeConfigSchema,
  specialists: z.array(z.string()),
  fileHashes: z.record(z.string()),
});
export type ScribeMetadata = z.infer<typeof ScribeMetadataSchema>;

export const GlobalIndexSchema = z.object({
  keywords: z.record(z.array(z.string())),
  files: z.record(z.string()),
  specialists: z.record(
    z.object({
      description: z.string(),
      keywords: z.array(z.string()),
      files: z.array(z.string()),
    })
  ),
});
export type GlobalIndex = z.infer<typeof GlobalIndexSchema>;
