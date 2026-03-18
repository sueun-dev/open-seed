/**
 * Cost Tracker (inspired by MetaGPT).
 *
 * Tracks token usage and estimated costs per session, task, and provider.
 * Supports budget limits and cost alerts.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostEntry {
  taskId: string;
  roleId: string;
  providerId: string;
  model: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  timestamp: string;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  byProvider: Record<string, { input: number; output: number; costUsd: number }>;
  byRole: Record<string, { input: number; output: number; costUsd: number }>;
  entries: number;
}

// Approximate costs per 1M tokens (2026 pricing)
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-5.4": { input: 2.0, output: 8.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "default": { input: 2.0, output: 8.0 }
};

export class CostTracker {
  private entries: CostEntry[] = [];
  private budgetUsd: number | null = null;

  setBudget(usd: number): void {
    this.budgetUsd = usd;
  }

  record(params: {
    taskId: string;
    roleId: string;
    providerId: string;
    model: string;
    usage: TokenUsage;
  }): CostEntry {
    const cost = estimateCost(params.model, params.usage);
    const entry: CostEntry = {
      ...params,
      estimatedCostUsd: cost,
      timestamp: new Date().toISOString()
    };
    this.entries.push(entry);
    return entry;
  }

  getSummary(): CostSummary {
    const summary: CostSummary = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
      byProvider: {},
      byRole: {},
      entries: this.entries.length
    };

    for (const entry of this.entries) {
      summary.totalInputTokens += entry.usage.inputTokens;
      summary.totalOutputTokens += entry.usage.outputTokens;
      summary.totalEstimatedCostUsd += entry.estimatedCostUsd;

      if (!summary.byProvider[entry.providerId]) {
        summary.byProvider[entry.providerId] = { input: 0, output: 0, costUsd: 0 };
      }
      summary.byProvider[entry.providerId].input += entry.usage.inputTokens;
      summary.byProvider[entry.providerId].output += entry.usage.outputTokens;
      summary.byProvider[entry.providerId].costUsd += entry.estimatedCostUsd;

      if (!summary.byRole[entry.roleId]) {
        summary.byRole[entry.roleId] = { input: 0, output: 0, costUsd: 0 };
      }
      summary.byRole[entry.roleId].input += entry.usage.inputTokens;
      summary.byRole[entry.roleId].output += entry.usage.outputTokens;
      summary.byRole[entry.roleId].costUsd += entry.estimatedCostUsd;
    }

    return summary;
  }

  isOverBudget(): boolean {
    if (this.budgetUsd === null) return false;
    return this.getSummary().totalEstimatedCostUsd >= this.budgetUsd;
  }

  getRemainingBudgetUsd(): number | null {
    if (this.budgetUsd === null) return null;
    return Math.max(0, this.budgetUsd - this.getSummary().totalEstimatedCostUsd);
  }

  getEntries(): CostEntry[] {
    return [...this.entries];
  }
}

function estimateCost(model: string, usage: TokenUsage): number {
  const rates = COST_PER_MILLION[model] ?? COST_PER_MILLION["default"];
  return (
    (usage.inputTokens / 1_000_000) * rates.input +
    (usage.outputTokens / 1_000_000) * rates.output
  );
}
