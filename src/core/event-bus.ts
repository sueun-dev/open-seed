/**
 * OpenHands-inspired Event Stream / Event Bus.
 *
 * Central event system that decouples agent components. All state changes,
 * tool calls, provider interactions, and lifecycle events flow through here.
 * Supports typed subscriptions with wildcard matching.
 */

import type { AgentEvent, EventBus, EventHandler, EventSource, EventType } from "./types.js";
import { nowIso } from "./utils.js";

export class AgentEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on(type: EventType | "*", handler: EventHandler): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
  }

  off(type: EventType | "*", handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  async emit(event: AgentEvent): Promise<void> {
    const specific = this.handlers.get(event.type);
    const wildcard = this.handlers.get("*");

    const all: EventHandler[] = [];
    if (specific) all.push(...specific);
    if (wildcard) all.push(...wildcard);

    const results = await Promise.allSettled(all.map((h) => h(event)));
    for (const r of results) {
      if (r.status === "rejected") {
        // Log handler errors instead of silently swallowing
        if (process.env.AGENT40_DEBUG) {
          console.error(`[EventBus] Handler error for ${event.type}:`, r.reason);
        }
      }
    }
  }

  /** Convenience: create and emit in one call */
  async fire(
    type: EventType,
    source: EventSource,
    sessionId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.emit({ type, source, at: nowIso(), sessionId, payload });
  }

  /** Remove all handlers */
  clear(): void {
    this.handlers.clear();
  }

  /** Get handler count for testing */
  listenerCount(type?: EventType | "*"): number {
    if (type) return this.handlers.get(type)?.size ?? 0;
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }

  /**
   * OpenHands-inspired: fork the event stream for child agent delegation.
   * Creates a child bus that:
   * - Has its own handlers (isolated)
   * - Forwards all events to the parent bus (observable)
   * - Can be disconnected independently
   */
  fork(childSessionId?: string): AgentEventBus & { disconnect: () => void } {
    const child = new AgentEventBus();
    const parent = this;

    // Forward child events to parent (skip if already forwarded)
    const forwardHandler: EventHandler = async (event) => {
      if (event.payload._forwarded) return;
      await parent.emit({
        ...event,
        payload: {
          ...event.payload,
          _forkedFrom: childSessionId ?? "child",
          _originalSessionId: event.sessionId,
          _forwarded: true
        }
      });
    };
    child.on("*", forwardHandler);

    // Return child with disconnect method to prevent memory leaks
    return Object.assign(child, {
      disconnect: () => { child.off("*", forwardHandler); }
    });
  }
}

/**
 * Adapter: bridges AgentEventBus to the legacy SessionStore.appendEvent format.
 * Allows gradual migration from direct appendEvent calls to event bus.
 */
export function createLegacyEventAdapter(
  bus: AgentEventBus,
  sessionId: string
): (event: { type: string; at: string; payload: Record<string, unknown> }) => Promise<void> {
  return async (event) => {
    await bus.emit({
      type: event.type as EventType,
      source: "engine",
      at: event.at,
      sessionId,
      payload: event.payload
    });
  };
}
