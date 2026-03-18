import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { ApprovalDecision } from "../src/core/types.js";
import { SessionApprovalResolver } from "../src/safety/resolver.js";

const baseDecision: ApprovalDecision = {
  action: "write",
  mode: "ask",
  approved: false,
  reason: "Need to modify the file"
};

describe("SessionApprovalResolver", () => {
  it("approves from AGENT40_AUTO_APPROVE without prompting", async () => {
    const resolver = new SessionApprovalResolver({
      env: {
        AGENT40_AUTO_APPROVE: "write"
      },
      interactive: false
    });

    const result = await resolver.resolve(baseDecision, {
      name: "write",
      reason: "Modify the file"
    });

    expect(result.approved).toBe(true);
  });

  it("supports interactive same-action approval caching", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end("s\n");

    const resolver = new SessionApprovalResolver({
      input,
      output,
      interactive: true
    });

    const first = await resolver.resolve(baseDecision, {
      name: "write",
      reason: "Modify the file"
    });
    const second = await resolver.resolve({
      ...baseDecision,
      reason: "Modify another file"
    }, {
      name: "write",
      reason: "Modify another file"
    });

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
  });
});
