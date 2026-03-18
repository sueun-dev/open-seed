import type { ApprovalAction, ApprovalDecision, ApprovalPolicy } from "../core/types.js";

export class ApprovalEngine {
  constructor(private readonly policy: ApprovalPolicy) {}

  decide(action: ApprovalAction, reason: string): ApprovalDecision {
    if (this.policy.autoApprove.includes(action)) {
      return {
        action,
        mode: "auto",
        approved: true,
        reason
      };
    }

    if (this.policy.requireApproval.includes(action)) {
      return {
        action,
        mode: "ask",
        approved: false,
        reason
      };
    }

    return {
      action,
      mode: this.policy.defaultMode,
      approved: this.policy.defaultMode === "auto",
      reason
    };
  }
}
