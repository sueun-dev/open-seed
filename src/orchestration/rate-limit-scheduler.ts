/**
 * Rate Limit Aware Scheduler — OMC-style auto-resume on rate limits.
 *
 * When a provider hits rate limits:
 * 1. Detect the limit (429, retry-after header)
 * 2. Calculate wait time
 * 3. Queue the task for retry
 * 4. Try alternate provider in the meantime
 * 5. Auto-resume original provider when limit lifts
 *
 * Source: oh-my-claudecode "Rate Limit Aware Scheduling"
 */

export interface RateLimitState {
  provider: string;
  hitAt: number;
  retryAfterMs: number;
  resumeAt: number;
  consecutiveHits: number;
}

export interface SchedulerState {
  limits: Map<string, RateLimitState>;
  queue: QueuedTask[];
}

export interface QueuedTask {
  id: string;
  provider: string;
  prompt: string;
  queuedAt: number;
  priority: number;
}

export function createSchedulerState(): SchedulerState {
  return { limits: new Map(), queue: [] };
}

/**
 * Record a rate limit hit.
 */
export function recordRateLimit(
  state: SchedulerState,
  provider: string,
  retryAfterMs?: number
): RateLimitState {
  const existing = state.limits.get(provider);
  const consecutive = (existing?.consecutiveHits ?? 0) + 1;

  // Exponential backoff: base wait * 2^consecutive
  const baseWait = retryAfterMs ?? 5000;
  const actualWait = Math.min(baseWait * Math.pow(2, consecutive - 1), 120000); // Max 2 minutes

  const limitState: RateLimitState = {
    provider,
    hitAt: Date.now(),
    retryAfterMs: actualWait,
    resumeAt: Date.now() + actualWait,
    consecutiveHits: consecutive
  };

  state.limits.set(provider, limitState);
  return limitState;
}

/**
 * Check if a provider is currently rate-limited.
 */
export function isRateLimited(state: SchedulerState, provider: string): { limited: boolean; resumeIn?: number } {
  const limit = state.limits.get(provider);
  if (!limit) return { limited: false };

  const remaining = limit.resumeAt - Date.now();
  if (remaining <= 0) {
    // Limit expired — clear it
    state.limits.delete(provider);
    return { limited: false };
  }

  return { limited: true, resumeIn: remaining };
}

/**
 * Get the best available provider (not rate-limited).
 */
export function getBestAvailableProvider(
  state: SchedulerState,
  preferredProviders: string[]
): string | null {
  for (const provider of preferredProviders) {
    const { limited } = isRateLimited(state, provider);
    if (!limited) return provider;
  }
  return null;
}

/**
 * Queue a task for later execution.
 */
export function queueTask(state: SchedulerState, task: Omit<QueuedTask, "queuedAt">): void {
  state.queue.push({ ...task, queuedAt: Date.now() });
  // Sort by priority (higher first)
  state.queue.sort((a, b) => b.priority - a.priority);
}

/**
 * Get tasks ready to be executed (their provider is no longer limited).
 */
export function getReadyTasks(state: SchedulerState): QueuedTask[] {
  const ready: QueuedTask[] = [];
  const remaining: QueuedTask[] = [];

  for (const task of state.queue) {
    const { limited } = isRateLimited(state, task.provider);
    if (!limited) ready.push(task);
    else remaining.push(task);
  }

  state.queue = remaining;
  return ready;
}

/**
 * Clear rate limit for a provider after successful request.
 */
export function clearRateLimit(state: SchedulerState, provider: string): void {
  state.limits.delete(provider);
}

/**
 * Get a summary of current rate limit status.
 */
export function getRateLimitSummary(state: SchedulerState): string {
  const limited = Array.from(state.limits.values()).filter(l => l.resumeAt > Date.now());
  if (limited.length === 0 && state.queue.length === 0) return "";

  const lines: string[] = [];
  if (limited.length > 0) {
    lines.push("## Rate Limits Active");
    for (const l of limited) {
      const remaining = Math.ceil((l.resumeAt - Date.now()) / 1000);
      lines.push(`- ${l.provider}: ${remaining}s remaining (hit ${l.consecutiveHits}x)`);
    }
  }
  if (state.queue.length > 0) {
    lines.push(`\nQueued tasks: ${state.queue.length}`);
  }
  return lines.join("\n");
}
