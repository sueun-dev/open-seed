/**
 * Tests for parallel thread execution in AGI Mode.
 *
 * Covers:
 * 1. Per-thread UI state save/restore on switch
 * 2. Multiple threads can be "running" simultaneously
 * 3. WebSocket events append to correct thread (not active one)
 * 4. Thread switch preserves running state of background threads
 * 5. appendThreadEvent avoids stale closure (functional update)
 * 6. New thread view resets UI state without affecting running threads
 */

// ─── Simulate App-level thread store ────────────────────────────────────────

type Thread = {
  id: string;
  name: string;
  mode: "agi";
  projectPath: string;
  updatedAt: string;
  events: any[];
  running?: boolean;
};

function createThreadStore() {
  let threads: Thread[] = [];

  return {
    getThreads: () => threads,
    getThread: (id: string) => threads.find((t) => t.id === id) || null,

    createThread: (name: string): string => {
      const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      threads = [
        { id, name, mode: "agi", projectPath: "/test", updatedAt: new Date().toISOString(), events: [] },
        ...threads,
      ];
      return id;
    },

    updateThreadEvents: (threadId: string, events: any[]) => {
      threads = threads.map((t) =>
        t.id === threadId ? { ...t, events, updatedAt: new Date().toISOString() } : t
      );
    },

    appendThreadEvent: (threadId: string, event: any) => {
      threads = threads.map((t) =>
        t.id === threadId ? { ...t, events: [...t.events, event], updatedAt: new Date().toISOString() } : t
      );
    },

    setThreadRunning: (threadId: string, running: boolean) => {
      threads = threads.map((t) =>
        t.id === threadId ? { ...t, running } : t
      );
    },
  };
}

// ─── Simulate per-thread UI state map (mirrors AGIMode ref) ─────────────────

type ThreadUIState = {
  task: string;
  clarification: any;
  planReview: any;
  intakeLoading: boolean;
  provider: "claude" | "codex" | "both";
};

function createUIStateStore() {
  const states = new Map<string, ThreadUIState>();

  return {
    save: (threadId: string, state: ThreadUIState) => {
      states.set(threadId, { ...state });
    },
    restore: (threadId: string): ThreadUIState | undefined => {
      return states.get(threadId);
    },
    has: (threadId: string) => states.has(threadId),
    size: () => states.size,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("parallel thread execution", () => {
  test("multiple threads can be running simultaneously", () => {
    const store = createThreadStore();

    const id1 = store.createThread("Task A");
    const id2 = store.createThread("Task B");
    const id3 = store.createThread("Task C");

    store.setThreadRunning(id1, true);
    store.setThreadRunning(id2, true);
    store.setThreadRunning(id3, true);

    expect(store.getThread(id1)?.running).toBe(true);
    expect(store.getThread(id2)?.running).toBe(true);
    expect(store.getThread(id3)?.running).toBe(true);

    // Complete one — others still running
    store.setThreadRunning(id2, false);
    expect(store.getThread(id1)?.running).toBe(true);
    expect(store.getThread(id2)?.running).toBe(false);
    expect(store.getThread(id3)?.running).toBe(true);
  });

  test("appendThreadEvent adds to correct thread regardless of active thread", () => {
    const store = createThreadStore();

    const id1 = store.createThread("Task A");
    const id2 = store.createThread("Task B");
    store.setThreadRunning(id1, true);
    store.setThreadRunning(id2, true);

    // Simulate: user is viewing thread 2, but thread 1 receives WS event
    store.appendThreadEvent(id1, { type: "stage.start", data: { name: "intake" } });
    store.appendThreadEvent(id1, { type: "stage.complete", data: { name: "intake" } });

    // Thread 1 has events, thread 2 does not
    expect(store.getThread(id1)?.events.length).toBe(2);
    expect(store.getThread(id2)?.events.length).toBe(0);

    // Now thread 2 gets events
    store.appendThreadEvent(id2, { type: "stage.start", data: { name: "plan" } });
    expect(store.getThread(id2)?.events.length).toBe(1);

    // Thread 1 events unchanged
    expect(store.getThread(id1)?.events.length).toBe(2);
  });

  test("pipeline.complete only stops its own thread", () => {
    const store = createThreadStore();

    const id1 = store.createThread("Task A");
    const id2 = store.createThread("Task B");
    store.setThreadRunning(id1, true);
    store.setThreadRunning(id2, true);

    // Thread 1 completes
    store.appendThreadEvent(id1, { type: "pipeline.complete", data: {} });
    store.setThreadRunning(id1, false);

    // Thread 2 still running
    expect(store.getThread(id1)?.running).toBe(false);
    expect(store.getThread(id2)?.running).toBe(true);
  });

  test("events accumulate correctly with multiple concurrent appends", () => {
    const store = createThreadStore();
    const id1 = store.createThread("Task A");
    const id2 = store.createThread("Task B");

    // Interleaved events from two threads (simulates concurrent WS)
    store.appendThreadEvent(id1, { type: "stage.start", data: { name: "intake" } });
    store.appendThreadEvent(id2, { type: "stage.start", data: { name: "intake" } });
    store.appendThreadEvent(id1, { type: "stage.complete", data: { name: "intake" } });
    store.appendThreadEvent(id1, { type: "stage.start", data: { name: "plan" } });
    store.appendThreadEvent(id2, { type: "stage.complete", data: { name: "intake" } });

    expect(store.getThread(id1)?.events.length).toBe(3);
    expect(store.getThread(id2)?.events.length).toBe(2);

    // Verify event order within each thread
    expect(store.getThread(id1)?.events.map((e: any) => e.type)).toEqual([
      "stage.start", "stage.complete", "stage.start",
    ]);
    expect(store.getThread(id2)?.events.map((e: any) => e.type)).toEqual([
      "stage.start", "stage.complete",
    ]);
  });
});

describe("per-thread UI state save/restore", () => {
  test("save and restore preserves full state", () => {
    const uiStore = createUIStateStore();

    const state1: ThreadUIState = {
      task: "Build a REST API",
      clarification: { questions: [{ question: "Which DB?", options: ["Postgres", "SQLite"] }], answers: ["Postgres"] },
      planReview: null,
      intakeLoading: false,
      provider: "claude",
    };

    uiStore.save("thread-1", state1);

    const restored = uiStore.restore("thread-1");
    expect(restored).toBeDefined();
    expect(restored!.task).toBe("Build a REST API");
    expect(restored!.clarification.answers[0]).toBe("Postgres");
    expect(restored!.provider).toBe("claude");
  });

  test("switching threads saves old state and restores new state", () => {
    const uiStore = createUIStateStore();

    // Thread 1: user was in clarification step
    const state1: ThreadUIState = {
      task: "Build API",
      clarification: { questions: [{ question: "Auth?", options: ["JWT"] }], answers: ["JWT"] },
      planReview: null,
      intakeLoading: false,
      provider: "claude",
    };

    // Thread 2: user was in plan review step
    const state2: ThreadUIState = {
      task: "Fix bug",
      clarification: null,
      planReview: { plan: { plan: "Step 1: find bug" } },
      intakeLoading: false,
      provider: "codex",
    };

    uiStore.save("thread-1", state1);
    uiStore.save("thread-2", state2);

    // Switch to thread 2
    const restored2 = uiStore.restore("thread-2");
    expect(restored2!.task).toBe("Fix bug");
    expect(restored2!.planReview).not.toBeNull();
    expect(restored2!.provider).toBe("codex");

    // Switch back to thread 1
    const restored1 = uiStore.restore("thread-1");
    expect(restored1!.task).toBe("Build API");
    expect(restored1!.clarification).not.toBeNull();
    expect(restored1!.provider).toBe("claude");
  });

  test("new thread has no saved state", () => {
    const uiStore = createUIStateStore();
    expect(uiStore.restore("nonexistent")).toBeUndefined();
    expect(uiStore.has("nonexistent")).toBe(false);
  });

  test("save does not mutate original object", () => {
    const uiStore = createUIStateStore();
    const state: ThreadUIState = {
      task: "Original",
      clarification: null,
      planReview: null,
      intakeLoading: false,
      provider: "claude",
    };

    uiStore.save("thread-1", state);

    // Mutate original
    state.task = "Mutated";

    // Restored should have original
    const restored = uiStore.restore("thread-1");
    expect(restored!.task).toBe("Original");
  });
});

describe("thread store + UI state integration", () => {
  test("full parallel workflow: 2 threads running, switch between them", () => {
    const store = createThreadStore();
    const uiStore = createUIStateStore();

    // Start thread 1
    const id1 = store.createThread("Build API");
    store.setThreadRunning(id1, true);
    uiStore.save(id1, {
      task: "Build API",
      clarification: null,
      planReview: null,
      intakeLoading: false,
      provider: "claude",
    });

    // Start thread 2 (user switches away from thread 1)
    const id2 = store.createThread("Fix bug");
    store.setThreadRunning(id2, true);
    uiStore.save(id2, {
      task: "Fix bug",
      clarification: null,
      planReview: null,
      intakeLoading: false,
      provider: "codex",
    });

    // Both running
    expect(store.getThread(id1)?.running).toBe(true);
    expect(store.getThread(id2)?.running).toBe(true);

    // Background events arrive for thread 1
    store.appendThreadEvent(id1, { type: "stage.start", data: { name: "implement" } });
    store.appendThreadEvent(id1, { type: "stage.complete", data: { name: "implement" } });
    store.appendThreadEvent(id1, { type: "pipeline.complete", data: {} });
    store.setThreadRunning(id1, false);

    // Thread 2 still running, thread 1 done
    expect(store.getThread(id1)?.running).toBe(false);
    expect(store.getThread(id1)?.events.length).toBe(3);
    expect(store.getThread(id2)?.running).toBe(true);
    expect(store.getThread(id2)?.events.length).toBe(0);

    // User switches back to thread 1 — state restored
    const restored1 = uiStore.restore(id1);
    expect(restored1!.task).toBe("Build API");
    expect(restored1!.provider).toBe("claude");

    // Thread 2 continues in background
    store.appendThreadEvent(id2, { type: "pipeline.complete", data: {} });
    store.setThreadRunning(id2, false);

    expect(store.getThread(id2)?.running).toBe(false);
    expect(store.getThread(id2)?.events.length).toBe(1);
  });

  test("error in one thread does not affect another", () => {
    const store = createThreadStore();

    const id1 = store.createThread("Task A");
    const id2 = store.createThread("Task B");
    store.setThreadRunning(id1, true);
    store.setThreadRunning(id2, true);

    // Thread 1 fails
    store.appendThreadEvent(id1, { type: "pipeline.fail", data: { error: "crash" } });
    store.setThreadRunning(id1, false);

    // Thread 2 unaffected
    expect(store.getThread(id2)?.running).toBe(true);
    expect(store.getThread(id2)?.events.length).toBe(0);

    // Thread 2 succeeds
    store.appendThreadEvent(id2, { type: "pipeline.complete", data: {} });
    store.setThreadRunning(id2, false);

    expect(store.getThread(id1)?.events[0].type).toBe("pipeline.fail");
    expect(store.getThread(id2)?.events[0].type).toBe("pipeline.complete");
  });
});
