import { describe, it, expect } from "vitest";
import { SpawnReservationManager } from "../src/orchestration/spawn-reservation.js";

describe("Spawn Reservation", () => {
  it("reserves and activates a slot", async () => {
    const mgr = new SpawnReservationManager({ maxConcurrentAgents: 3 });
    const rsv = await mgr.reserve({ sessionId: "s1", roleId: "executor" });
    expect(rsv.status).toBe("reserved");
    mgr.activate(rsv.id);
    expect(mgr.getActiveCount()).toBe(1);
  });

  it("enforces max concurrent limit", async () => {
    const mgr = new SpawnReservationManager({ maxConcurrentAgents: 2, maxQueueDepth: 5 });
    await mgr.reserve({ sessionId: "s1", roleId: "a" });
    await mgr.reserve({ sessionId: "s2", roleId: "b" });
    // Third should queue
    const p3 = mgr.reserve({ sessionId: "s3", roleId: "c" });
    expect(mgr.getQueueDepth()).toBe(1);
    // Complete one to drain queue
    const status = mgr.getStatus();
    mgr.complete(status.reservations[0].id);
    const rsv3 = await p3;
    expect(rsv3.status).toBe("reserved");
    expect(mgr.getQueueDepth()).toBe(0);
  });

  it("enforces per-parent limit", async () => {
    const mgr = new SpawnReservationManager({ maxConcurrentAgents: 10, maxPerParentSession: 2, maxQueueDepth: 5 });
    await mgr.reserve({ sessionId: "c1", parentSessionId: "parent", roleId: "a" });
    await mgr.reserve({ sessionId: "c2", parentSessionId: "parent", roleId: "b" });
    const p3 = mgr.reserve({ sessionId: "c3", parentSessionId: "parent", roleId: "c" });
    expect(mgr.getQueueDepth()).toBe(1);
    mgr.complete(mgr.getStatus().reservations[0].id);
    await p3;
    expect(mgr.getQueueDepth()).toBe(0);
  });

  it("rejects when queue is full", async () => {
    const mgr = new SpawnReservationManager({ maxConcurrentAgents: 1, maxQueueDepth: 1 });
    await mgr.reserve({ sessionId: "s1", roleId: "a" });
    mgr.reserve({ sessionId: "s2", roleId: "b" }); // queued
    await expect(mgr.reserve({ sessionId: "s3", roleId: "c" })).rejects.toThrow("queue full");
  });

  it("releases on fail", async () => {
    const mgr = new SpawnReservationManager({ maxConcurrentAgents: 1, maxQueueDepth: 5 });
    const r1 = await mgr.reserve({ sessionId: "s1", roleId: "a" });
    const p2 = mgr.reserve({ sessionId: "s2", roleId: "b" });
    mgr.fail(r1.id);
    const r2 = await p2;
    expect(r2.status).toBe("reserved");
  });
});
