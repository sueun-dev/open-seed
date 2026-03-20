/**
 * Multi-Attempt Strategy Branching — SWE-Agent Preselector/Chooser pattern.
 *
 * Instead of one attempt, tries N different strategies in parallel:
 * 1. Generate K candidate solutions
 * 2. Preselector filters to top candidates
 * 3. Run verification on each
 * 4. Chooser picks the best one
 *
 * This is what makes an agent truly autonomous — it explores alternatives
 * instead of giving up after one failure.
 *
 * Source: SWE-Agent RetryAgentConfig + MetaGPT debate
 */

export interface Strategy {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** Priority — higher tries first */
  priority: number;
  /** Cost multiplier (cheap=0.5, expensive=2.0) */
  costMultiplier: number;
}

export interface AttemptResult {
  strategyId: string;
  success: boolean;
  output: string;
  score: number;
  verificationPassed: boolean;
  costTokens: number;
  durationMs: number;
  errors: string[];
}

export interface BranchingResult {
  selectedStrategy: string;
  selectedOutput: string;
  allAttempts: AttemptResult[];
  totalCost: number;
  totalDuration: number;
  confidence: number;
}

/**
 * Generate alternative strategies for a task.
 */
export function generateStrategies(task: string, context: { hasTests: boolean; isLargeCodebase: boolean; complexity: string }): Strategy[] {
  const strategies: Strategy[] = [];

  // Strategy 1: Direct implementation (always available)
  strategies.push({
    id: "direct",
    name: "Direct Implementation",
    description: "Implement the task directly with minimal planning",
    prompt: `Implement this task directly:\n${task}\n\nBe concise. Make minimal changes. Focus on correctness.`,
    priority: 10,
    costMultiplier: 1.0
  });

  // Strategy 2: Plan-first (for complex tasks)
  if (context.complexity !== "simple") {
    strategies.push({
      id: "plan-first",
      name: "Plan Then Execute",
      description: "Create a detailed plan before any code changes",
      prompt: `First, create a step-by-step plan for:\n${task}\n\nThen execute each step. Verify after each step.`,
      priority: 8,
      costMultiplier: 1.5
    });
  }

  // Strategy 3: Test-driven (if tests exist)
  if (context.hasTests) {
    strategies.push({
      id: "tdd",
      name: "Test-Driven Development",
      description: "Write failing test first, then implement to pass",
      prompt: `Use TDD for:\n${task}\n\nStep 1: Write a failing test\nStep 2: Implement to make it pass\nStep 3: Refactor if needed`,
      priority: 7,
      costMultiplier: 1.3
    });
  }

  // Strategy 4: Minimal diff (for risky changes)
  strategies.push({
    id: "minimal-diff",
    name: "Minimal Change",
    description: "Make the absolute minimum change to achieve the goal",
    prompt: `Make the SMALLEST possible change to achieve:\n${task}\n\nRules:\n- Change as few lines as possible\n- Don't refactor surrounding code\n- Don't add unnecessary features\n- Keep the diff tiny`,
    priority: 6,
    costMultiplier: 0.7
  });

  // Strategy 5: Research-first (for large codebases)
  if (context.isLargeCodebase) {
    strategies.push({
      id: "research-first",
      name: "Research Then Implement",
      description: "Deeply understand the codebase before making changes",
      prompt: `Before any changes:\n1. Search for ALL related files\n2. Understand the current architecture\n3. Check for existing patterns\n4. Then implement:\n${task}`,
      priority: 5,
      costMultiplier: 1.8
    });
  }

  return strategies;
}

/**
 * Score an attempt result for comparison.
 */
export function scoreAttempt(result: AttemptResult): number {
  let score = 0;

  // Verification is king
  if (result.verificationPassed) score += 50;
  if (result.success) score += 30;

  // Fewer errors is better
  score -= result.errors.length * 10;

  // Cost efficiency
  if (result.costTokens < 5000) score += 10;
  else if (result.costTokens < 10000) score += 5;

  // Speed bonus
  if (result.durationMs < 30000) score += 5;

  return Math.max(0, score);
}

/**
 * Select the best attempt using Preselector → Chooser pattern.
 */
export function selectBestAttempt(attempts: AttemptResult[]): AttemptResult | null {
  if (attempts.length === 0) return null;

  // Preselector: filter to candidates that at least partially succeeded
  const candidates = attempts.filter(a => a.success || a.verificationPassed);

  // If no successes, pick the one with fewest errors
  if (candidates.length === 0) {
    return attempts.sort((a, b) => a.errors.length - b.errors.length)[0];
  }

  // Chooser: rank by score and pick best
  const scored = candidates.map(a => ({ attempt: a, score: scoreAttempt(a) }));
  scored.sort((a, b) => b.score - a.score);

  return scored[0].attempt;
}

/**
 * Run strategy branching — tries multiple approaches, picks the best.
 */
export async function runStrategyBranching(params: {
  strategies: Strategy[];
  maxAttempts: number;
  executeFn: (prompt: string) => Promise<{ output: string; tokens: number }>;
  verifyFn: (output: string) => Promise<{ passed: boolean; errors: string[] }>;
}): Promise<BranchingResult> {
  const attempts: AttemptResult[] = [];
  const startTime = Date.now();

  // Sort by priority and take top N
  const toTry = [...params.strategies]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, params.maxAttempts);

  for (const strategy of toTry) {
    const attemptStart = Date.now();
    try {
      const { output, tokens } = await params.executeFn(strategy.prompt);
      const verification = await params.verifyFn(output);

      const result: AttemptResult = {
        strategyId: strategy.id,
        success: true,
        output,
        score: 0,
        verificationPassed: verification.passed,
        costTokens: tokens,
        durationMs: Date.now() - attemptStart,
        errors: verification.errors
      };
      result.score = scoreAttempt(result);
      attempts.push(result);

      // Early exit if we found a perfect solution
      if (verification.passed && verification.errors.length === 0) break;
    } catch (e) {
      attempts.push({
        strategyId: strategy.id,
        success: false,
        output: "",
        score: 0,
        verificationPassed: false,
        costTokens: 0,
        durationMs: Date.now() - attemptStart,
        errors: [e instanceof Error ? e.message : String(e)]
      });
    }
  }

  const best = selectBestAttempt(attempts);
  const totalCost = attempts.reduce((sum, a) => sum + a.costTokens, 0);

  return {
    selectedStrategy: best?.strategyId ?? "none",
    selectedOutput: best?.output ?? "",
    allAttempts: attempts,
    totalCost,
    totalDuration: Date.now() - startTime,
    confidence: best ? best.score / 100 : 0
  };
}
