/**
 * Self-Healing Error Loop.
 *
 * Automatically detects, diagnoses, and fixes errors during execution.
 * When a tool call fails or a build/test breaks, this system:
 * 1. Classifies the error type
 * 2. Determines the appropriate recovery strategy
 * 3. Generates a fix prompt for the executor
 * 4. Validates the fix
 *
 * Inspired by: SWE-Agent's error recovery, AutoGPT's self-correction,
 * Codex's automatic retry with context.
 */

export type ErrorCategory =
  | "syntax"        // JSON parse, code syntax errors
  | "type"          // TypeScript/compiler type errors
  | "runtime"       // Runtime exceptions, crashes
  | "test"          // Test failures
  | "build"         // Build/compile failures
  | "permission"    // Access denied, auth failures
  | "network"       // Timeout, connection errors
  | "resource"      // File not found, disk full
  | "logic"         // Wrong output, unexpected behavior
  | "unknown";

export interface DiagnosedError {
  category: ErrorCategory;
  message: string;
  /** File path where error occurred, if identifiable */
  filePath?: string;
  /** Line number, if identifiable */
  lineNumber?: number;
  /** Suggested fix strategy */
  strategy: RecoveryStrategy;
  /** Confidence in the diagnosis (0-1) */
  confidence: number;
}

export type RecoveryStrategy =
  | "retry"              // Just retry the same operation
  | "retry-with-context" // Retry with error message as context
  | "fix-and-retry"      // Generate a fix, then retry
  | "rollback"           // Undo the last change and try different approach
  | "escalate"           // Give up and ask for human help
  | "skip"               // Skip this step and continue
  | "switch-model";      // Try a different LLM model

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  category: ErrorCategory;
  strategy: RecoveryStrategy;
  confidence: number;
}> = [
  // Syntax errors
  { pattern: /SyntaxError|Unexpected token|JSON.*parse/i, category: "syntax", strategy: "retry-with-context", confidence: 0.9 },
  { pattern: /Unterminated string|Invalid.*escape/i, category: "syntax", strategy: "retry-with-context", confidence: 0.85 },

  // Type errors
  { pattern: /TypeError|is not a function|Cannot read propert/i, category: "type", strategy: "fix-and-retry", confidence: 0.8 },
  { pattern: /TS\d{4}:|type.*not assignable|Property.*does not exist/i, category: "type", strategy: "fix-and-retry", confidence: 0.85 },

  // Build errors
  { pattern: /Build failed|tsc.*error|webpack.*error|ELIFECYCLE/i, category: "build", strategy: "fix-and-retry", confidence: 0.8 },
  { pattern: /Module not found|Cannot find module/i, category: "build", strategy: "fix-and-retry", confidence: 0.85 },

  // Test failures
  { pattern: /FAIL|AssertionError|expect.*toEqual|test.*failed/i, category: "test", strategy: "fix-and-retry", confidence: 0.75 },
  { pattern: /\d+ failed|\d+ failing/i, category: "test", strategy: "fix-and-retry", confidence: 0.7 },

  // Network errors
  { pattern: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch.*failed/i, category: "network", strategy: "retry", confidence: 0.9 },
  { pattern: /rate.?limit|429|503|502/i, category: "network", strategy: "retry", confidence: 0.95 },

  // Permission errors
  { pattern: /EACCES|Permission denied|EPERM|not allowed for role/i, category: "permission", strategy: "escalate", confidence: 0.9 },
  { pattern: /401|403|Unauthorized|Forbidden/i, category: "permission", strategy: "escalate", confidence: 0.85 },

  // Resource errors
  { pattern: /ENOENT|no such file|File not found/i, category: "resource", strategy: "retry-with-context", confidence: 0.85 },
  { pattern: /ENOSPC|disk full|quota exceeded/i, category: "resource", strategy: "escalate", confidence: 0.95 },

  // Runtime errors
  { pattern: /RangeError|Maximum call stack|out of memory/i, category: "runtime", strategy: "fix-and-retry", confidence: 0.7 },
  { pattern: /Segmentation fault|SIGSEGV|SIGKILL/i, category: "runtime", strategy: "escalate", confidence: 0.9 },
];

/** Diagnose an error and suggest a recovery strategy */
export function diagnoseError(error: string): DiagnosedError {
  for (const rule of ERROR_PATTERNS) {
    if (rule.pattern.test(error)) {
      const filePath = extractFilePath(error);
      const lineNumber = extractLineNumber(error);

      return {
        category: rule.category,
        message: error.slice(0, 500),
        filePath,
        lineNumber,
        strategy: rule.strategy,
        confidence: rule.confidence
      };
    }
  }

  return {
    category: "unknown",
    message: error.slice(0, 500),
    strategy: "retry-with-context",
    confidence: 0.3
  };
}

/** Build a recovery prompt based on the diagnosis */
export function buildRecoveryPrompt(diagnosis: DiagnosedError, originalTask: string): string {
  const lines: string[] = [];

  lines.push(`Error occurred during execution. Category: ${diagnosis.category}`);
  lines.push(`Error: ${diagnosis.message}`);

  if (diagnosis.filePath) {
    lines.push(`File: ${diagnosis.filePath}${diagnosis.lineNumber ? `:${diagnosis.lineNumber}` : ""}`);
  }

  switch (diagnosis.strategy) {
    case "retry-with-context":
      lines.push("", "Please fix this error and try again. The error message above should guide you.");
      break;
    case "fix-and-retry":
      lines.push("", "This error requires a code fix. Please:");
      lines.push("1. Read the relevant file(s)");
      lines.push("2. Identify the root cause");
      lines.push("3. Apply the minimal fix");
      lines.push("4. Verify the fix with a build/test command");
      break;
    case "rollback":
      lines.push("", "The previous approach failed. Please try a different approach.");
      break;
    case "skip":
      lines.push("", "This step is non-critical. Continue with the remaining work.");
      break;
    default:
      lines.push("", "Please analyze this error and determine the best course of action.");
  }

  lines.push("", `Original task: ${originalTask}`);

  return lines.join("\n");
}

/** Check if an error should trigger self-healing vs immediate failure */
export function shouldSelfHeal(diagnosis: DiagnosedError, attemptNumber: number, maxAttempts: number): boolean {
  if (attemptNumber >= maxAttempts) return false;
  if (diagnosis.strategy === "escalate") return false;
  if (diagnosis.confidence < 0.3) return false;

  // Network errors: always retry
  if (diagnosis.category === "network") return true;

  // Permission: never self-heal
  if (diagnosis.category === "permission") return false;

  // Build/test: heal up to 3 attempts
  if (diagnosis.category === "build" || diagnosis.category === "test") {
    return attemptNumber < Math.min(3, maxAttempts);
  }

  return true;
}

/** Detect errors from tool execution output */
export function detectErrorsInOutput(output: string): DiagnosedError[] {
  const errors: DiagnosedError[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check each error pattern
    for (const rule of ERROR_PATTERNS) {
      if (rule.pattern.test(trimmed)) {
        errors.push({
          category: rule.category,
          message: trimmed.slice(0, 200),
          filePath: extractFilePath(trimmed),
          lineNumber: extractLineNumber(trimmed),
          strategy: rule.strategy,
          confidence: rule.confidence * 0.8 // lower confidence for indirect detection
        });
        break; // one diagnosis per line
      }
    }
  }

  // Deduplicate by category
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.category}:${e.filePath ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFilePath(error: string): string | undefined {
  // Common patterns: "at /path/to/file.ts:42" or "file.ts(42,5)" or "src/foo.ts:12:5"
  const patterns = [
    /(?:at\s+)?(?:\/[\w/.@-]+|(?:src|tests|lib|app)\/[\w/.@-]+\.\w+)/,
    /(\w[\w/.@-]*\.\w+)\(\d+,\d+\)/,
    /(\w[\w/.@-]*\.\w+):\d+/
  ];

  for (const pattern of patterns) {
    const match = error.match(pattern);
    if (match) return match[1] ?? match[0];
  }
  return undefined;
}

function extractLineNumber(error: string): number | undefined {
  const match = error.match(/:(\d+)(?::\d+)?/);
  if (match) return parseInt(match[1], 10);
  const parenMatch = error.match(/\((\d+),\d+\)/);
  if (parenMatch) return parseInt(parenMatch[1], 10);
  return undefined;
}
