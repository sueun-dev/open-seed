import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../src/sessions/store.js";
import { createDefaultConfig } from "../src/core/config.js";
import type { JsonLineEvent } from "../src/core/types.js";

const tempDirs: string[] = [];

async function makeStore() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent40-session-"));
  tempDirs.push(cwd);
  return new SessionStore(cwd, createDefaultConfig().sessions);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("creates sessions and appends events", async () => {
    const store = await makeStore();
    const session = await store.createSession("do something");
    const event: JsonLineEvent = {
      type: "task.created",
      at: new Date().toISOString(),
      payload: { ok: true }
    };
    await store.appendEvent(session.id, event);
    const loaded = await store.loadSnapshot(session.id);
    const events = await store.readEvents(session.id);
    expect(loaded?.id).toBe(session.id);
    expect(events).toHaveLength(2);
  });
});
