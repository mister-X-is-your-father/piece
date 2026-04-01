import Anthropic from "@anthropic-ai/sdk";
import pLimit from "p-limit";
import { logger } from "../utils/logger.js";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
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
