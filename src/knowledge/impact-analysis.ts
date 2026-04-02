/**
 * Impact Analysis: 「このファイルを変えたら何が壊れる？」
 *
 * ファイル → 関連する画面・API・機能・操作・知識ノードを全て辿る
 */

import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export interface ImpactReport {
  file: string;
  screens: Array<{ id: string; name: string; route: string }>;
  endpoints: Array<{ id: string; method: string; path: string }>;
  features: Array<{ id: string; name: string }>;
  operations: Array<{ id: string; name: string }>;
  knowledgeNodes: Array<{ id: string; summary: string; confidence: number }>;
  dependentFiles: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
}

export function analyzeImpact(
  db: Database.Database,
  filePath: string
): ImpactReport {
  const pattern = `%${filePath}%`;

  // Screens using this file
  const screens = db
    .prepare("SELECT id, name, route FROM screens WHERE file_path LIKE ?")
    .all(pattern) as ImpactReport["screens"];

  // Endpoints in this file
  const endpoints = db
    .prepare("SELECT id, method, path FROM endpoints WHERE handler_file LIKE ?")
    .all(pattern) as ImpactReport["endpoints"];

  // Operations referencing this file
  const operations = db
    .prepare("SELECT id, name FROM operations WHERE handler_file LIKE ?")
    .all(pattern) as ImpactReport["operations"];

  // Knowledge nodes citing this file
  const knowledgeNodes = db
    .prepare(
      `SELECT DISTINCT kn.id, kn.summary, kn.confidence
       FROM knowledge_nodes kn
       JOIN node_citations nc ON nc.node_id = kn.id
       WHERE nc.file_path LIKE ?`
    )
    .all(pattern) as ImpactReport["knowledgeNodes"];

  // Features connected to affected screens/endpoints
  const featureIds = new Set<string>();
  for (const s of screens) {
    const conns = db
      .prepare("SELECT feature_id FROM feature_connections WHERE target_id = ?")
      .all(s.id) as Array<{ feature_id: string }>;
    for (const c of conns) featureIds.add(c.feature_id);
  }
  for (const e of endpoints) {
    const conns = db
      .prepare("SELECT feature_id FROM feature_connections WHERE target_id = ?")
      .all(e.id) as Array<{ feature_id: string }>;
    for (const c of conns) featureIds.add(c.feature_id);
  }

  const features: ImpactReport["features"] = [];
  for (const fId of featureIds) {
    const f = db.prepare("SELECT id, name FROM features WHERE id = ?").get(fId) as any;
    if (f) features.push(f);
  }

  // Files that import this file (from dependency graph via node_links)
  const dependentFiles: string[] = [];
  try {
    const deps = db
      .prepare(
        `SELECT DISTINCT nc.file_path
         FROM node_links nl
         JOIN node_citations nc ON nc.node_id = nl.source_id
         WHERE nl.target_id IN (
           SELECT node_id FROM node_citations WHERE file_path LIKE ?
         )`
      )
      .all(pattern) as Array<{ file_path: string }>;
    for (const d of deps) dependentFiles.push(d.file_path);
  } catch { /* may not have enough data */ }

  // Risk level
  const totalImpact = screens.length + endpoints.length + features.length + operations.length;
  const riskLevel: ImpactReport["riskLevel"] =
    totalImpact >= 5 ? "critical" :
    totalImpact >= 3 ? "high" :
    totalImpact >= 1 ? "medium" : "low";

  return {
    file: filePath,
    screens,
    endpoints,
    features,
    operations,
    knowledgeNodes,
    dependentFiles,
    riskLevel,
  };
}

export function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = [];
  const riskColors: Record<string, string> = {
    low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL",
  };

  lines.push(`Impact Analysis: ${report.file}`);
  lines.push(`Risk Level: ${riskColors[report.riskLevel]}`);
  lines.push("");

  if (report.screens.length > 0) {
    lines.push(`Screens (${report.screens.length}):`);
    for (const s of report.screens) lines.push(`  - ${s.name} (${s.route})`);
  }
  if (report.endpoints.length > 0) {
    lines.push(`Endpoints (${report.endpoints.length}):`);
    for (const e of report.endpoints) lines.push(`  - ${e.method} ${e.path}`);
  }
  if (report.features.length > 0) {
    lines.push(`Features (${report.features.length}):`);
    for (const f of report.features) lines.push(`  - ${f.name}`);
  }
  if (report.operations.length > 0) {
    lines.push(`Operations (${report.operations.length}):`);
    for (const o of report.operations) lines.push(`  - ${o.name}`);
  }
  if (report.knowledgeNodes.length > 0) {
    lines.push(`Knowledge Nodes (${report.knowledgeNodes.length}):`);
    for (const n of report.knowledgeNodes) {
      lines.push(`  - ${n.summary} (confidence: ${(n.confidence * 100).toFixed(0)}%)`);
    }
  }
  if (report.dependentFiles.length > 0) {
    lines.push(`Dependent Files (${report.dependentFiles.length}):`);
    for (const f of report.dependentFiles) lines.push(`  - ${f}`);
  }

  return lines.join("\n");
}
