/**
 * Circuit Breaker + Exponential Backoff — fault tolerance for autonomous operation.
 *
 * Without this, one flaky API call crashes the entire agent.
 * With this, the agent routes around failures and self-heals.
 *
 * States: CLOSED (normal) → OPEN (failing, skip calls) → HALF-OPEN (testing recovery)
 *
 * Source: Cline retry patterns + standard distributed systems patterns
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Failures before opening circuit */
  failureThreshold: number;
  /** Ms to wait before trying half-open */
  resetTimeoutMs: number;
  /** Successes in half-open to close circuit */
  halfOpenSuccessThreshold: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  totalCalls: number;
  totalFailures: number;
  config: CircuitBreakerConfig;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30000,
  halfOpenSuccessThreshold: 2
};

export function createCircuitBreaker(config?: Partial<CircuitBreakerConfig>): CircuitBreakerState {
  return {
    state: "closed",
    failures: 0,
    successes: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    totalCalls: 0,
    totalFailures: 0,
    config: { ...DEFAULT_CONFIG, ...config }
  };
}

export function canExecute(breaker: CircuitBreakerState): boolean {
  if (breaker.state === "closed") return true;
  if (breaker.state === "open") {
    // Check if enough time passed to try half-open
    if (Date.now() - breaker.lastFailureAt >= breaker.config.resetTimeoutMs) {
      breaker.state = "half-open";
      breaker.successes = 0;
      return true;
    }
    return false;
  }
  // half-open: allow limited calls
  return true;
}

export function recordSuccess(breaker: CircuitBreakerState): void {
  breaker.totalCalls++;
  breaker.lastSuccessAt = Date.now();

  if (breaker.state === "half-open") {
    breaker.successes++;
    if (breaker.successes >= breaker.config.halfOpenSuccessThreshold) {
      breaker.state = "closed";
      breaker.failures = 0;
      breaker.successes = 0;
    }
  } else {
    breaker.failures = 0;
  }
}

export function recordFailure(breaker: CircuitBreakerState): void {
  breaker.totalCalls++;
  breaker.totalFailures++;
  breaker.failures++;
  breaker.lastFailureAt = Date.now();

  if (breaker.state === "half-open") {
    breaker.state = "open";
  } else if (breaker.failures >= breaker.config.failureThreshold) {
    breaker.state = "open";
  }
}

/** Exponential backoff delay calculator */
export function getBackoffDelay(attempt: number, baseMs = 1000, maxMs = 60000, jitter = true): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  if (jitter) {
    return delay + Math.random() * delay * 0.1;
  }
  return delay;
}

/** Execute with circuit breaker + retry + backoff */
export async function executeWithCircuitBreaker<T>(
  breaker: CircuitBreakerState,
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!canExecute(breaker)) {
      const waitMs = breaker.config.resetTimeoutMs - (Date.now() - breaker.lastFailureAt);
      throw new Error(`Circuit breaker OPEN — provider unavailable. Retry in ${Math.ceil(waitMs / 1000)}s`);
    }

    try {
      const result = await fn();
      recordSuccess(breaker);
      return result;
    } catch (error) {
      recordFailure(breaker);
      if (attempt >= maxRetries) throw error;

      const delay = getBackoffDelay(attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

export function getCircuitBreakerStatus(breaker: CircuitBreakerState): string {
  return `[${breaker.state.toUpperCase()}] failures=${breaker.failures}/${breaker.config.failureThreshold} total=${breaker.totalCalls} failRate=${breaker.totalCalls > 0 ? Math.round((breaker.totalFailures / breaker.totalCalls) * 100) : 0}%`;
}
