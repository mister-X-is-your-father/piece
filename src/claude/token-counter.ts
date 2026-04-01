// Simple token estimation without tiktoken dependency issues
// Uses the ~4 chars per token heuristic for English, ~2 for CJK

export function estimateTokens(text: string): number {
  // Count CJK characters
  const cjkCount = (text.match(/[\u3000-\u9fff\uf900-\ufaff]/g) || []).length;
  const nonCjkLength = text.length - cjkCount;

  // CJK: ~1.5 tokens per char, ASCII: ~0.25 tokens per char
  return Math.ceil(cjkCount * 1.5 + nonCjkLength * 0.25);
}

export function truncateToTokenBudget(
  text: string,
  maxTokens: number
): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  // Rough ratio to trim
  const ratio = maxTokens / estimated;
  const targetLen = Math.floor(text.length * ratio * 0.95); // 5% safety margin
  return text.slice(0, targetLen) + "\n\n[... truncated to fit token budget ...]";
}
