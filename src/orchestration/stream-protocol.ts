/**
 * Streaming Protocol for Real-Time UI.
 *
 * Codex-inspired streaming system that emits structured events
 * in real-time for terminal and desktop UI consumption.
 *
 * Supports:
 * - Phase transitions (planning → executing → reviewing)
 * - Tool call start/progress/complete
 * - LLM streaming tokens
 * - Cost updates
 * - Error events with recovery status
 *
 * Output format: NDJSON (one JSON object per line to stdout)
 */

import type { AgentEvent, AgentPhase } from "../core/types.js";
import type { AgentEventBus } from "../core/event-bus.js";

export interface StreamMessage {
  /** Message type for UI routing */
  kind: "phase" | "tool" | "llm" | "cost" | "error" | "info" | "complete";
  /** Human-readable text */
  text: string;
  /** Structured data */
  data: Record<string, unknown>;
  /** Timestamp */
  at: string;
}

export type StreamWriter = (message: StreamMessage) => void;

/**
 * Create a stream writer that outputs NDJSON to a writable stream.
 */
export function createNdjsonWriter(output: NodeJS.WritableStream): StreamWriter {
  return (message) => {
    output.write(JSON.stringify(message) + "\n");
  };
}

/**
 * Create a stream writer for terminal (human-readable with ANSI colors).
 */
export function createTerminalWriter(output: NodeJS.WritableStream): StreamWriter {
  const COLORS = {
    phase: "\x1b[36m",    // cyan
    tool: "\x1b[33m",     // yellow
    llm: "\x1b[37m",      // white
    cost: "\x1b[35m",     // magenta
    error: "\x1b[31m",    // red
    info: "\x1b[90m",     // gray
    complete: "\x1b[32m", // green
    reset: "\x1b[0m"
  };

  return (message) => {
    const color = COLORS[message.kind] ?? COLORS.info;
    const prefix = `${color}[${message.kind}]${COLORS.reset}`;
    output.write(`${prefix} ${message.text}\n`);
  };
}

/**
 * Wire an AgentEventBus to a StreamWriter.
 * Translates internal events into human-readable stream messages.
 */
export function wireEventBusToStream(bus: AgentEventBus, writer: StreamWriter): void {
  bus.on("phase.transition", async (event) => {
    const from = event.payload.from as string;
    const to = event.payload.to as string;
    writer({
      kind: "phase",
      text: `${from} → ${to}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("tool.called", async (event) => {
    writer({
      kind: "tool",
      text: `${event.payload.tool} — ${event.payload.reason ?? ""}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("tool.completed", async (event) => {
    const ok = event.payload.ok as boolean;
    const tool = event.payload.tool as string;
    const duration = event.payload.durationMs as number | undefined;
    const durationText = duration ? ` (${duration}ms)` : "";
    writer({
      kind: "tool",
      text: `${tool} ${ok ? "✓" : "✗"}${durationText}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("provider.stream", async (event) => {
    const chunk = event.payload.chunk as string;
    if (chunk.trim()) {
      writer({
        kind: "llm",
        text: chunk.slice(0, 200),
        data: { role: event.payload.role, provider: event.payload.provider },
        at: event.at
      });
    }
  });

  bus.on("cost.update", async (event) => {
    const costAvailable = event.payload.costAvailable !== false;
    const totalTokens = event.payload.totalTokens as number;
    const totalCostUsd = event.payload.totalCostUsd as number;
    writer({
      kind: "cost",
      text: costAvailable
        ? `$${totalCostUsd.toFixed(4)} (${totalTokens} tokens)`
        : `${totalTokens} tokens (OAuth; cost hidden)`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("review.pass", async (event) => {
    const review = event.payload.review as { summary: string };
    writer({
      kind: "complete",
      text: `Review passed: ${review.summary}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("review.fail", async (event) => {
    const review = event.payload.review as { summary: string };
    writer({
      kind: "error",
      text: `Review failed: ${review.summary}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("error.retriable", async (event) => {
    writer({
      kind: "error",
      text: `Retriable error: ${event.payload.message} (attempt ${event.payload.attempt})`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("error.fatal", async (event) => {
    writer({
      kind: "error",
      text: `Fatal error: ${event.payload.message}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("session.completed", async (event) => {
    const costs = (event.payload.costs as any) ?? {};
    const text = costs.hasBillableCost === false
      ? `Session ${event.payload.status}: OAuth cost hidden`
      : `Session ${event.payload.status}: cost $${(costs.totalEstimatedCostUsd ?? 0).toFixed(4)}`;
    writer({
      kind: "complete",
      text,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("sandbox.staged", async (event) => {
    writer({
      kind: "info",
      text: `Staged: ${event.payload.path} (${event.payload.bytes} bytes)`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("rule.blocked", async (event) => {
    writer({
      kind: "error",
      text: `Blocked by rule ${event.payload.ruleId}: ${event.payload.reason}`,
      data: event.payload,
      at: event.at
    });
  });

  bus.on("enforcer.checklist", async (event) => {
    const verdict = event.payload.verdict as string;
    const round = event.payload.round as number;
    writer({
      kind: "info",
      text: `Enforcer round ${round}: ${verdict}`,
      data: event.payload,
      at: event.at
    });
  });
}
