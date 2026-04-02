import { spawn } from "node:child_process";
import pLimit from "p-limit";
import { logger } from "../utils/logger.js";

// --- Backend Selection ---

export type Backend = "claude-code" | "api";

let currentBackend: Backend = detectBackend();

function detectBackend(): Backend {
  // If API credentials are available, prefer API (works in remote triggers)
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return "api";
  }
  // Default: Claude Code CLI (local development)
  return "claude-code";
}

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
  const fullPrompt = `${req.systemPrompt}\n\n---\n\n${req.userPrompt}`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p", "-",            // read prompt from stdin
        "--output-format", "json",
        "--max-turns", "1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    // Write prompt via stdin (no arg length limit)
    child.stdin.write(fullPrompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude Code timed out after 5 minutes"));
    }, 300_000);

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0 && !stdout) {
        reject(new Error(`Claude Code exited with code ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as ClaudeCliResult;

        if (parsed.is_error) {
          reject(new Error(`Claude Code error: ${parsed.result}`));
          return;
        }

        let inputTokens = 0;
        let outputTokens = 0;
        if (parsed.modelUsage) {
          for (const usage of Object.values(parsed.modelUsage)) {
            inputTokens += usage.inputTokens || 0;
            outputTokens += usage.outputTokens || 0;
          }
        }

        resolve({
          content: parsed.result,
          inputTokens,
          outputTokens,
        });
      } catch (err) {
        reject(new Error(`Failed to parse Claude Code output: ${(err as Error).message}\nstdout: ${stdout.slice(0, 200)}`));
      }
    });
  });
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
