import { resolve } from "node:path";
import ora from "ora";
import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { getKnowledgeDB, closeKnowledgeDB } from "../knowledge/db.js";
import { discoverProjectFiles } from "../analyzer/discovery.js";
import { detectAppStructure } from "../analyzer/app-detector.js";
import { AppMapStore, exportAppMapMarkdown } from "../knowledge/app-map.js";
import { runSingleAgent, type AgentTask } from "../agents/agent-runner.js";
import { APP_MAPPER_SYSTEM, buildAppMapPrompt } from "../agents/prompts/app-mapper.js";
import { logger } from "../utils/logger.js";

export interface AppMapOptions {
  screens?: boolean;
  endpoints?: boolean;
  features?: boolean;
  operations?: boolean;
  connections?: boolean;
  export?: boolean;
  trace?: string;
  verbose?: boolean;
}

export async function runAppMap(
  targetPath: string,
  options: AppMapOptions
): Promise<void> {
  const rootPath = resolve(targetPath);
  const config = await loadConfig(rootPath);
  const scribePath = resolve(rootPath, config.output.directory);
  const db = getKnowledgeDB(scribePath);
  const store = new AppMapStore(db);

  try {
    // If showing specific views
    if (options.screens || options.endpoints || options.features || options.operations) {
      showView(store, options);
      return;
    }

    if (options.export) {
      const outputDir = resolve(scribePath, "app-map");
      await exportAppMapMarkdown(db, outputDir);
      console.log(chalk.green(`App map exported to ${outputDir}`));
      return;
    }

    // Full detection + AI mapping
    const spinner = ora("Detecting application structure...").start();

    // Phase 1: Auto-detect
    const files = await discoverProjectFiles(rootPath, config);
    const detected = await detectAppStructure(rootPath, files);

    spinner.succeed(
      `Detected: ${detected.screens.length} screens, ${detected.endpoints.length} endpoints, ` +
      `${detected.handlers.length} handlers, ${detected.services.length} services`
    );

    if (detected.screens.length === 0 && detected.endpoints.length === 0) {
      console.log(chalk.yellow("No screens or endpoints detected. Is this a web app?"));
      return;
    }

    // Phase 2: AI inference
    const spinner2 = ora("AI analyzing connections and naming...").start();

    const detectionJson = JSON.stringify({
      framework: detected.framework,
      screens: detected.screens.map(s => ({
        file: s.filePath, route: s.route, component: s.componentName,
        handlers: s.handlers, state: s.stateVars,
      })),
      endpoints: detected.endpoints.map(e => ({
        file: e.filePath, method: e.method, path: e.path, handler: e.handlerFunction,
      })),
      handlers: detected.handlers.map(h => ({
        file: h.filePath, name: h.name, trigger: h.triggerType,
      })),
      services: detected.services.map(s => ({
        file: s.filePath, name: s.name, kind: s.kind,
      })),
      middleware: detected.middleware.map(m => ({
        file: m.filePath, name: m.name,
      })),
    }, null, 2);

    const task: AgentTask = {
      id: "app-mapper",
      model: config.agents.analysisModel,
      systemPrompt: APP_MAPPER_SYSTEM,
      userPrompt: buildAppMapPrompt(detectionJson, `Framework: ${detected.framework || "unknown"}`),
      maxTokens: 8192,
    };

    const result = await runSingleAgent(task);

    let mapped;
    try {
      const jsonStr = result.response.content
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      mapped = JSON.parse(jsonStr);
    } catch {
      spinner2.fail("Failed to parse AI mapping");
      return;
    }

    spinner2.succeed("AI mapping complete");

    // Phase 3: Store results
    const spinner3 = ora("Storing app map...").start();
    store.clear(); // Fresh detection

    // Store screens
    const screenIdMap = new Map<string, string>();
    for (const s of mapped.screens || []) {
      const id = store.insertScreen({
        name: s.name,
        route: s.route,
        description: s.description,
        filePath: s.file_path,
      });
      screenIdMap.set(s.name, id);
    }

    // Store endpoints
    const endpointIdMap = new Map<string, string>();
    for (const e of mapped.endpoints || []) {
      const id = store.insertEndpoint({
        method: e.method,
        path: e.path,
        description: e.description,
        handlerFile: e.file_path,
      });
      endpointIdMap.set(`${e.method} ${e.path}`, id);
    }

    // Store features + connections
    for (const f of mapped.features || []) {
      const fId = store.insertFeature({ name: f.name, description: f.description });

      for (const screenName of f.screens || []) {
        const sId = screenIdMap.get(screenName);
        if (sId) store.connectFeature(fId, "screen", sId, "belongs_to");
      }
      for (const epKey of f.endpoints || []) {
        const eId = endpointIdMap.get(epKey);
        if (eId) store.connectFeature(fId, "endpoint", eId, "provides");
      }
    }

    // Store connections as node_links
    for (const conn of mapped.connections || []) {
      const fromId = screenIdMap.get(conn.from) || endpointIdMap.get(conn.from);
      const toId = screenIdMap.get(conn.to) || endpointIdMap.get(conn.to);
      if (fromId && toId) {
        db.prepare(
          "INSERT OR IGNORE INTO node_links (id, source_id, target_id, link_type, description) VALUES (?, ?, ?, 'related', ?)"
        ).run(generateLocalId(), fromId, toId, `${conn.relation}: ${conn.via || ""}`);
      }
    }

    // Store operation flows
    for (const flow of mapped.operation_flows || []) {
      const flowId = store.insertOperationFlow({
        name: flow.name,
        description: flow.feature || "",
      });
      for (const step of flow.steps || []) {
        store.insertFlowStep({
          flowId,
          stepOrder: step.order,
          actionType: step.action,
          description: step.description,
          screenId: step.screen ? screenIdMap.get(step.screen) : undefined,
          endpointId: step.endpoint ? endpointIdMap.get(step.endpoint) : undefined,
        });
      }
    }

    spinner3.succeed("App map stored");

    // Phase 4: Export markdown
    const outputDir = resolve(scribePath, "app-map");
    await exportAppMapMarkdown(db, outputDir);

    // Summary
    const stats = store.getStats();
    console.log(chalk.cyan("\n━━━ Application Map ━━━\n"));
    console.log(`  Framework: ${chalk.cyan(detected.framework || "unknown")}`);
    console.log(`  Screens: ${stats.screens}`);
    console.log(`  Endpoints: ${stats.endpoints}`);
    console.log(`  Operations: ${stats.operations}`);
    console.log(`  Features: ${stats.features}`);
    console.log(`  Flows: ${stats.flows}`);
    console.log(chalk.gray(`\n  Markdown: ${outputDir}`));
    console.log(chalk.gray(`  Edit in Obsidian, then 'piece reindex' to sync changes`));
  } finally {
    closeKnowledgeDB();
  }
}

function showView(store: AppMapStore, options: AppMapOptions): void {
  if (options.screens) {
    const screens = store.getScreens();
    console.log(chalk.cyan("━━━ 画面一覧 ━━━\n"));
    for (const s of screens) {
      console.log(`  ${chalk.cyan(s.name)} ${chalk.gray(s.route)}`);
      console.log(chalk.gray(`    ${s.file_path}`));
      if (s.description) console.log(chalk.gray(`    ${s.description}`));
      console.log();
    }
  }

  if (options.endpoints) {
    const endpoints = store.getEndpoints();
    console.log(chalk.cyan("━━━ API一覧 ━━━\n"));
    for (const e of endpoints) {
      console.log(`  ${chalk.yellow(e.method)} ${chalk.cyan(e.path)}`);
      console.log(chalk.gray(`    ${e.handler_file}`));
      if (e.description) console.log(chalk.gray(`    ${e.description}`));
      console.log();
    }
  }

  if (options.features) {
    const features = store.getFeatures();
    console.log(chalk.cyan("━━━ 機能一覧 ━━━\n"));
    for (const f of features) {
      console.log(`  ${chalk.cyan(f.name)}`);
      if (f.description) console.log(chalk.gray(`    ${f.description}`));
      const conns = store.getFeatureConnections(f.id);
      for (const c of conns) {
        console.log(chalk.gray(`    → ${c.target_type}: ${c.role || ""}`));
      }
      console.log();
    }
  }

  if (options.operations) {
    const ops = store.getOperations();
    console.log(chalk.cyan("━━━ 操作一覧 ━━━\n"));
    for (const o of ops) {
      console.log(`  ${chalk.cyan(o.name)} [${o.trigger_type}]`);
      if (o.description) console.log(chalk.gray(`    ${o.description}`));
      console.log();
    }
  }
}

function generateLocalId(): string {
  return crypto.randomUUID();
}
