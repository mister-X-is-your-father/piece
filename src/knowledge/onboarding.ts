/**
 * Onboarding: 新メンバー向けの構造化ガイドツアー生成
 *
 * 既存の知識・app-map・specialist情報から
 * 「このプロジェクトの全体像」を構造化して出力する
 */

import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

export interface OnboardingGuide {
  projectOverview: string;
  architecture: string;
  features: Array<{ name: string; description: string; screens: string[]; endpoints: string[] }>;
  screens: Array<{ name: string; route: string; description: string }>;
  keyEndpoints: Array<{ method: string; path: string; description: string }>;
  specialists: Array<{ name: string; description: string; fileCount: number }>;
  knowledgeStats: { nodes: number; mysteries: number; coverage: number };
  gettingStarted: string[];
}

export async function generateOnboardingGuide(
  db: Database.Database,
  scribePath: string
): Promise<OnboardingGuide> {
  // Project overview
  let projectOverview = "";
  try {
    projectOverview = await readFile(join(scribePath, "index.md"), "utf-8");
  } catch { /* no overview */ }

  // Features
  const features = db
    .prepare("SELECT * FROM features ORDER BY name")
    .all() as Array<{ id: string; name: string; description: string }>;

  const featureDetails = features.map((f) => {
    const conns = db
      .prepare("SELECT target_type, target_id FROM feature_connections WHERE feature_id = ?")
      .all(f.id) as Array<{ target_type: string; target_id: string }>;

    const screenNames: string[] = [];
    const endpointPaths: string[] = [];
    for (const c of conns) {
      if (c.target_type === "screen") {
        const s = db.prepare("SELECT name FROM screens WHERE id = ?").get(c.target_id) as { name: string } | undefined;
        if (s) screenNames.push(s.name);
      }
      if (c.target_type === "endpoint") {
        const e = db.prepare("SELECT method, path FROM endpoints WHERE id = ?").get(c.target_id) as { method: string; path: string } | undefined;
        if (e) endpointPaths.push(`${e.method} ${e.path}`);
      }
    }

    return { name: f.name, description: f.description || "", screens: screenNames, endpoints: endpointPaths };
  });

  // Screens
  const screens = db
    .prepare("SELECT name, route, description FROM screens ORDER BY route")
    .all() as Array<{ name: string; route: string; description: string }>;

  // Key endpoints
  const endpoints = db
    .prepare("SELECT method, path, description FROM endpoints ORDER BY path")
    .all() as Array<{ method: string; path: string; description: string }>;

  // Specialists
  let specialists: OnboardingGuide["specialists"] = [];
  try {
    const indexRaw = await readFile(join(scribePath, "_global-index.json"), "utf-8");
    const index = JSON.parse(indexRaw);
    specialists = Object.entries(index.specialists).map(([name, info]: [string, any]) => ({
      name,
      description: info.description,
      fileCount: info.files.length,
    }));
  } catch { /* no index */ }

  // Knowledge stats
  const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as { c: number }).c;
  const mysteryCount = (db.prepare("SELECT COUNT(*) as c FROM mysteries WHERE status = 'open'").get() as { c: number }).c;

  let coverage = 0;
  try {
    const comp = db.prepare("SELECT AVG(coverage) as avg FROM completeness_map").get() as { avg: number | null };
    coverage = comp.avg || 0;
  } catch { /* no completeness data */ }

  // Getting started suggestions
  const gettingStarted: string[] = [];
  if (features.length > 0) {
    gettingStarted.push(`piece ask . "${features[0].name}の仕組みを教えて"`);
  }
  if (screens.length > 0) {
    gettingStarted.push(`piece app-map . --screens  # 全画面一覧`);
  }
  gettingStarted.push(`piece knowledge . --search "キーワード"  # 知識検索`);
  gettingStarted.push(`piece flows . --trace "主要フロー名"  # E2Eフロー追跡`);

  // Architecture (from overview)
  const archSection = projectOverview.match(/## Architecture[\s\S]*?(?=## |$)/)?.[0] || "";

  return {
    projectOverview: projectOverview.split("\n").slice(0, 10).join("\n"),
    architecture: archSection,
    features: featureDetails,
    screens,
    keyEndpoints: endpoints,
    specialists,
    knowledgeStats: { nodes: nodeCount, mysteries: mysteryCount, coverage },
    gettingStarted,
  };
}

export function formatOnboardingGuide(guide: OnboardingGuide): string {
  const lines: string[] = [];

  lines.push("# Project Onboarding Guide\n");

  if (guide.projectOverview) {
    lines.push("## Overview\n");
    lines.push(guide.projectOverview);
    lines.push("");
  }

  if (guide.features.length > 0) {
    lines.push("## Features\n");
    for (const f of guide.features) {
      lines.push(`### ${f.name}`);
      if (f.description) lines.push(f.description);
      if (f.screens.length > 0) lines.push(`  Screens: ${f.screens.join(", ")}`);
      if (f.endpoints.length > 0) lines.push(`  APIs: ${f.endpoints.join(", ")}`);
      lines.push("");
    }
  }

  if (guide.screens.length > 0) {
    lines.push("## Screens\n");
    for (const s of guide.screens) {
      lines.push(`  - **${s.name}** \`${s.route}\` ${s.description || ""}`);
    }
    lines.push("");
  }

  if (guide.keyEndpoints.length > 0) {
    lines.push("## API Endpoints\n");
    for (const e of guide.keyEndpoints) {
      lines.push(`  - **${e.method} ${e.path}** ${e.description || ""}`);
    }
    lines.push("");
  }

  if (guide.specialists.length > 0) {
    lines.push("## Domain Specialists\n");
    for (const s of guide.specialists) {
      lines.push(`  - **${s.name}** (${s.fileCount} files): ${s.description}`);
    }
    lines.push("");
  }

  lines.push("## Knowledge Stats\n");
  lines.push(`  Knowledge nodes: ${guide.knowledgeStats.nodes}`);
  lines.push(`  Open mysteries: ${guide.knowledgeStats.mysteries}`);
  lines.push(`  Coverage: ${(guide.knowledgeStats.coverage * 100).toFixed(1)}%`);
  lines.push("");

  if (guide.gettingStarted.length > 0) {
    lines.push("## Getting Started\n");
    lines.push("Try these commands:\n");
    for (const cmd of guide.gettingStarted) {
      lines.push(`  $ ${cmd}`);
    }
  }

  return lines.join("\n");
}
