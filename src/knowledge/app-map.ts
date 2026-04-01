/**
 * Application Map Store
 *
 * 画面・API・操作・機能をSQLiteに保存し、
 * knowledge_nodesとしても登録してNeuron検索でヒットさせる。
 * Markdownにも出力してObsidianで閲覧・編集可能にする。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { generateId } from "./db.js";
import { indexNodeTokens } from "./neuron.js";
import { logger } from "../utils/logger.js";

// --- Store ---

export class AppMapStore {
  constructor(private db: Database.Database) {}

  // --- Screens ---

  insertScreen(screen: {
    name: string;
    route?: string;
    description?: string;
    filePath: string;
    componentName?: string;
    layout?: string;
  }): string {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO screens (id, name, route, description, file_path, component_name, layout)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, screen.name, screen.route ?? null, screen.description ?? null,
        screen.filePath, screen.componentName ?? null, screen.layout ?? null);

    // Also register as knowledge_node
    this.registerAsKnowledge(id, `画面: ${screen.name}`,
      `${screen.description || screen.name}\nRoute: ${screen.route || "N/A"}\nFile: ${screen.filePath}`,
      ["screen", screen.name, screen.route || ""].filter(Boolean)
    );

    return id;
  }

  getScreens(): Array<{ id: string; name: string; route: string; description: string; file_path: string; status: string }> {
    return this.db.prepare("SELECT * FROM screens ORDER BY route").all() as any[];
  }

  // --- Endpoints ---

  insertEndpoint(ep: {
    method: string;
    path: string;
    description?: string;
    handlerFile: string;
    handlerFunction?: string;
  }): string {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO endpoints (id, method, path, description, handler_file, handler_function)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, ep.method, ep.path, ep.description ?? null, ep.handlerFile, ep.handlerFunction ?? null);

    this.registerAsKnowledge(id, `API: ${ep.method} ${ep.path}`,
      `${ep.description || ""}\nHandler: ${ep.handlerFile}${ep.handlerFunction ? `:${ep.handlerFunction}` : ""}`,
      ["endpoint", "api", ep.method.toLowerCase(), ep.path]
    );

    return id;
  }

  getEndpoints(): Array<{ id: string; method: string; path: string; description: string; handler_file: string; status: string }> {
    return this.db.prepare("SELECT * FROM endpoints ORDER BY path, method").all() as any[];
  }

  // --- Operations ---

  insertOperation(op: {
    screenId?: string;
    name: string;
    description?: string;
    triggerType: string;
    handlerFile?: string;
    handlerFunction?: string;
    callsEndpointId?: string;
  }): string {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO operations (id, screen_id, name, description, trigger_type, handler_file, handler_function, calls_endpoint_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, op.screenId ?? null, op.name, op.description ?? null, op.triggerType,
        op.handlerFile ?? null, op.handlerFunction ?? null, op.callsEndpointId ?? null);

    this.registerAsKnowledge(id, `操作: ${op.name}`,
      `${op.description || op.name}\nTrigger: ${op.triggerType}\nHandler: ${op.handlerFunction || "N/A"}`,
      ["operation", op.triggerType, op.name]
    );

    return id;
  }

  getOperations(): Array<{ id: string; name: string; description: string; trigger_type: string; screen_id: string }> {
    return this.db.prepare("SELECT * FROM operations ORDER BY screen_id, step_order").all() as any[];
  }

  // --- Features ---

  insertFeature(feature: { name: string; description?: string }): string {
    const id = generateId();
    this.db
      .prepare("INSERT INTO features (id, name, description) VALUES (?, ?, ?)")
      .run(id, feature.name, feature.description ?? null);

    this.registerAsKnowledge(id, `機能: ${feature.name}`,
      feature.description || feature.name,
      ["feature", feature.name]
    );

    return id;
  }

  connectFeature(featureId: string, targetType: string, targetId: string, role?: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO feature_connections (id, feature_id, target_type, target_id, role) VALUES (?, ?, ?, ?, ?)")
      .run(generateId(), featureId, targetType, targetId, role ?? null);

    // Link knowledge nodes
    this.db
      .prepare("INSERT OR IGNORE INTO node_links (id, source_id, target_id, link_type, description) VALUES (?, ?, ?, 'related', ?)")
      .run(generateId(), featureId, targetId, `feature:${targetType}`);
  }

  getFeatures(): Array<{ id: string; name: string; description: string }> {
    return this.db.prepare("SELECT * FROM features ORDER BY name").all() as any[];
  }

  getFeatureConnections(featureId: string): Array<{ target_type: string; target_id: string; role: string }> {
    return this.db.prepare("SELECT * FROM feature_connections WHERE feature_id = ?").all(featureId) as any[];
  }

  // --- Operation Flows ---

  insertOperationFlow(flow: { name: string; description?: string; featureId?: string }): string {
    const id = generateId();
    this.db
      .prepare("INSERT INTO operation_flows (id, name, description, feature_id) VALUES (?, ?, ?, ?)")
      .run(id, flow.name, flow.description ?? null, flow.featureId ?? null);
    return id;
  }

  insertFlowStep(step: {
    flowId: string;
    stepOrder: number;
    actionType: string;
    description: string;
    screenId?: string;
    operationId?: string;
    endpointId?: string;
    filePath?: string;
    lineNumber?: number;
    codeSnippet?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO operation_flow_steps
         (id, flow_id, step_order, action_type, description, screen_id, operation_id, endpoint_id, file_path, line_number, code_snippet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(generateId(), step.flowId, step.stepOrder, step.actionType, step.description,
        step.screenId ?? null, step.operationId ?? null, step.endpointId ?? null,
        step.filePath ?? null, step.lineNumber ?? null, step.codeSnippet ?? null);
  }

  // --- Knowledge Node Registration ---

  private registerAsKnowledge(id: string, summary: string, content: string, tags: string[]): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO knowledge_nodes (id, content, summary, node_type, confidence, specialist, source_question)
         VALUES (?, ?, ?, 'fact', 0.7, 'app-map', 'auto-detected')`
      )
      .run(id, content, summary);

    for (const tag of tags) {
      if (tag) {
        this.db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)").run(id, tag.toLowerCase());
      }
    }

    indexNodeTokens(this.db, id, content, summary, tags);
  }

  // --- Stats ---

  getStats(): { screens: number; endpoints: number; operations: number; features: number; flows: number } {
    return {
      screens: (this.db.prepare("SELECT COUNT(*) as c FROM screens").get() as any).c,
      endpoints: (this.db.prepare("SELECT COUNT(*) as c FROM endpoints").get() as any).c,
      operations: (this.db.prepare("SELECT COUNT(*) as c FROM operations").get() as any).c,
      features: (this.db.prepare("SELECT COUNT(*) as c FROM features").get() as any).c,
      flows: (this.db.prepare("SELECT COUNT(*) as c FROM operation_flows").get() as any).c,
    };
  }

  // --- Clear (for re-detection) ---

  clear(): void {
    this.db.prepare("DELETE FROM operation_flow_steps").run();
    this.db.prepare("DELETE FROM operation_flows").run();
    this.db.prepare("DELETE FROM feature_connections").run();
    this.db.prepare("DELETE FROM operations").run();
    this.db.prepare("DELETE FROM features").run();
    this.db.prepare("DELETE FROM endpoints").run();
    this.db.prepare("DELETE FROM screens").run();
  }
}

// --- Markdown Export ---

export async function exportAppMapMarkdown(
  db: Database.Database,
  outputDir: string
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const store = new AppMapStore(db);

  // Screens
  const screens = store.getScreens();
  let md = `# 画面一覧\n\n`;
  for (const s of screens) {
    md += `## ${s.name}\n- Route: \`${s.route}\`\n- File: \`${s.file_path}\`\n- ${s.description || ""}\n- Status: ${s.status}\n\n`;
  }
  await writeFile(join(outputDir, "screens.md"), md, "utf-8");

  // Endpoints
  const endpoints = store.getEndpoints();
  md = `# API一覧\n\n`;
  for (const e of endpoints) {
    md += `## ${e.method} ${e.path}\n- File: \`${e.handler_file}\`\n- ${e.description || ""}\n- Status: ${e.status}\n\n`;
  }
  await writeFile(join(outputDir, "endpoints.md"), md, "utf-8");

  // Features
  const features = store.getFeatures();
  md = `# 機能一覧\n\n`;
  for (const f of features) {
    md += `## ${f.name}\n${f.description || ""}\n\n`;
    const conns = store.getFeatureConnections(f.id);
    if (conns.length > 0) {
      md += `### 関連要素\n`;
      for (const c of conns) {
        md += `- ${c.target_type}: ${c.target_id} (${c.role || ""})\n`;
      }
      md += "\n";
    }
  }
  await writeFile(join(outputDir, "features.md"), md, "utf-8");

  // Operations
  const operations = store.getOperations();
  md = `# 操作一覧\n\n`;
  for (const o of operations) {
    md += `## ${o.name}\n- Trigger: ${o.trigger_type}\n- ${o.description || ""}\n\n`;
  }
  await writeFile(join(outputDir, "operations.md"), md, "utf-8");

  logger.info(`App map exported to ${outputDir}`);
}
