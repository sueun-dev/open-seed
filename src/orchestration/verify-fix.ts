/**
 * Verify-Fix Loop — Structured test → parse → fix → retest cycle.
 *
 * Inspired by oh-my-claudecode + oh-my-openagent:
 * - Run verification commands (test, build, lint, typecheck)
 * - Parse specific errors from output
 * - Deduplicate seen issues to prevent infinite loops
 * - Delegate fixes to appropriate agent
 * - Bounded iterations with escalation
 */

export interface VerifyResult {
  passed: boolean;
  /** Specific issues found */
  issues: VerifyIssue[];
  /** Raw command outputs */
  outputs: VerifyOutput[];
}

export interface VerifyIssue {
  id: string;
  type: "test_failure" | "build_error" | "type_error" | "lint_error" | "runtime_error";
  message: string;
  file?: string;
  line?: number;
  /** How many times this exact issue has been seen */
  seenCount: number;
}

export interface VerifyOutput {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerifyFixState {
  iteration: number;
  maxIterations: number;
  seenIssues: Map<string, number>; // issue ID → count
  lastResult: VerifyResult | null;
  allIssuesEverSeen: string[];
  /** Issues that persisted across all attempts */
  persistentIssues: string[];
  escalated: boolean;
}

// ─── State Management ────────────────────────────────────────────────────────

export function createVerifyFixState(maxIterations = 5): VerifyFixState {
  return {
    iteration: 0,
    maxIterations,
    seenIssues: new Map(),
    lastResult: null,
    allIssuesEverSeen: [],
    persistentIssues: [],
    escalated: false
  };
}

export function shouldContinueVerifyFix(state: VerifyFixState): boolean {
  if (state.escalated) return false;
  if (state.iteration >= state.maxIterations) return false;
  if (state.lastResult?.passed) return false;
  return true;
}

// ─── Verification ────────────────────────────────────────────────────────────

export function parseVerifyOutput(outputs: VerifyOutput[]): VerifyResult {
  const issues: VerifyIssue[] = [];
  let passed = true;

  for (const output of outputs) {
    if (output.exitCode !== 0) passed = false;
    const combined = output.stdout + "\n" + output.stderr;

    // Parse test failures
    const testFailures = combined.match(/FAIL\s+(\S+)/g);
    if (testFailures) {
      for (const fail of testFailures) {
        const file = fail.replace("FAIL ", "").trim();
        addIssue(issues, "test_failure", `Test failed: ${file}`, file);
      }
    }

    // Parse TypeScript errors
    const tsErrors = combined.matchAll(/(\S+\.tsx?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/g);
    for (const match of tsErrors) {
      addIssue(issues, "type_error", match[3].trim(), match[1], parseInt(match[2]));
    }

    // Parse tsc errors (colon format)
    const tscErrors = combined.matchAll(/(\S+\.tsx?):\d+:\d+\s*-\s*error\s+TS\d+:\s*(.+)/g);
    for (const match of tscErrors) {
      addIssue(issues, "type_error", match[2].trim(), match[1]);
    }

    // Parse ESLint errors
    const lintErrors = combined.matchAll(/(\S+\.tsx?)\s+\d+:\d+\s+error\s+(.+)/g);
    for (const match of lintErrors) {
      addIssue(issues, "lint_error", match[2].trim(), match[1]);
    }

    // Parse generic errors
    const genericErrors = combined.matchAll(/(?:Error|error):\s*(.{10,200})/g);
    for (const match of genericErrors) {
      const msg = match[1].trim();
      // Skip if already captured as specific type
      if (!issues.some(i => i.message.includes(msg.slice(0, 50)))) {
        addIssue(issues, "runtime_error", msg);
      }
    }
  }

  // If no issues found but exit code was non-zero
  if (!passed && issues.length === 0) {
    const lastOutput = outputs[outputs.length - 1];
    if (lastOutput) {
      const preview = (lastOutput.stderr || lastOutput.stdout).trim().slice(0, 200);
      if (preview) addIssue(issues, "build_error", preview);
    }
  }

  return { passed: passed || issues.length === 0, issues, outputs };
}

function addIssue(issues: VerifyIssue[], type: VerifyIssue["type"], message: string, file?: string, line?: number): void {
  const id = `${type}:${file ?? ""}:${message.slice(0, 80)}`;
  const existing = issues.find(i => i.id === id);
  if (existing) {
    existing.seenCount++;
  } else {
    issues.push({ id, type, message, file, line, seenCount: 1 });
  }
}

// ─── State Update ────────────────────────────────────────────────────────────

export function updateVerifyFixState(state: VerifyFixState, result: VerifyResult): VerifyFixState {
  const newState = { ...state, iteration: state.iteration + 1, lastResult: result };

  for (const issue of result.issues) {
    const count = state.seenIssues.get(issue.id) ?? 0;
    newState.seenIssues.set(issue.id, count + 1);

    if (!state.allIssuesEverSeen.includes(issue.id)) {
      newState.allIssuesEverSeen.push(issue.id);
    }

    // If same issue seen 3+ times, it's persistent
    if (count + 1 >= 3 && !newState.persistentIssues.includes(issue.id)) {
      newState.persistentIssues.push(issue.id);
    }
  }

  // Escalate if too many persistent issues
  if (newState.persistentIssues.length >= 3) {
    newState.escalated = true;
  }

  return newState;
}

// ─── Fix Prompt Generation ───────────────────────────────────────────────────

export function buildVerifyFixPrompt(result: VerifyResult, state: VerifyFixState): string {
  const lines: string[] = [
    `Verification failed (attempt ${state.iteration}/${state.maxIterations}).`,
    ""
  ];

  if (result.issues.length > 0) {
    lines.push("Issues found:");
    for (const issue of result.issues) {
      const seen = state.seenIssues.get(issue.id) ?? 0;
      const persistent = seen >= 2 ? " [PERSISTENT — try a different approach]" : "";
      lines.push(`  [${issue.type}] ${issue.message}${issue.file ? ` in ${issue.file}${issue.line ? `:${issue.line}` : ""}` : ""}${persistent}`);
    }
  }

  if (state.persistentIssues.length > 0) {
    lines.push("", "WARNING: These issues have persisted across multiple attempts. Try a fundamentally different approach:");
    for (const id of state.persistentIssues) {
      lines.push(`  - ${id}`);
    }
  }

  lines.push("", "Fix ALL issues above. Use tools to read the failing files, apply fixes, and run verification again.");

  return lines.join("\n");
}

// ─── Verification Commands ───────────────────────────────────────────────────

export function getVerificationCommands(learnedBuildCmd?: string, learnedTestCmd?: string): string[] {
  const commands: string[] = [];

  // Build/typecheck
  if (learnedBuildCmd) {
    commands.push(learnedBuildCmd);
  } else {
    commands.push("npx tsc --noEmit 2>&1 || true");
  }

  // Tests
  if (learnedTestCmd) {
    commands.push(learnedTestCmd);
  }

  return commands;
}
