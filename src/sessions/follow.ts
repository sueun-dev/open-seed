import type { SessionConfig, JsonLineEvent } from "../core/types.js";
import { SessionStore } from "./store.js";

export interface SessionFollower {
  stop(): Promise<void>;
}

export async function followSessionEvents(params: {
  cwd: string;
  config: SessionConfig;
  sessionId: string;
  fromStart?: boolean;
  intervalMs?: number;
  onEvent: (event: JsonLineEvent) => void | Promise<void>;
}): Promise<SessionFollower> {
  const store = new SessionStore(params.cwd, params.config);
  const intervalMs = params.intervalMs ?? 75;
  let seen = 0;

  if (params.fromStart === false) {
    seen = (await store.readEvents(params.sessionId)).length;
  }

  let stopped = false;
  let wakeResolver: (() => void) | undefined;
  const drain = async () => {
    const events = await store.readEvents(params.sessionId);
    if (events.length <= seen) {
      return;
    }
    const nextEvents = events.slice(seen);
    seen = events.length;
    for (const event of nextEvents) {
      await params.onEvent(event);
    }
  };
  const loop = (async () => {
    while (!stopped) {
      await drain();

      await new Promise<void>((resolve) => {
        wakeResolver = resolve;
        setTimeout(resolve, intervalMs);
      });
      wakeResolver = undefined;
    }
    await drain();
  })();

  return {
    async stop() {
      stopped = true;
      wakeResolver?.();
      await loop;
    }
  };
}

export function formatLiveEvent(event: JsonLineEvent): string | null {
  const time = event.at.slice(11, 19);

  switch (event.type) {
    case "session.started":
      return `${time} session started`;
    case "session.resumed":
      return `${time} session resumed`;
    case "task.created":
      return `${time} task ${stringValue(event.payload.role)} via ${stringValue(event.payload.provider)}`;
    case "worker.spawned":
      return `${time} worker ${stringValue(event.payload.role)} ${stringValue(event.payload.transport)}`;
    case "provider.retry":
      // Only show if more than 1 retry
      return numberValue(event.payload.attempts, 1) > 1
        ? `${time} provider retry ${stringValue(event.payload.provider)} x${numberValue(event.payload.attempts, 1)}`
        : null;
    case "provider.fallback":
      return `${time} provider fallback ${stringValue(event.payload.from)} -> ${stringValue(event.payload.to)}`;
    case "provider.stream":
      // Suppress — too noisy for terminal/UI. LLM tokens stream at 50+ per second.
      return null;
    case "tool.called":
      return `${time} tool start ${stringValue(event.payload.tool)}`;
    case "tool.stream":
      // Suppress — bash/git stdout chunks are too frequent for card display.
      return null;
    case "tool.completed":
      return typeof event.payload.ok === "boolean"
        ? `${time} tool done ${stringValue(event.payload.tool)} ok=${String(event.payload.ok)}`
        : `${time} tool done ${stringValue(event.payload.tool)}`;
    case "approval.requested":
      return `${time} approval requested ${stringValue(event.payload.tool)} ${stringValue(event.payload.action)}`;
    case "review.pass":
      return `${time} review pass`;
    case "review.fail":
      return `${time} review fail`;
    case "session.completed":
      return `${time} session completed ${stringValue(event.payload.status)}`;
    default:
      return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
