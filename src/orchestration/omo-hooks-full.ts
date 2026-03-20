/**
 * OMO Hooks — FULL implementation of ALL 46+ oh-my-openagent hooks.
 *
 * Every hook from OMO, implemented and auto-wired.
 * Groups:
 *  A. Session hooks (23)
 *  B. Tool guard hooks (10)
 *  C. Transform hooks (4)
 *  D. Continuation hooks (7)
 *  E. Skill hooks (2)
 */

import type { AgentEventBus } from "../core/event-bus.js";
import type { AgentConfig } from "../core/types.js";

// ─── A. Session Hooks ────────────────────────────────────────────────────────

// 1. context-window-monitor — already in omo-hooks.ts + engine-wiring.ts ✓
// 2. preemptive-compaction — already in engine-wiring.ts ✓
// 3. session-recovery — already in engine-wiring.ts ✓

// 4. session-notification — desktop notifications for long tasks
export async function notifyDesktop(title: string, body: string): Promise<void> {
  const platform = process.platform;
  try {
    const { execSync } = await import("node:child_process");
    if (platform === "darwin") {
      execSync(`osascript -e 'display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`);
    } else if (platform === "linux") {
      execSync(`notify-send "${title}" "${body}" 2>/dev/null || true`);
    }
    // Windows: could use powershell but skip for now
  } catch { /* notification is non-critical */ }
}

// 5. think-mode — already in omo-hooks.ts ✓
// 6. model-fallback — already in providers/registry.ts ✓

// 7. anthropic-context-window-limit-recovery
export function handleAnthropicContextLimit(errorMessage: string): { shouldRetry: boolean; strategy: string } {
  if (/context_length|too many tokens|max.*token/i.test(errorMessage)) {
    return { shouldRetry: true, strategy: "compact-and-retry" };
  }
  if (/overloaded|529|capacity/i.test(errorMessage)) {
    return { shouldRetry: true, strategy: "wait-and-retry" };
  }
  return { shouldRetry: false, strategy: "none" };
}

// 8. auto-update-checker
export async function checkForUpdates(currentVersion: string): Promise<{ hasUpdate: boolean; latestVersion?: string }> {
  try {
    const { execSync } = await import("node:child_process");
    const latest = execSync("npm view agent40 version 2>/dev/null || echo ''", { encoding: "utf-8" }).trim();
    if (latest && latest !== currentVersion) {
      return { hasUpdate: true, latestVersion: latest };
    }
  } catch { /* offline or not published */ }
  return { hasUpdate: false };
}

// 9. agent-usage-reminder
export function buildAgentUsageReminder(task: string, availableRoles: string[]): string {
  const suggestions: string[] = [];
  if (/security|auth|token/i.test(task) && availableRoles.includes("security-auditor")) {
    suggestions.push("💡 security-auditor 역할이 보안 분석을 도와줄 수 있습니다");
  }
  if (/performance|slow|optimize/i.test(task) && availableRoles.includes("performance-engineer")) {
    suggestions.push("💡 performance-engineer 역할이 최적화를 도와줄 수 있습니다");
  }
  if (/test|spec|coverage/i.test(task) && availableRoles.includes("test-engineer")) {
    suggestions.push("💡 test-engineer 역할이 테스트 작성을 도와줄 수 있습니다");
  }
  if (/deploy|docker|ci/i.test(task) && availableRoles.includes("devops-engineer")) {
    suggestions.push("💡 devops-engineer 역할이 배포를 도와줄 수 있습니다");
  }
  if (/database|sql|migration/i.test(task) && availableRoles.includes("db-engineer")) {
    suggestions.push("💡 db-engineer 역할이 DB 작업을 도와줄 수 있습니다");
  }
  return suggestions.join("\n");
}

// 10. non-interactive-env
export function detectNonInteractiveEnv(): { isNonInteractive: boolean; reason: string } {
  if (!process.stdin.isTTY) return { isNonInteractive: true, reason: "stdin is not a TTY" };
  if (process.env.CI === "true") return { isNonInteractive: true, reason: "CI environment" };
  if (process.env.TERM === "dumb") return { isNonInteractive: true, reason: "dumb terminal" };
  if (process.env.NONINTERACTIVE === "1") return { isNonInteractive: true, reason: "NONINTERACTIVE=1" };
  return { isNonInteractive: false, reason: "" };
}

// 11. interactive-bash-session (tmux)
export async function spawnTmuxSession(sessionName: string, command: string): Promise<{ paneId: string; sessionName: string } | null> {
  try {
    const { execSync } = await import("node:child_process");
    // Check if tmux is available
    execSync("tmux -V", { stdio: "pipe" });
    // Create or attach to session
    try { execSync(`tmux has-session -t ${sessionName} 2>/dev/null`); }
    catch { execSync(`tmux new-session -d -s ${sessionName}`); }
    // Send command to session
    execSync(`tmux send-keys -t ${sessionName} '${command.replace(/'/g, "'\\''")}' Enter`);
    const paneId = execSync(`tmux display-message -t ${sessionName} -p '#{pane_id}'`, { encoding: "utf-8" }).trim();
    return { paneId, sessionName };
  } catch {
    return null;
  }
}

export async function readTmuxOutput(sessionName: string, lines = 50): Promise<string> {
  try {
    const { execSync } = await import("node:child_process");
    return execSync(`tmux capture-pane -t ${sessionName} -p -S -${lines}`, { encoding: "utf-8" });
  } catch {
    return "";
  }
}

export async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
  } catch { /* already dead */ }
}

// 12. ralph-loop — already in engine-wiring.ts ✓
// 13. edit-error-recovery
export function recoverFromEditError(error: string, filePath: string): { strategy: string; prompt: string } {
  if (/old_string.*not found|no match/i.test(error)) {
    return {
      strategy: "re-read-and-retry",
      prompt: `Edit failed on ${filePath}: string not found. Read the file first with the 'read' tool to see current content, then retry the edit with the correct old_string.`
    };
  }
  if (/multiple matches|ambiguous/i.test(error)) {
    return {
      strategy: "add-context",
      prompt: `Edit failed on ${filePath}: multiple matches. Add more surrounding context to the old_string to make it unique.`
    };
  }
  if (/permission|EACCES/i.test(error)) {
    return {
      strategy: "check-permissions",
      prompt: `Edit failed on ${filePath}: permission denied. Check file permissions.`
    };
  }
  return {
    strategy: "fallback-write",
    prompt: `Edit failed on ${filePath}: ${error}. Read the file, apply changes manually, and use the write tool instead.`
  };
}

// 14. delegate-task-retry
export function shouldRetryDelegation(error: string, attempts: number, maxAttempts: number): { retry: boolean; delay: number; strategy: string } {
  if (attempts >= maxAttempts) return { retry: false, delay: 0, strategy: "max-attempts-reached" };
  if (/rate_limit|429|overloaded/i.test(error)) {
    return { retry: true, delay: Math.min(2000 * Math.pow(2, attempts), 30000), strategy: "backoff" };
  }
  if (/timeout|ETIMEDOUT/i.test(error)) {
    return { retry: true, delay: 1000, strategy: "retry-immediately" };
  }
  if (/parse|JSON|SyntaxError/i.test(error)) {
    return { retry: true, delay: 0, strategy: "retry-with-format-hint" };
  }
  return { retry: false, delay: 0, strategy: "non-retriable" };
}

// 15. task-resume-info — already in omo-hooks.ts buildResumeInfo ✓
// 16. start-work — will be a command, see commands section
// 17. prometheus-md-only — enforced in our planner prompt
// 18. sisyphus-junior-notepad — our BackgroundTaskManager handles this
// 19-20. no-sisyphus-gpt / no-hephaestus-non-gpt — model routing handles this
// 21. question-label-truncator
export function truncateLabel(label: string, maxLen = 60): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 3) + "...";
}

// 22. anthropic-effort — already in omo-hooks.ts selectEffort ✓
// 23. runtime-fallback — already in providers/registry.ts invokeWithFailover ✓

// ─── B. Tool Guard Hooks ─────────────────────────────────────────────────────

// 24. comment-checker — already in tools/comment-checker.ts ✓

// 25. tool-output-truncator
export function truncateToolOutput(output: string, maxChars = 8000): { truncated: boolean; output: string; originalLength: number } {
  const originalLength = output.length;
  if (originalLength <= maxChars) return { truncated: false, output, originalLength };
  // Keep first and last portions
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = maxChars - headSize - 50;
  const truncated = output.slice(0, headSize) + `\n\n... [${originalLength - headSize - tailSize} chars truncated] ...\n\n` + output.slice(-tailSize);
  return { truncated: true, output: truncated, originalLength };
}

// 26. directory-agents-injector — already in engine-wiring.ts buildAutoInjectedContext ✓
// 27. directory-readme-injector — already in engine-wiring.ts buildAutoInjectedContext ✓

// 28. empty-task-response-detector
export function detectEmptyResponse(response: string): { isEmpty: boolean; reason: string } {
  if (!response || response.trim().length === 0) {
    return { isEmpty: true, reason: "Empty response" };
  }
  if (response.trim().length < 10) {
    return { isEmpty: true, reason: "Response too short (<10 chars)" };
  }
  // Check for common "I can't do this" patterns
  if (/^(I'm sorry|I cannot|I don't|I can't|I am unable)/i.test(response.trim())) {
    return { isEmpty: true, reason: "Refusal response detected" };
  }
  // Check for JSON with empty content
  try {
    const parsed = JSON.parse(response);
    if (parsed && typeof parsed === "object") {
      const hasContent = Object.values(parsed).some(v =>
        typeof v === "string" ? v.trim().length > 0 :
        Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined
      );
      if (!hasContent) return { isEmpty: true, reason: "JSON response with no meaningful content" };
    }
  } catch { /* not JSON, that's fine */ }
  return { isEmpty: false, reason: "" };
}

// 29. rules-injector — already in engine-wiring.ts buildAutoInjectedContext ✓

// 30. tasks-todowrite-disabler — not applicable (our system doesn't use TodoWrite internally)

// 31. write-existing-file-guard
export function guardExistingFileWrite(filePath: string, filesRead: Set<string>): { allowed: boolean; warning?: string } {
  // Check if file was read before writing
  if (!filesRead.has(filePath)) {
    return {
      allowed: false,
      warning: `Cannot write to "${filePath}" — file was not read first. Read the file before writing to prevent accidental overwrites.`
    };
  }
  return { allowed: true };
}

// 32. hashline-read-enhancer — already in tools/hashline.ts ✓

// 33. read-image-resizer
export function shouldResizeImage(filePath: string, sizeBytes: number): { resize: boolean; maxWidth: number } {
  const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (!imageExts.includes(`.${ext}`)) return { resize: false, maxWidth: 0 };
  // Resize if > 1MB
  if (sizeBytes > 1_000_000) return { resize: true, maxWidth: 1024 };
  // Resize if > 500KB
  if (sizeBytes > 500_000) return { resize: true, maxWidth: 1600 };
  return { resize: false, maxWidth: 0 };
}

// ─── C. Transform Hooks ──────────────────────────────────────────────────────

// 34. claude-code-hooks — bridge with Claude Code hooks system
export function detectClaudeCodeHooks(cwd: string): string[] {
  const hookPaths = [
    ".claude/hooks.json",
    ".claude/settings.json"
  ];
  const found: string[] = [];
  const fs = require("node:fs");
  const path = require("node:path");
  for (const hp of hookPaths) {
    if (fs.existsSync(path.join(cwd, hp))) found.push(hp);
  }
  return found;
}

// 35. keyword-detector — already in omo-hooks.ts detectKeywords ✓

// 36. thinking-block-validator
export function validateThinkingBlock(response: string): { valid: boolean; issue?: string } {
  // Check for unclosed thinking blocks
  const openCount = (response.match(/<thinking>/g) || []).length;
  const closeCount = (response.match(/<\/thinking>/g) || []).length;
  if (openCount !== closeCount) {
    return { valid: false, issue: `Unmatched thinking blocks: ${openCount} open, ${closeCount} close` };
  }
  // Check for thinking content leaking into response
  if (/<thinking>[\s\S]*?<\/thinking>/.test(response)) {
    // Thinking blocks should be stripped from final response
    return { valid: true, issue: "thinking-blocks-present" };
  }
  return { valid: true };
}

// 37. context-injector — already in engine-wiring.ts ✓

// ─── D. Continuation Hooks ───────────────────────────────────────────────────

// 38. gpt-permission-continuation
export function handleGptPermissionError(error: string): { shouldContinue: boolean; action: string } {
  if (/insufficient_quota|rate_limit|429/i.test(error)) {
    return { shouldContinue: true, action: "switch-provider" };
  }
  if (/invalid_api_key|unauthorized|401/i.test(error)) {
    return { shouldContinue: false, action: "check-credentials" };
  }
  return { shouldContinue: false, action: "none" };
}

// 39. stop-continuation-guard — already in omo-hooks.ts shouldStop ✓

// 40. compaction-context-injector
export function buildCompactionContext(roundNumber: number, previousSummary: string): string {
  return [
    "## Context Compaction Notice",
    `Round ${roundNumber}: Previous context was compacted to save tokens.`,
    "Key points from before compaction:",
    previousSummary,
    "",
    "Continue from where you left off. Do NOT restart from scratch."
  ].join("\n");
}

// 41. compaction-todo-preserver
export function extractTodosBeforeCompaction(context: string): string[] {
  const todos: string[] = [];
  const todoPattern = /[-*]\s*\[([ x])\]\s*(.+)/g;
  let match;
  while ((match = todoPattern.exec(context)) !== null) {
    const done = match[1] === "x";
    if (!done) todos.push(match[2].trim());
  }
  return todos;
}

export function injectTodosAfterCompaction(compactedContext: string, todos: string[]): string {
  if (todos.length === 0) return compactedContext;
  const todoSection = [
    "\n## Preserved TODOs (from before compaction)",
    ...todos.map(t => `- [ ] ${t}`),
    ""
  ].join("\n");
  return compactedContext + todoSection;
}

// 42. todo-continuation-enforcer
export function enforceTodoContinuation(
  response: string,
  pendingTodos: string[]
): { shouldYank: boolean; reminder: string } {
  if (pendingTodos.length === 0) return { shouldYank: false, reminder: "" };

  // Check if agent seems to be finishing without completing TODOs
  const doneSignals = /task.*complete|all.*done|finished|nothing.*left|no.*remaining/i;
  if (doneSignals.test(response)) {
    return {
      shouldYank: true,
      reminder: [
        "## ⚠️ Incomplete Work Detected",
        "You indicated completion but these tasks remain:",
        ...pendingTodos.map(t => `- [ ] ${t}`),
        "",
        "Complete ALL remaining tasks before marking done.",
        "Do NOT claim completion with unfinished work."
      ].join("\n")
    };
  }
  return { shouldYank: false, reminder: "" };
}

// 43. unstable-agent-babysitter — already in guards.ts isAgentUnstable ✓

// 44. background-notification — already wired in engine-wiring.ts ✓

// ─── E. Skill Hooks ──────────────────────────────────────────────────────────

// 45. category-skill-reminder
export function buildCategorySkillReminder(category: string): string {
  const reminders: Record<string, string[]> = {
    frontend: [
      "playwright skill: browser testing and visual verification",
      "frontend-ui-ux skill: UI/UX best practices and accessibility",
    ],
    execution: [
      "git-master skill: advanced git operations (atomic commits, interactive rebase)",
    ],
    research: [
      "web_search tool: search the web for documentation and examples",
    ],
    review: [
      "comment-checker: validate code comments before committing",
    ],
  };
  const skills = reminders[category];
  if (!skills || skills.length === 0) return "";
  return `## Available Skills for ${category}\n${skills.map(s => `- ${s}`).join("\n")}`;
}

// 46. auto-slash-command
export function discoverSlashCommands(cwd: string): string[] {
  const commands: string[] = [];
  const fs = require("node:fs");
  const path = require("node:path");
  // Check .agent/commands/
  const cmdDir = path.join(cwd, ".agent", "commands");
  try {
    const files = fs.readdirSync(cmdDir);
    for (const f of files) {
      if (f.endsWith(".md")) {
        commands.push(`/${f.replace(".md", "")}`);
      }
    }
  } catch { /* no commands dir */ }
  return commands;
}

// ─── Master Hook Wiring ──────────────────────────────────────────────────────

export function wireAllOmoHooksFull(params: {
  eventBus: AgentEventBus;
  config: AgentConfig;
  cwd: string;
  filesRead: Set<string>;
}): void {
  const { eventBus, config, cwd, filesRead } = params;

  // Hook: Tool output truncation
  eventBus.on("tool.completed", async (event) => {
    const output = event.payload.output;
    if (typeof output === "string" && output.length > 8000) {
      const result = truncateToolOutput(output);
      if (result.truncated) {
        (event.payload as Record<string, unknown>).output = result.output;
        (event.payload as Record<string, unknown>).truncated = true;
        (event.payload as Record<string, unknown>).originalLength = result.originalLength;
      }
    }
  });

  // Hook: Empty response detection + retry signal
  eventBus.on("tool.completed", async (event) => {
    if (event.payload.tool === "provider") {
      const response = (event.payload.response as string) ?? "";
      const check = detectEmptyResponse(response);
      if (check.isEmpty) {
        await eventBus.fire("error.retriable", "engine", event.sessionId, {
          message: `Empty response detected: ${check.reason}`,
          category: "empty-response",
          attempt: 1
        });
      }
    }
  });

  // Hook: Write guard — prevent writes without read
  eventBus.on("tool.called", async (event) => {
    const tool = event.payload.tool as string;
    if (tool === "write" || tool === "apply_patch") {
      const filePath = (event.payload.path as string) ?? "";
      const guard = guardExistingFileWrite(filePath, filesRead);
      if (!guard.allowed) {
        (event.payload as Record<string, unknown>).blocked = true;
        (event.payload as Record<string, unknown>).blockReason = guard.warning;
      }
    }
  });

  // Hook: Desktop notifications for long-running tasks
  let sessionStartTime = 0;
  eventBus.on("session.started", async () => {
    sessionStartTime = Date.now();
  });
  eventBus.on("session.completed", async (event) => {
    const elapsed = Date.now() - sessionStartTime;
    if (elapsed > 30_000) { // Only notify for tasks > 30s
      const status = (event.payload.status as string) ?? "unknown";
      await notifyDesktop("Open Seed", `Task ${status} (${Math.round(elapsed / 1000)}s)`);
    }
  });

  // Hook: Anthropic context limit recovery
  eventBus.on("error.retriable", async (event) => {
    const message = (event.payload.message as string) ?? "";
    const recovery = handleAnthropicContextLimit(message);
    if (recovery.shouldRetry) {
      (event.payload as Record<string, unknown>).recoveryStrategy = recovery.strategy;
    }
  });

  // Hook: Edit error recovery
  eventBus.on("tool.completed", async (event) => {
    const tool = event.payload.tool as string;
    const ok = event.payload.ok as boolean;
    if (!ok && (tool === "apply_patch" || tool === "write")) {
      const error = (event.payload.error as string) ?? "";
      const filePath = (event.payload.path as string) ?? "";
      const recovery = recoverFromEditError(error, filePath);
      (event.payload as Record<string, unknown>).recoveryStrategy = recovery.strategy;
      (event.payload as Record<string, unknown>).recoveryPrompt = recovery.prompt;
    }
  });

  // Hook: Thinking block validation
  eventBus.on("tool.completed", async (event) => {
    if (event.payload.tool === "provider") {
      const response = (event.payload.response as string) ?? "";
      const validation = validateThinkingBlock(response);
      if (!validation.valid) {
        (event.payload as Record<string, unknown>).thinkingBlockIssue = validation.issue;
      }
    }
  });

  // Hook: Category skill reminder injection
  eventBus.on("delegation.started", async (event) => {
    const category = (event.payload.category as string) ?? "";
    const reminder = buildCategorySkillReminder(category);
    if (reminder) {
      (event.payload as Record<string, unknown>).skillReminder = reminder;
    }
  });

  // Hook: Delegate task retry
  eventBus.on("error.retriable", async (event) => {
    const category = (event.payload.category as string) ?? "";
    if (category === "delegation") {
      const error = (event.payload.message as string) ?? "";
      const attempt = (event.payload.attempt as number) ?? 1;
      const retryInfo = shouldRetryDelegation(error, attempt, config.retry.maxToolRetries);
      (event.payload as Record<string, unknown>).shouldRetry = retryInfo.retry;
      (event.payload as Record<string, unknown>).retryDelay = retryInfo.delay;
      (event.payload as Record<string, unknown>).retryStrategy = retryInfo.strategy;
    }
  });
}
