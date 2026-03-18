/**
 * Retry Framework with Observation Truncation (inspired by SWE-agent).
 *
 * Handles:
 * - Tool execution failures with structured retry
 * - Format errors in provider JSON output
 * - Observation truncation to prevent context explosion
 * - Max-requery limits per tool call
 */

export interface RetryPolicy {
  maxRetries: number;
  maxObservationLength: number;
  truncationStrategy: "head-tail" | "tail-only" | "head-only";
  retryableErrors: RegExp[];
  fatalErrors: RegExp[];
}

export interface RetryResult<T> {
  value: T | null;
  attempts: number;
  lastError: string | null;
  truncated: boolean;
}

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 3,
  maxObservationLength: 10_000,
  truncationStrategy: "head-tail",
  retryableErrors: [
    /Expected a non-empty string/i,
    /JSON.*parse/i,
    /ENOENT/i,
    /EACCES/i,
    /timeout/i,
    /ETIMEDOUT/i,
    /rate limit/i,
    /429/,
    /500/,
    /502/,
    /503/,
  ],
  fatalErrors: [
    /Unknown tool/i,
    /not allowed for role/i,
    /Path escapes workspace/i,
  ]
};

export function createRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_POLICY
): Promise<RetryResult<T>> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= policy.maxRetries + 1; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt, lastError: null, truncated: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;

      // Fatal errors — don't retry
      if (policy.fatalErrors.some((re) => re.test(message))) {
        return { value: null, attempts: attempt, lastError: message, truncated: false };
      }

      // Not retryable — don't retry
      if (!policy.retryableErrors.some((re) => re.test(message))) {
        return { value: null, attempts: attempt, lastError: message, truncated: false };
      }

      // Last attempt — give up
      if (attempt >= policy.maxRetries + 1) {
        return { value: null, attempts: attempt, lastError: message, truncated: false };
      }

      // Backoff before retry
      await sleep(Math.min(250 * 2 ** (attempt - 1), 2000));
    }
  }

  return { value: null, attempts: policy.maxRetries + 1, lastError, truncated: false };
}

export function truncateObservation(text: string, policy: RetryPolicy = DEFAULT_POLICY): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= policy.maxObservationLength) {
    return { text, truncated: false };
  }

  const half = Math.floor(policy.maxObservationLength / 2);
  switch (policy.truncationStrategy) {
    case "head-tail":
      return {
        text: text.slice(0, half) + `\n\n...[${text.length - policy.maxObservationLength} chars truncated]...\n\n` + text.slice(-half),
        truncated: true
      };
    case "tail-only":
      return {
        text: `...[${text.length - policy.maxObservationLength} chars truncated]...\n` + text.slice(-policy.maxObservationLength),
        truncated: true
      };
    case "head-only":
      return {
        text: text.slice(0, policy.maxObservationLength) + `\n...[${text.length - policy.maxObservationLength} chars truncated]...`,
        truncated: true
      };
  }
}

/**
 * Parse provider JSON output with retry on format errors.
 * Handles common LLM output issues: markdown fences, trailing text, partial JSON.
 */
export function parseJsonWithRecovery(raw: string): { parsed: unknown; recovered: boolean } {
  // Try direct parse
  try {
    return { parsed: JSON.parse(raw), recovered: false };
  } catch {
    // continue
  }

  // Try extracting from markdown fence
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return { parsed: JSON.parse(fenced[1].trim()), recovered: true };
    } catch {
      // continue
    }
  }

  // Try finding balanced braces
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return { parsed: JSON.parse(raw.slice(firstBrace, lastBrace + 1)), recovered: true };
    } catch {
      // continue
    }
  }

  // Try array
  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      return { parsed: JSON.parse(raw.slice(firstBracket, lastBracket + 1)), recovered: true };
    } catch {
      // continue
    }
  }

  throw new Error(`Failed to parse JSON after recovery attempts: ${raw.slice(0, 200)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
