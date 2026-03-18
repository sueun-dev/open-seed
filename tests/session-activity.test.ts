import { describe, expect, it } from "vitest";

import type { BrowserCheckpoint, JsonLineEvent, SessionRecord } from "../src/core/types.js";
import { formatSessionActivity, summarizeSessionActivity } from "../src/sessions/activity.js";

describe("session activity", () => {
  it("summarizes provider, stream, and browser activity for status output", () => {
    const session: SessionRecord = {
      id: "ses_123",
      cwd: "/tmp/project",
      task: "Fix the broken checkout flow",
      status: "completed",
      createdAt: "2026-03-16T10:00:00.000Z",
      updatedAt: "2026-03-16T10:05:00.000Z",
      tasks: [
        {
          id: "task_1",
          sessionId: "ses_123",
          role: "planner",
          category: "planning",
          provider: "anthropic",
          prompt: "plan",
          status: "completed",
          transport: "inline",
          createdAt: "2026-03-16T10:00:00.000Z",
          updatedAt: "2026-03-16T10:01:00.000Z"
        },
        {
          id: "task_2",
          sessionId: "ses_123",
          role: "executor",
          category: "execution",
          provider: "openai",
          prompt: "execute",
          status: "completed",
          transport: "inline",
          createdAt: "2026-03-16T10:01:00.000Z",
          updatedAt: "2026-03-16T10:04:00.000Z"
        }
      ],
      lastReview: {
        verdict: "pass",
        summary: "Tests are green.",
        followUp: []
      }
    };
    const events: JsonLineEvent[] = [
      {
        type: "provider.retry",
        at: "2026-03-16T10:02:00.000Z",
        payload: { provider: "openai", attempts: 2 }
      },
      {
        type: "provider.fallback",
        at: "2026-03-16T10:02:10.000Z",
        payload: { from: "anthropic", to: "openai" }
      },
      {
        type: "provider.stream",
        at: "2026-03-16T10:02:20.000Z",
        payload: { provider: "openai", role: "planner", chunk: "{\"summary\":\"partial\"}" }
      },
      {
        type: "delegation.completed",
        at: "2026-03-16T10:03:20.000Z",
        payload: {
          role: "security-auditor",
          contractKind: "security-review",
          title: "Audit auth, token, and security boundaries",
          summary: "Reviewed the auth boundary."
        }
      },
      {
        type: "tool.stream",
        at: "2026-03-16T10:03:00.000Z",
        payload: { tool: "bash", stream: "stdout", chunk: "hello from tests\n" }
      }
    ];
    const checkpoints: BrowserCheckpoint[] = [
      {
        id: "browser_1",
        sessionId: "ses_123",
        sessionName: "default",
        action: "screenshot",
        url: "https://example.com",
        title: "Example",
        createdAt: "2026-03-16T10:04:30.000Z",
        screenshotPath: ".agent/browser/capture.png"
      }
    ];

    const summary = summarizeSessionActivity(session, events, checkpoints);
    const rendered = formatSessionActivity(summary);

    expect(summary.taskCounts.completed).toBe(2);
    expect(rendered).toContain("Status: completed");
    expect(rendered).toContain("openai retried 2 time(s)");
    expect(rendered).toContain("fallback from anthropic");
    expect(rendered).toContain("Recent provider streams:");
    expect(rendered).toContain("bash/stdout: hello from tests");
    expect(rendered).toContain("security-auditor [security-review]");
    expect(rendered).toContain("Browser checkpoints:");
  });
});
