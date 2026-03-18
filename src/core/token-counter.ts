/**
 * Token Counting & Context Compaction.
 *
 * Manages the context window budget across the agent lifecycle.
 * When approaching the limit, automatically compacts context by:
 * - Summarizing older messages
 * - Dropping low-value context (duplicate tool results, verbose output)
 * - Switching to shorter edit formats
 *
 * Inspired by: Aider's context management, Plandex's token budgeting.
 */

import type { TokenBudget } from "./types.js";

/** Approximate token count using the 4-chars-per-token heuristic */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Create a token budget with model-specific limits */
export function createTokenBudget(modelId?: string): TokenBudget {
  // Default to 128K context window
  let maxTokens = 128_000;

  if (modelId?.includes("claude-opus") || modelId?.includes("claude-sonnet")) {
    maxTokens = 200_000;
  } else if (modelId?.includes("gpt-4o")) {
    maxTokens = 128_000;
  } else if (modelId?.includes("gemini")) {
    maxTokens = 1_000_000;
  }

  return {
    maxTokens,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    estimatedPromptTokens: 0,
    compactionThreshold: Math.floor(maxTokens * 0.75)
  };
}

/** Update budget with actual usage from a provider response */
export function updateBudget(
  budget: TokenBudget,
  inputTokens: number,
  outputTokens: number
): TokenBudget {
  return {
    ...budget,
    usedInputTokens: budget.usedInputTokens + inputTokens,
    usedOutputTokens: budget.usedOutputTokens + outputTokens
  };
}

/** Check if we need to compact context */
export function needsCompaction(budget: TokenBudget): boolean {
  return budget.estimatedPromptTokens >= budget.compactionThreshold;
}

/** Get remaining token capacity */
export function remainingTokens(budget: TokenBudget): number {
  return Math.max(0, budget.maxTokens - budget.estimatedPromptTokens);
}

/** Get usage percentage */
export function usagePercent(budget: TokenBudget): number {
  if (budget.maxTokens === 0) return 0;
  return Math.round((budget.estimatedPromptTokens / budget.maxTokens) * 100);
}

/**
 * Compact context by summarizing and truncating.
 * Returns a shorter version of the context that fits within budget.
 */
export function compactContext(
  context: string,
  targetTokens: number
): { compacted: string; originalTokens: number; compactedTokens: number } {
  const originalTokens = estimateTokens(context);
  if (originalTokens <= targetTokens) {
    return { compacted: context, originalTokens, compactedTokens: originalTokens };
  }

  const sections = context.split("\n\n");
  const scored = sections.map((section, index) => ({
    section,
    index,
    tokens: estimateTokens(section),
    priority: scoreSectionPriority(section)
  }));

  // Sort by priority (higher = more important)
  scored.sort((a, b) => b.priority - a.priority);

  // Greedily include sections up to budget
  const included: typeof scored = [];
  let totalTokens = 0;

  for (const item of scored) {
    if (totalTokens + item.tokens > targetTokens) continue;
    included.push(item);
    totalTokens += item.tokens;
  }

  // Restore original order
  included.sort((a, b) => a.index - b.index);

  const compacted = included.map((i) => i.section).join("\n\n");
  const droppedCount = sections.length - included.length;

  const header = droppedCount > 0
    ? `[Context compacted: ${droppedCount} sections dropped to fit token budget]\n\n`
    : "";

  return {
    compacted: header + compacted,
    originalTokens,
    compactedTokens: estimateTokens(header + compacted)
  };
}

/** Score a context section's importance for compaction decisions */
function scoreSectionPriority(section: string): number {
  let score = 50; // baseline

  // High value: task descriptions, constraints, instructions
  if (/^Task:/m.test(section)) score += 100;
  if (/^IMPORTANT/m.test(section)) score += 80;
  if (/constraint|requirement|must|should/i.test(section)) score += 30;

  // High value: error messages, failures
  if (/error|fail|crash|bug/i.test(section)) score += 60;

  // Medium value: code snippets
  if (/```|function |class |interface |const |import /m.test(section)) score += 40;

  // Low value: verbose tool output, long lists
  if (section.split("\n").length > 30) score -= 30;
  if (/\[\d+ chars truncated\]/.test(section)) score -= 40;

  // Very low value: session history, meta info
  if (/^Project memory:|^Repository summary:|^Hot files:/m.test(section)) score -= 20;

  return score;
}

/**
 * Summarize a long text into a shorter version.
 * Uses simple extractive summarization (first/last sentences per paragraph).
 */
export function extractiveSummary(text: string, maxTokens: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;

  const paragraphs = text.split("\n\n").filter(Boolean);
  const summaryParts: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const sentences = para.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length <= 2) {
      const paraTokens = estimateTokens(para);
      if (currentTokens + paraTokens <= maxTokens) {
        summaryParts.push(para);
        currentTokens += paraTokens;
      }
      continue;
    }

    // Take first and last sentence
    const summary = `${sentences[0].trim()}. ... ${sentences[sentences.length - 1].trim()}.`;
    const summaryTokens = estimateTokens(summary);
    if (currentTokens + summaryTokens <= maxTokens) {
      summaryParts.push(summary);
      currentTokens += summaryTokens;
    }
  }

  return summaryParts.join("\n\n");
}
