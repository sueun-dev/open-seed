import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { ApprovalAction, ApprovalDecision, ToolCall } from "../core/types.js";

export interface ApprovalResolver {
  resolve(decision: ApprovalDecision, call: Pick<ToolCall, "name" | "reason">): Promise<ApprovalDecision>;
}

export interface SessionApprovalResolverOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
}

export class SessionApprovalResolver implements ApprovalResolver {
  private approveAll = false;
  private readonly approvedActions = new Set<ApprovalAction>();
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly env: NodeJS.ProcessEnv;
  private readonly interactive: boolean;

  constructor(options: SessionApprovalResolverOptions = {}) {
    this.input = options.input ?? stdin;
    this.output = options.output ?? stdout;
    this.env = options.env ?? process.env;
    this.interactive = options.interactive ?? Boolean((this.input as { isTTY?: boolean }).isTTY && (this.output as { isTTY?: boolean }).isTTY);
  }

  async resolve(decision: ApprovalDecision, call: Pick<ToolCall, "name" | "reason">): Promise<ApprovalDecision> {
    if (decision.approved || decision.mode !== "ask") {
      return decision;
    }
    if (this.approveAll) {
      return this.approved(decision, "approved for the rest of this session");
    }
    if (this.approvedActions.has(decision.action)) {
      return this.approved(decision, `approved for action ${decision.action} in this session`);
    }

    const envDecision = this.resolveFromEnv(decision, call);
    if (envDecision) {
      return envDecision;
    }

    if (!this.interactive) {
      return decision;
    }

    const rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: false
    });

    try {
      this.output.write(
        `\nApproval required for ${call.name} [${decision.action}]\nReason: ${decision.reason}\nApprove? [y]es/[n]o/[a]ll/[s]ame-action: `
      );
      const answer = (await rl.question("")).trim().toLowerCase();
      if (answer === "a" || answer === "all") {
        this.approveAll = true;
        return this.approved(decision, "approved for all remaining requests in this session");
      }
      if (answer === "s" || answer === "same" || answer === "same-action") {
        this.approvedActions.add(decision.action);
        return this.approved(decision, `approved for action ${decision.action} in this session`);
      }
      if (answer === "y" || answer === "yes") {
        return this.approved(decision, "approved interactively");
      }
      return {
        ...decision,
        approved: false,
        reason: `${decision.reason} (rejected interactively)`
      };
    } finally {
      rl.close();
    }
  }

  private resolveFromEnv(decision: ApprovalDecision, call: Pick<ToolCall, "name" | "reason">): ApprovalDecision | null {
    if (this.env.AGENT40_APPROVE_ALL === "1" || this.env.AGENT40_APPROVE_ALL === "true") {
      return this.approved(decision, "approved by AGENT40_APPROVE_ALL");
    }
    const tokens = (this.env.AGENT40_AUTO_APPROVE ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.includes("all") || tokens.includes(decision.action) || tokens.includes(call.name)) {
      return this.approved(decision, "approved by AGENT40_AUTO_APPROVE");
    }
    return null;
  }

  private approved(decision: ApprovalDecision, reason: string): ApprovalDecision {
    return {
      ...decision,
      approved: true,
      reason: `${decision.reason} (${reason})`
    };
  }
}
