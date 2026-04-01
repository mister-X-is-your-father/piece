/**
 * Application Detector
 *
 * コードからWebアプリの構造要素を自動検出:
 *   - Screens (画面/ページ)
 *   - Endpoints (API)
 *   - Handlers (操作ハンドラ)
 *   - Services (ビジネスロジック)
 *   - Middleware
 */

import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type { FileEntry } from "../config/schema.js";
import { logger } from "../utils/logger.js";

// --- Detection Results ---

export interface DetectedScreen {
  filePath: string;
  route: string;
  componentName: string | null;
  framework: string;
  hasInteractiveElements: boolean;
  handlers: string[];
  stateVars: string[];
}

export interface DetectedEndpoint {
  filePath: string;
  method: string;
  path: string;
  handlerFunction: string | null;
  framework: string;
}

export interface DetectedHandler {
  filePath: string;
  name: string;
  triggerType: "click" | "submit" | "input" | "navigate" | "load" | "other";
  startLine: number;
  endLine: number;
}

export interface DetectedService {
  filePath: string;
  name: string;
  kind: "service" | "repository" | "usecase" | "manager" | "hook";
}

export interface DetectedMiddleware {
  filePath: string;
  name: string;
  framework: string;
}

export interface AppDetectionResult {
  screens: DetectedScreen[];
  endpoints: DetectedEndpoint[];
  handlers: DetectedHandler[];
  services: DetectedService[];
  middleware: DetectedMiddleware[];
  framework: string | null;
}

// --- Main Detection ---

export async function detectAppStructure(
  rootPath: string,
  files: FileEntry[]
): Promise<AppDetectionResult> {
  const result: AppDetectionResult = {
    screens: [],
    endpoints: [],
    handlers: [],
    services: [],
    middleware: [],
    framework: null,
  };

  // Detect framework
  result.framework = await detectFramework(rootPath, files);
  logger.info(`Detected framework: ${result.framework || "unknown"}`);

  for (const file of files) {
    if (file.category !== "source") continue;

    try {
      const content = await readFile(file.path, "utf-8");
      const relPath = file.relativePath;

      // Screen detection
      const screen = detectScreen(relPath, content, result.framework);
      if (screen) result.screens.push(screen);

      // Endpoint detection
      const endpoints = detectEndpoints(relPath, content, result.framework);
      result.endpoints.push(...endpoints);

      // Handler detection
      const handlers = detectHandlers(relPath, content);
      result.handlers.push(...handlers);

      // Service detection
      const service = detectService(relPath, content);
      if (service) result.services.push(service);

      // Middleware detection
      const mw = detectMiddleware(relPath, content);
      if (mw) result.middleware.push(mw);
    } catch {
      // Skip unreadable files
    }
  }

  logger.info(
    `App detection: ${result.screens.length} screens, ${result.endpoints.length} endpoints, ` +
    `${result.handlers.length} handlers, ${result.services.length} services, ${result.middleware.length} middleware`
  );

  return result;
}

// --- Framework Detection ---

async function detectFramework(
  rootPath: string,
  files: FileEntry[]
): Promise<string | null> {
  const fileNames = new Set(files.map((f) => f.relativePath));

  // Next.js
  if (
    fileNames.has("next.config.js") ||
    fileNames.has("next.config.mjs") ||
    fileNames.has("next.config.ts") ||
    files.some((f) => f.relativePath.match(/\/app\/.*\/page\.(tsx|jsx)$/))
  ) {
    return "nextjs";
  }

  // Nuxt/Vue
  if (files.some((f) => f.relativePath.endsWith(".vue"))) return "vue";

  // SvelteKit
  if (files.some((f) => f.relativePath.includes("+page.svelte"))) return "sveltekit";

  // Express (check package.json)
  try {
    const pkg = await readFile(join(rootPath, "package.json"), "utf-8");
    if (pkg.includes('"express"')) return "express";
    if (pkg.includes('"fastify"')) return "fastify";
    if (pkg.includes('"@nestjs/core"')) return "nestjs";
    if (pkg.includes('"hono"')) return "hono";
  } catch { /* no package.json */ }

  // Python
  if (files.some((f) => f.relativePath.endsWith(".py"))) {
    for (const f of files) {
      if (!f.relativePath.endsWith(".py")) continue;
      try {
        const content = await readFile(f.path, "utf-8");
        if (content.includes("FastAPI")) return "fastapi";
        if (content.includes("Flask")) return "flask";
        if (content.includes("Django")) return "django";
      } catch { /* skip */ }
    }
  }

  return null;
}

// --- Screen Detection ---

function detectScreen(
  relPath: string,
  content: string,
  framework: string | null
): DetectedScreen | null {
  let isScreen = false;
  let route = "";
  let fw = framework || "unknown";

  // Next.js App Router: /app/**/page.tsx
  if (relPath.match(/\/app\/.*\/page\.(tsx|jsx|ts|js)$/)) {
    isScreen = true;
    route = "/" + relPath
      .replace(/^src\//, "")
      .replace(/^app\//, "")
      .replace(/\/page\.(tsx|jsx|ts|js)$/, "")
      .replace(/\([^)]+\)\/?/g, "") // Remove route groups
      .replace(/\/+/g, "/")
      .replace(/\/$/, "")
      || "/";
    fw = "nextjs";
  }

  // Next.js Pages Router: /pages/*.tsx (not api/)
  else if (relPath.match(/\/pages\/(?!api\/).*\.(tsx|jsx|ts|js)$/) && !relPath.includes("_app") && !relPath.includes("_document")) {
    isScreen = true;
    route = "/" + relPath
      .replace(/^src\//, "")
      .replace(/^pages\//, "")
      .replace(/\.(tsx|jsx|ts|js)$/, "")
      .replace(/\/index$/, "")
      || "/";
    fw = "nextjs-pages";
  }

  // Vue/Nuxt pages
  else if (relPath.match(/\/pages\/.*\.vue$/)) {
    isScreen = true;
    route = "/" + relPath.replace(/\/pages\//, "").replace(/\.vue$/, "").replace(/\/index$/, "");
    fw = "nuxt";
  }

  // SvelteKit
  else if (relPath.includes("+page.svelte")) {
    isScreen = true;
    route = "/" + dirname(relPath).replace(/.*routes\//, "");
    fw = "sveltekit";
  }

  // Generic: exported *Page function
  else if (content.match(/export\s+(?:default\s+)?function\s+\w+Page\b/)) {
    isScreen = true;
    const match = content.match(/export\s+(?:default\s+)?function\s+(\w+Page)/);
    route = match ? `/${match[1].replace(/Page$/, "").toLowerCase()}` : "/unknown";
    fw = "react";
  }

  if (!isScreen) return null;

  // Extract component name
  const compMatch = content.match(/export\s+(?:default\s+)?function\s+(\w+)/);
  const componentName = compMatch ? compMatch[1] : null;

  // Detect interactive elements
  const handlers: string[] = [];
  const handlerRegex = /(?:const|function)\s+(handle\w+)\s*=/g;
  let m;
  while ((m = handlerRegex.exec(content)) !== null) {
    handlers.push(m[1]);
  }

  const stateVars: string[] = [];
  const stateRegex = /const\s+\[(\w+),\s*set\w+\]\s*=\s*useState/g;
  while ((m = stateRegex.exec(content)) !== null) {
    stateVars.push(m[1]);
  }

  return {
    filePath: relPath,
    route,
    componentName,
    framework: fw,
    hasInteractiveElements: handlers.length > 0 || stateVars.length > 0,
    handlers,
    stateVars,
  };
}

// --- Endpoint Detection ---

function detectEndpoints(
  relPath: string,
  content: string,
  framework: string | null
): DetectedEndpoint[] {
  const endpoints: DetectedEndpoint[] = [];

  // Next.js Route Handlers: /app/api/**/route.ts
  if (relPath.match(/\/app\/api\/.*\/route\.(ts|js)$/)) {
    const apiPath = "/" + relPath
      .replace(/^src\//, "")
      .replace(/^app\//, "")
      .replace(/\/route\.(ts|js)$/, "")
      .replace(/\[([^\]]+)\]/g, ":$1"); // [id] → :id

    const methodRegex = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|DELETE|PATCH|HEAD)/g;
    let m;
    while ((m = methodRegex.exec(content)) !== null) {
      endpoints.push({
        filePath: relPath,
        method: m[1],
        path: apiPath,
        handlerFunction: m[1],
        framework: "nextjs",
      });
    }

    // If no explicit methods found, check for default export
    if (endpoints.length === 0 && content.match(/export\s+default/)) {
      endpoints.push({
        filePath: relPath,
        method: "ALL",
        path: apiPath,
        handlerFunction: "default",
        framework: "nextjs",
      });
    }
  }

  // Express-style: router.get/post/put/delete
  const expressRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let m2;
  while ((m2 = expressRegex.exec(content)) !== null) {
    endpoints.push({
      filePath: relPath,
      method: m2[1].toUpperCase(),
      path: m2[2],
      handlerFunction: null,
      framework: framework || "express",
    });
  }

  // FastAPI: @app.get("/path")
  const fastapiRegex = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;
  while ((m2 = fastapiRegex.exec(content)) !== null) {
    endpoints.push({
      filePath: relPath,
      method: m2[1].toUpperCase(),
      path: m2[2],
      handlerFunction: null,
      framework: "fastapi",
    });
  }

  return endpoints;
}

// --- Handler Detection ---

function detectHandlers(relPath: string, content: string): DetectedHandler[] {
  const handlers: DetectedHandler[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // handle* functions
    const handleMatch = line.match(/(?:const|function)\s+(handle\w+)\s*=/);
    if (handleMatch) {
      const triggerType = inferTriggerType(handleMatch[1]);
      handlers.push({
        filePath: relPath,
        name: handleMatch[1],
        triggerType,
        startLine: i + 1,
        endLine: Math.min(i + 20, lines.length), // rough estimate
      });
    }

    // onSubmit/onClick/onChange assignments
    const eventMatch = line.match(/on(Submit|Click|Change|Focus|Blur|KeyDown|KeyUp)\s*=\s*\{?\s*(\w+)/);
    if (eventMatch) {
      handlers.push({
        filePath: relPath,
        name: eventMatch[2] || `on${eventMatch[1]}`,
        triggerType: eventMatch[1].toLowerCase() === "submit" ? "submit" : eventMatch[1].toLowerCase() === "click" ? "click" : "input",
        startLine: i + 1,
        endLine: i + 1,
      });
    }
  }

  return handlers;
}

function inferTriggerType(name: string): DetectedHandler["triggerType"] {
  const lower = name.toLowerCase();
  if (lower.includes("submit") || lower.includes("form")) return "submit";
  if (lower.includes("click") || lower.includes("press") || lower.includes("tap")) return "click";
  if (lower.includes("change") || lower.includes("input") || lower.includes("type")) return "input";
  if (lower.includes("navigate") || lower.includes("redirect") || lower.includes("route")) return "navigate";
  if (lower.includes("load") || lower.includes("init") || lower.includes("mount")) return "load";
  return "other";
}

// --- Service Detection ---

function detectService(relPath: string, content: string): DetectedService | null {
  // Class-based services
  const classMatch = content.match(/(?:export\s+)?class\s+(\w+)(Service|Repository|UseCase|Manager)\b/);
  if (classMatch) {
    return {
      filePath: relPath,
      name: classMatch[1] + classMatch[2],
      kind: classMatch[2].toLowerCase() as DetectedService["kind"],
    };
  }

  // Path-based detection
  if (relPath.match(/\/(services|repositories|use-cases|usecases)\//)) {
    const name = basename(relPath).replace(/\.\w+$/, "");
    return { filePath: relPath, name, kind: "service" };
  }

  // React hooks (custom)
  if (relPath.match(/\/hooks\//) || content.match(/^export\s+function\s+use[A-Z]/m)) {
    const hookMatch = content.match(/export\s+function\s+(use\w+)/);
    if (hookMatch) {
      return { filePath: relPath, name: hookMatch[1], kind: "hook" };
    }
  }

  return null;
}

// --- Middleware Detection ---

function detectMiddleware(relPath: string, content: string): DetectedMiddleware | null {
  // Next.js middleware
  if (relPath.match(/\/middleware\.(ts|js)$/) && content.includes("NextRequest")) {
    return { filePath: relPath, name: "middleware", framework: "nextjs" };
  }

  // Express middleware in middleware/ directory
  if (relPath.includes("/middleware/")) {
    const name = basename(relPath).replace(/\.\w+$/, "");
    return { filePath: relPath, name, framework: "express" };
  }

  // Generic: exports middleware function
  if (content.match(/export\s+(?:async\s+)?function\s+middleware/)) {
    return { filePath: relPath, name: "middleware", framework: "generic" };
  }

  return null;
}
