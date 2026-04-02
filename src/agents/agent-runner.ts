import { callAgentWithRetry, createLimiter, type AgentResponse } from "../claude/client.js";
import { logger } from "../utils/logger.js";

export interface AgentTask {
  id: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface AgentTaskResult {
  id: string;
  response: AgentResponse;
  durationMs: number;
}

/**
 * Run multiple agent tasks with concurrency control.
 * Core infrastructure for running Specialist agents in parallel.
 */
export async function runAgentTasks(
  tasks: AgentTask[],
  concurrency: number
): Promise<AgentTaskResult[]> {
  const limiter = createLimiter(concurrency);
  let completed = 0;

  const promises = tasks.map((task) =>
    limiter(async (): Promise<AgentTaskResult | null> => {
      const start = Date.now();
      logger.debug(`Running agent task: ${task.id}`);

      try {
        const response = await callAgentWithRetry({
          model: task.model,
          systemPrompt: task.systemPrompt,
          userPrompt: task.userPrompt,
          maxTokens: task.maxTokens,
        });

        completed++;
        const duration = Date.now() - start;
        logger.debug(
          `Agent task ${task.id} completed (${completed}/${tasks.length}) in ${duration}ms — ${response.inputTokens} in, ${response.outputTokens} out`
        );

        return {
          id: task.id,
          response,
          durationMs: duration,
        };
      } catch (err) {
        completed++;
        logger.error(`Agent task ${task.id} failed (${completed}/${tasks.length}): ${err}`);
        // Return a fallback empty response instead of crashing the whole batch
        return {
          id: task.id,
          response: { content: `[Analysis failed for ${task.id}]`, inputTokens: 0, outputTokens: 0 },
          durationMs: Date.now() - start,
        };
      }
    })
  );

  const results = await Promise.all(promises);
  return results.filter((r): r is AgentTaskResult => r !== null);
}

/**
 * Run a single agent task.
 */
export async function runSingleAgent(task: AgentTask): Promise<AgentTaskResult> {
  const results = await runAgentTasks([task], 1);
  return results[0];
}

/**
 * Compute total token usage from results.
 */
export function computeTokenUsage(results: AgentTaskResult[]): {
  totalInput: number;
  totalOutput: number;
} {
  return results.reduce(
    (acc, r) => ({
      totalInput: acc.totalInput + r.response.inputTokens,
      totalOutput: acc.totalOutput + r.response.outputTokens,
    }),
    { totalInput: 0, totalOutput: 0 }
  );
}
