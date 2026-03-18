/**
 * Stuck Detector (inspired by OpenHands StuckDetector).
 *
 * Detects infinite loops in the enforcer cycle by tracking:
 * 1. Repeating verdicts with identical summaries
 * 2. Alternating pass/fail patterns
 * 3. Maximum consecutive failures
 * 4. Monologue detection (identical outputs)
 */

export interface RoundRecord {
  round: number;
  verdict: string;
  summary: string;
  timestamp: number;
}

export class StuckDetector {
  private rounds: RoundRecord[] = [];
  private readonly maxConsecutiveFailures: number;
  private readonly maxRepeatedSummaries: number;
  private readonly windowSize: number;
  private stuckReason: string | null = null;

  constructor(options?: {
    maxConsecutiveFailures?: number;
    maxRepeatedSummaries?: number;
    windowSize?: number;
  }) {
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 4;
    this.maxRepeatedSummaries = options?.maxRepeatedSummaries ?? 3;
    this.windowSize = options?.windowSize ?? 6;
  }

  recordRound(round: number, verdict: string, summary: string): void {
    this.rounds.push({ round, verdict, summary: summary.trim().toLowerCase(), timestamp: Date.now() });
    this.stuckReason = null; // Reset on new data
  }

  isStuck(): boolean {
    if (this.rounds.length < 2) return false;

    // Scenario 1: Too many consecutive failures
    if (this.detectConsecutiveFailures()) return true;

    // Scenario 2: Repeating identical summaries (monologue)
    if (this.detectRepeatedSummaries()) return true;

    // Scenario 3: Alternating pass/fail pattern
    if (this.detectAlternatingPattern()) return true;

    return false;
  }

  getStuckReason(): string {
    return this.stuckReason ?? "Unknown loop detected";
  }

  getRounds(): RoundRecord[] {
    return [...this.rounds];
  }

  reset(): void {
    this.rounds = [];
    this.stuckReason = null;
  }

  private detectConsecutiveFailures(): boolean {
    const recent = this.rounds.slice(-this.maxConsecutiveFailures);
    if (recent.length < this.maxConsecutiveFailures) return false;

    const allFail = recent.every((r) => r.verdict === "fail");
    if (allFail) {
      this.stuckReason = `${this.maxConsecutiveFailures} consecutive review failures — agent is stuck in a failure loop`;
      return true;
    }
    return false;
  }

  private detectRepeatedSummaries(): boolean {
    const recent = this.rounds.slice(-this.maxRepeatedSummaries);
    if (recent.length < this.maxRepeatedSummaries) return false;

    const summaries = recent.map((r) => r.summary);
    const unique = new Set(summaries);
    if (unique.size === 1) {
      this.stuckReason = `${this.maxRepeatedSummaries} rounds produced identical output — agent is in a monologue loop`;
      return true;
    }
    return false;
  }

  private detectAlternatingPattern(): boolean {
    const window = this.rounds.slice(-this.windowSize);
    if (window.length < this.windowSize) return false;

    // Check for A-B-A-B-A-B pattern
    let alternating = true;
    for (let i = 2; i < window.length; i++) {
      if (window[i].verdict !== window[i - 2].verdict) {
        alternating = false;
        break;
      }
    }

    if (alternating && window[0].verdict !== window[1].verdict) {
      this.stuckReason = `Alternating verdict pattern detected over ${this.windowSize} rounds — agent is oscillating`;
      return true;
    }
    return false;
  }
}
