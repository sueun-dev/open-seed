import { describe, expect, it } from "vitest";

import { ApprovalEngine } from "../src/safety/approval.js";
import { createDefaultConfig } from "../src/core/config.js";

describe("ApprovalEngine", () => {
  it("auto-approves safe actions", () => {
    const engine = new ApprovalEngine(createDefaultConfig().safety);
    const decision = engine.decide("read", "read repo");
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe("auto");
  });

  it("requires approval for side-effect actions", () => {
    const engine = new ApprovalEngine(createDefaultConfig().safety);
    const decision = engine.decide("git_push", "push changes");
    expect(decision.approved).toBe(false);
    expect(decision.mode).toBe("ask");
  });
});
