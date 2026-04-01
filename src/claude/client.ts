import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pLimit from "p-limit";
import { logger } from "../utils/logger.js";
import { generateId } from "../knowledge/db.js";

const execFileAsync = promisify(execFile);

// --- Backend Selection ---

export type Backend = "claude-code" | "api";

let currentBackend: Backend = "claude-code"; // default: Claude Code CLI

export function setBackend(backend: Backend): void {
  currentBackend = backend;
}

export function getBackend(): Backend {
  return currentBackend;
}

// --- Types ---

export interface AgentRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface AgentResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

// --- Claude Code Backend (default, no API key needed) ---

interface ClaudeCliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  duration_ms: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number }>;
}

async function callViaClaudeCode(req: AgentRequest): Promise<AgentResponse> {
  // Build the full prompt with system prompt embedded
  const fullPrompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`;

  // Write prompt to temp file to avoid arg length limits
  const tmpFile = join(tmpdir(), `scribe-prompt-${generateId()}.txt`);
  writeFileSync(tmpFile, fullPrompt, "utf-8");

  try {
    const { stdout } = await execFileAsync(
      "claude",
      [
        "-p", fullPrompt,
        "--output-format", "json",
        "--max-turns", "1",
        "--no-input",
      ],
      {
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: 300_000, // 5 minutes
        env: { ...process.env },
      }
    );

    const parsed = JSON.parse(stdout) as ClaudeCliResult;

    if (parsed.is_error) {
      throw new Error(`Claude Code error: ${parsed.result}`);
    }

    // Extract token usage from modelUsage
    let inputTokens = 0;
    let outputTokens = 0;
    if (parsed.modelUsage) {
      for (const usage of Object.values(parsed.modelUsage)) {
        inputTokens += usage.inputTokens || 0;
        outputTokens += usage.outputTokens || 0;
      }
    }

    return {
      content: parsed.result,
      inputTokens,
      outputTokens,
    };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// --- Direct API Backend (fallback if API key is set) ---

async function callViaApi(req: AgentRequest): Promise<AgentResponse> {
  // Lazy import to avoid requiring @anthropic-ai/sdk when not used
  const { default: Anthropic } = await import("@anthropic-ai/sdk");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;

  let client: InstanceType<typeof Anthropic>;
  if (authToken) {
    client = new Anthropic({ authToken, apiKey: undefined });
  } else if (apiKey) {
    client = new Anthropic({ apiKey });
  } else {
    throw new Error("No API credentials for direct API mode");
  }

  const response = await client.messages.create({
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    system: req.systemPrompt,
    messages: [{ role: "user", content: req.userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const content = textBlock ? textBlock.text : "";

  return {
    content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// --- Unified Call Interface ---

export async function callAgent(req: AgentRequest): Promise<AgentResponse> {
  if (currentBackend === "claude-code") {
    return callViaClaudeCode(req);
  }
  return callViaApi(req);
}

export function createLimiter(concurrency: number) {
  return pLimit(concurrency);
}

export async function callAgentWithRetry(
  req: AgentRequest,
  maxRetries = 3
): Promise<AgentResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callAgent(req);
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof Error &&
        (err.message.includes("429") || err.message.includes("rate"));
      if (isRateLimit && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`Rate limited, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}
