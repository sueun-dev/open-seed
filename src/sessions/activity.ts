import type { BrowserCheckpoint, JsonLineEvent, SessionRecord } from "../core/types.js";

export interface SessionActivitySummary {
  sessionId: string;
  task: string;
  status: SessionRecord["status"];
  updatedAt: string;
  taskCounts: Record<SessionRecord["tasks"][number]["status"], number>;
  review?: SessionRecord["lastReview"];
  providerSignals: Array<{
    type: "provider.retry" | "provider.fallback";
    at: string;
    summary: string;
  }>;
  providerStreams: Array<{
    at: string;
    provider: string;
    role: string;
    preview: string;
  }>;
  toolStreams: Array<{
    at: string;
    tool: string;
    stream: string;
    preview: string;
  }>;
  delegationNotes: Array<{
    at: string;
    role: string;
    contractKind: string;
    title: string;
    summary: string;
  }>;
  browserCheckpoints: BrowserCheckpoint[];
}

export function summarizeSessionActivity(
  session: SessionRecord,
  events: JsonLineEvent[],
  browserCheckpoints: BrowserCheckpoint[]
): SessionActivitySummary {
  const taskCounts: SessionActivitySummary["taskCounts"] = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0
  };

  session.tasks.forEach((task) => {
    taskCounts[task.status] += 1;
  });

  const providerSignals = events
    .filter((event): event is JsonLineEvent & { type: "provider.retry" | "provider.fallback" } =>
      event.type === "provider.retry" || event.type === "provider.fallback"
    )
    .slice(-5)
    .map((event) => ({
      type: event.type,
      at: event.at,
      summary:
        event.type === "provider.retry"
          ? `${stringValue(event.payload.provider)} retried ${numberValue(event.payload.attempts, 0)} time(s)`
          : `${stringValue(event.payload.to)} fallback from ${stringValue(event.payload.from)}`
    }));

  const toolStreams = events
    .filter((event) => event.type === "tool.stream")
    .slice(-5)
    .map((event) => ({
      at: event.at,
      tool: stringValue(event.payload.tool),
      stream: stringValue(event.payload.stream),
      preview: stringValue(event.payload.chunk).replace(/\s+/g, " ").trim().slice(0, 120)
    }));

  const providerStreams = events
    .filter((event) => event.type === "provider.stream")
    .slice(-5)
    .map((event) => ({
      at: event.at,
      provider: stringValue(event.payload.provider),
      role: stringValue(event.payload.role),
      preview: stringValue(event.payload.chunk).replace(/\s+/g, " ").trim().slice(0, 120)
    }));

  const delegationNotes = events
    .filter((event) => event.type === "delegation.completed")
    .slice(-8)
    .map((event) => ({
      at: event.at,
      role: stringValue(event.payload.role),
      contractKind: stringValue(event.payload.contractKind),
      title: stringValue(event.payload.title),
      summary: stringValue(event.payload.summary)
    }));

  return {
    sessionId: session.id,
    task: session.task,
    status: session.status,
    updatedAt: session.updatedAt,
    taskCounts,
    review: session.lastReview,
    providerSignals,
    providerStreams,
    toolStreams,
    delegationNotes,
    browserCheckpoints: browserCheckpoints.slice(0, 5)
  };
}

export function formatSessionActivity(summary: SessionActivitySummary): string {
  const lines = [
    `Session: ${summary.sessionId}`,
    `Task: ${summary.task}`,
    `Status: ${summary.status}`,
    `Updated: ${summary.updatedAt}`,
    `Tasks: pending=${summary.taskCounts.pending} running=${summary.taskCounts.running} completed=${summary.taskCounts.completed} failed=${summary.taskCounts.failed}`
  ];

  if (summary.review) {
    lines.push(`Review: ${summary.review.verdict} - ${summary.review.summary}`);
  }

  if (summary.providerSignals.length > 0) {
    lines.push("Provider signals:");
    summary.providerSignals.forEach((signal) => {
      lines.push(`- ${signal.at} ${signal.summary}`);
    });
  }

  if (summary.providerStreams.length > 0) {
    lines.push("Recent provider streams:");
    summary.providerStreams.forEach((stream) => {
      lines.push(`- ${stream.at} ${stream.provider}/${stream.role}: ${stream.preview || "(empty chunk)"}`);
    });
  }

  if (summary.toolStreams.length > 0) {
    lines.push("Recent tool streams:");
    summary.toolStreams.forEach((stream) => {
      lines.push(`- ${stream.at} ${stream.tool}/${stream.stream}: ${stream.preview || "(empty chunk)"}`);
    });
  }

  if (summary.delegationNotes.length > 0) {
    lines.push("Recent delegation:");
    summary.delegationNotes.forEach((note) => {
      const contractText = note.contractKind ? ` [${note.contractKind}]` : "";
      lines.push(`- ${note.at} ${note.role}${contractText} on ${note.title}: ${note.summary}`);
    });
  }

  if (summary.browserCheckpoints.length > 0) {
    lines.push("Browser checkpoints:");
    summary.browserCheckpoints.forEach((checkpoint) => {
      lines.push(
        `- ${checkpoint.sessionName} ${checkpoint.action} ${checkpoint.url} ${checkpoint.title || "(untitled)"}`
      );
    });
  }

  return lines.join("\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
