import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/core/config.js";
import type { JsonLineEvent } from "../src/core/types.js";
import { followSessionEvents, formatLiveEvent } from "../src/sessions/follow.js";
import { SessionStore } from "../src/sessions/store.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-follow-"));
  tempDirs.push(cwd);
  return cwd;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 400): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session follow", () => {
  it("formats live events for CLI output", () => {
    const line = formatLiveEvent({
      type: "provider.fallback",
      at: "2026-03-16T20:00:00.000Z",
      payload: { from: "anthropic", to: "openai" }
    });

    expect(line).toBe("20:00:00 provider fallback anthropic -> openai");
  });

  it("tails newly appended session events", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("follow session");
    const seen: JsonLineEvent[] = [];

    const follower = await followSessionEvents({
      cwd,
      config: config.sessions,
      sessionId: session.id,
      fromStart: false,
      intervalMs: 10,
      onEvent(event) {
        seen.push(event);
      }
    });

    await store.appendEvent(session.id, {
      type: "tool.called",
      at: "2026-03-16T20:00:01.000Z",
      payload: { tool: "bash" }
    });

    await waitFor(() => seen.length === 1);
    await follower.stop();

    expect(seen[0]?.type).toBe("tool.called");
    expect(seen[0]?.payload.tool).toBe("bash");
  });

  it("flushes final events when stopped immediately after an append", async () => {
    const cwd = await makeProject();
    const config = createDefaultConfig();
    const store = new SessionStore(cwd, config.sessions);
    const session = await store.createSession("follow final flush");
    const seen: JsonLineEvent[] = [];

    const follower = await followSessionEvents({
      cwd,
      config: config.sessions,
      sessionId: session.id,
      fromStart: false,
      intervalMs: 50,
      onEvent(event) {
        seen.push(event);
      }
    });

    await store.appendEvent(session.id, {
      type: "review.pass",
      at: "2026-03-16T20:00:02.000Z",
      payload: {}
    });
    await follower.stop();

    expect(seen.map((event) => event.type)).toContain("review.pass");
  });
});
