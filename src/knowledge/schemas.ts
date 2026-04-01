import { z } from "zod";

// --- Knowledge Node ---

export const NodeTypeSchema = z.enum([
  "fact",
  "explanation",
  "pattern",
  "relationship",
  "flow_step",
  "resolution",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const KnowledgeNodeSchema = z.object({
  id: z.string(),
  content: z.string(),
  summary: z.string(),
  node_type: NodeTypeSchema,
  confidence: z.number().min(0).max(1),
  specialist: z.string().nullable(),
  source_question: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  access_count: z.number(),
  last_accessed_at: z.string().nullable(),
});
export type KnowledgeNode = z.infer<typeof KnowledgeNodeSchema>;

export const KnowledgeNodeInsertSchema = z.object({
  content: z.string(),
  summary: z.string(),
  node_type: NodeTypeSchema,
  confidence: z.number().min(0).max(1).optional(),
  specialist: z.string().nullable().optional(),
  source_question: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export type KnowledgeNodeInsert = z.infer<typeof KnowledgeNodeInsertSchema>;

// --- Node Citation ---

export const NodeCitationSchema = z.object({
  id: z.string(),
  node_id: z.string(),
  file_path: z.string(),
  start_line: z.number().nullable(),
  end_line: z.number().nullable(),
  code_snippet: z.string().nullable(),
  created_at: z.string(),
});
export type NodeCitation = z.infer<typeof NodeCitationSchema>;

export const NodeCitationInsertSchema = z.object({
  node_id: z.string(),
  file_path: z.string(),
  start_line: z.number().nullable().optional(),
  end_line: z.number().nullable().optional(),
  code_snippet: z.string().nullable().optional(),
});
export type NodeCitationInsert = z.infer<typeof NodeCitationInsertSchema>;

// --- Node Link ---

export const LinkTypeSchema = z.enum([
  "related",
  "depends_on",
  "contradicts",
  "elaborates",
  "resolves",
]);
export type LinkType = z.infer<typeof LinkTypeSchema>;

export const NodeLinkSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  target_id: z.string(),
  link_type: LinkTypeSchema,
  description: z.string().nullable(),
  created_at: z.string(),
});
export type NodeLink = z.infer<typeof NodeLinkSchema>;

export const NodeLinkInsertSchema = z.object({
  source_id: z.string(),
  target_id: z.string(),
  link_type: LinkTypeSchema,
  description: z.string().nullable().optional(),
});
export type NodeLinkInsert = z.infer<typeof NodeLinkInsertSchema>;

// --- Mystery ---

export const MysteryStatusSchema = z.enum([
  "open",
  "investigating",
  "resolved",
  "wont_fix",
]);
export type MysteryStatus = z.infer<typeof MysteryStatusSchema>;

export const MysterySourceSchema = z.enum([
  "analysis",
  "fact_check",
  "ask",
  "investigation",
  "manual",
]);
export type MysterySource = z.infer<typeof MysterySourceSchema>;

export const MysterySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  context: z.string().nullable(),
  priority: z.number().min(1).max(10),
  status: MysteryStatusSchema,
  specialist: z.string().nullable(),
  source: MysterySourceSchema,
  resolution_node_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type Mystery = z.infer<typeof MysterySchema>;

export const MysteryInsertSchema = z.object({
  title: z.string(),
  description: z.string(),
  context: z.string().nullable().optional(),
  priority: z.number().min(1).max(10).optional(),
  specialist: z.string().nullable().optional(),
  source: MysterySourceSchema,
});
export type MysteryInsert = z.infer<typeof MysteryInsertSchema>;

// --- Flow ---

export const FlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  trigger_description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Flow = z.infer<typeof FlowSchema>;

export const FlowInsertSchema = z.object({
  name: z.string(),
  description: z.string(),
  trigger_description: z.string().nullable().default(null),
});
export type FlowInsert = z.infer<typeof FlowInsertSchema>;

export const FlowStepSchema = z.object({
  id: z.string(),
  flow_id: z.string(),
  step_order: z.number(),
  specialist: z.string().nullable(),
  description: z.string(),
  file_path: z.string().nullable(),
  start_line: z.number().nullable(),
  end_line: z.number().nullable(),
  code_snippet: z.string().nullable(),
  node_id: z.string().nullable(),
  created_at: z.string(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowStepInsertSchema = z.object({
  flow_id: z.string(),
  step_order: z.number(),
  specialist: z.string().nullable().optional(),
  description: z.string(),
  file_path: z.string().nullable().optional(),
  start_line: z.number().nullable().optional(),
  end_line: z.number().nullable().optional(),
  code_snippet: z.string().nullable().optional(),
  node_id: z.string().nullable().optional(),
});
export type FlowStepInsert = z.infer<typeof FlowStepInsertSchema>;

// --- Investigation ---

export const InvestigationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

export const InvestigationSchema = z.object({
  id: z.string(),
  mystery_id: z.string().nullable(),
  goal: z.string(),
  status: InvestigationStatusSchema,
  findings: z.string().nullable(),
  nodes_created: z.number(),
  nodes_updated: z.number(),
  mysteries_resolved: z.number(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
});
export type Investigation = z.infer<typeof InvestigationSchema>;

export const InvestigationInsertSchema = z.object({
  mystery_id: z.string().nullable().default(null),
  goal: z.string(),
});
export type InvestigationInsert = z.infer<typeof InvestigationInsertSchema>;

// --- Query Cache ---

export const QueryCacheSchema = z.object({
  id: z.string(),
  question: z.string(),
  question_normalized: z.string(),
  answer: z.string(),
  specialists_consulted: z.string(), // JSON array
  fact_check_summary: z.string().nullable(),
  knowledge_node_ids: z.string().nullable(), // JSON array of node IDs used
  investigation_method: z.string().nullable(), // how the answer was derived
  hit_count: z.number(),
  created_at: z.string(),
  last_hit_at: z.string().nullable(),
});
export type QueryCache = z.infer<typeof QueryCacheSchema>;

export const QueryCacheInsertSchema = z.object({
  question: z.string(),
  answer: z.string(),
  specialists_consulted: z.array(z.string()),
  fact_check_summary: z.string().nullable().optional(),
  knowledge_node_ids: z.array(z.string()).optional(),
  investigation_method: z.string().nullable().optional(),
});
export type QueryCacheInsert = z.infer<typeof QueryCacheInsertSchema>;

// --- Knowledge Search Result ---

export const KnowledgeSearchResultSchema = z.object({
  node: KnowledgeNodeSchema,
  relevance: z.number(),
  citations: z.array(NodeCitationSchema),
});
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchResultSchema>;
