import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import { logger } from "../utils/logger.js";

let client: Anthropic | null = null;

/**
 * Load .env file and inject into process.env.
 * Supports ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN.
 */
function loadEnvFile(): void {
  const paths = [
    join(process.cwd(), ".env"),
    join(process.env.HOME || "", ".env"),
  ];

  for (const envPath of paths) {
    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // File not found, skip
    }
  }
}

/**
 * Get Anthropic client with support for multiple auth methods:
 *
 * 1. ANTHROPIC_API_KEY env var — standard API key (sk-ant-...)
 * 2. ANTHROPIC_AUTH_TOKEN env var — Bearer token for Max/定額課金 plans
 * 3. .env file in CWD or home directory
 *
 * Max mode (定額課金) uses authToken (Bearer) authentication.
 * Standard API uses apiKey (X-Api-Key) authentication.
 */
export function getClient(): Anthropic {
  if (!client) {
    // Load .env file first
    loadEnvFile();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;

    if (!apiKey && !authToken) {
      console.error(
        `Error: No Anthropic credentials found.\n\n` +
        `Set one of the following:\n` +
        `  export ANTHROPIC_API_KEY="sk-ant-..."     # Standard API\n` +
        `  export ANTHROPIC_AUTH_TOKEN="..."          # Max/定額課金プラン\n\n` +
        `Or add to .env file in project root or home directory.`
      );
      process.exit(1);
    }

    if (authToken) {
      logger.info("Using auth token (Max/定額課金 mode)");
      client = new Anthropic({
        authToken,
        apiKey: undefined,
      });
    } else {
      client = new Anthropic({ apiKey });
    }
  }
  return client;
}

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

export async function callAgent(req: AgentRequest): Promise<AgentResponse> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
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
        err instanceof Error && err.message.includes("429");
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
