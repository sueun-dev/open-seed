/**
 * Human-in-the-Loop — LangGraph-style pause/approve/resume mid-execution.
 *
 * Allows the agent to:
 * 1. Pause at critical decision points
 * 2. Present options to the user
 * 3. Wait for approval before proceeding
 * 4. Resume from exactly where it paused
 * 5. Allow the user to modify the plan mid-flight
 *
 * Source: LangGraph "Human-in-the-loop interrupts"
 */

export type HitlDecision = "approve" | "reject" | "modify" | "skip" | "abort";

export interface HitlCheckpoint {
  id: string;
  phase: string;
  round: number;
  description: string;
  /** What the agent wants to do */
  proposedAction: string;
  /** Why it needs approval */
  reason: string;
  /** Options presented to the user */
  options: string[];
  /** Current state snapshot */
  stateSnapshot: Record<string, unknown>;
  createdAt: string;
  /** User's decision (null if pending) */
  decision: HitlDecision | null;
  /** User's message/modification */
  userMessage: string | null;
  resolvedAt: string | null;
}

export interface HitlPolicy {
  /** Always interrupt before these actions */
  interruptBefore: string[];
  /** Always interrupt after these actions */
  interruptAfter: string[];
  /** Confidence threshold below which to interrupt */
  confidenceThreshold: number;
  /** Auto-approve after this many seconds (0 = never) */
  autoApproveAfterMs: number;
  /** Whether to allow modification of plans */
  allowModification: boolean;
}

const DEFAULT_HITL_POLICY: HitlPolicy = {
  interruptBefore: ["git_push", "deploy", "delete", "migration"],
  interruptAfter: [],
  confidenceThreshold: 0.4,
  autoApproveAfterMs: 0,
  allowModification: true
};

export class HitlManager {
  private checkpoints = new Map<string, HitlCheckpoint>();
  private pendingResolvers = new Map<string, (decision: HitlDecision, message?: string) => void>();
  private policy: HitlPolicy;
  private counter = 0;

  constructor(policy?: Partial<HitlPolicy>) {
    this.policy = { ...DEFAULT_HITL_POLICY, ...policy };
  }

  /**
   * Check if an action requires human approval.
   */
  needsApproval(action: string, confidence: number): boolean {
    if (this.policy.interruptBefore.some(p => action.toLowerCase().includes(p))) return true;
    if (confidence < this.policy.confidenceThreshold) return true;
    return false;
  }

  /**
   * Create an interrupt point and wait for human decision.
   */
  async interrupt(params: {
    phase: string;
    round: number;
    description: string;
    proposedAction: string;
    reason: string;
    options?: string[];
    state?: Record<string, unknown>;
    /** Callback when user needs to be notified */
    onNotify?: (checkpoint: HitlCheckpoint) => void | Promise<void>;
  }): Promise<{ decision: HitlDecision; message?: string }> {
    const id = `hitl-${++this.counter}-${Date.now()}`;

    const checkpoint: HitlCheckpoint = {
      id,
      phase: params.phase,
      round: params.round,
      description: params.description,
      proposedAction: params.proposedAction,
      reason: params.reason,
      options: params.options ?? ["approve", "reject", "modify"],
      stateSnapshot: params.state ?? {},
      createdAt: new Date().toISOString(),
      decision: null,
      userMessage: null,
      resolvedAt: null
    };

    this.checkpoints.set(id, checkpoint);

    // Notify the user
    await params.onNotify?.(checkpoint);

    // Wait for resolution
    return new Promise<{ decision: HitlDecision; message?: string }>((resolve) => {
      // Auto-approve timeout
      if (this.policy.autoApproveAfterMs > 0) {
        setTimeout(() => {
          if (!checkpoint.decision) {
            this.resolve(id, "approve", "Auto-approved after timeout");
          }
        }, this.policy.autoApproveAfterMs);
      }

      this.pendingResolvers.set(id, (decision, message) => {
        resolve({ decision, message });
      });
    });
  }

  /**
   * Resolve a pending interrupt (called by user/UI).
   */
  resolve(checkpointId: string, decision: HitlDecision, message?: string): boolean {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint || checkpoint.decision) return false;

    checkpoint.decision = decision;
    checkpoint.userMessage = message ?? null;
    checkpoint.resolvedAt = new Date().toISOString();

    const resolver = this.pendingResolvers.get(checkpointId);
    if (resolver) {
      resolver(decision, message);
      this.pendingResolvers.delete(checkpointId);
    }

    return true;
  }

  /**
   * Get all pending (unresolved) checkpoints.
   */
  getPending(): HitlCheckpoint[] {
    return Array.from(this.checkpoints.values()).filter(c => !c.decision);
  }

  /**
   * Get checkpoint history.
   */
  getHistory(): HitlCheckpoint[] {
    return Array.from(this.checkpoints.values());
  }

  getPolicy(): HitlPolicy {
    return { ...this.policy };
  }
}

export function formatHitlPrompt(checkpoint: HitlCheckpoint): string {
  return [
    `## ⏸ Human Approval Required`,
    ``,
    `**${checkpoint.description}**`,
    ``,
    `Proposed: ${checkpoint.proposedAction}`,
    `Reason: ${checkpoint.reason}`,
    ``,
    `Options: ${checkpoint.options.join(" | ")}`,
  ].join("\n");
}
