/**
 * HUD — Heads-Up Display for real-time progress tracking.
 *
 * Inspired by oh-my-claudecode:
 * - Real-time status line showing progress, task, time, tokens, model
 * - Works in terminal (ANSI) and web (JSON events)
 * - Tracks worker count, pending tasks, current step
 */

import type { AgentEventBus } from "../core/event-bus.js";
import type { CostTracker } from "./cost-tracker.js";

export interface HudState {
  phase: string;
  currentTask: string;
  progress: number; // 0-100
  startedAt: number;
  tokensUsed: number;
  tokensMax: number;
  model: string;
  activeWorkers: number;
  maxWorkers: number;
  pendingTasks: number;
  completedTasks: number;
  totalTasks: number;
  lastEvent: string;
  costUsd: number;
  round: number;
  maxRounds: number;
}

export function createHudState(): HudState {
  return {
    phase: "idle",
    currentTask: "",
    progress: 0,
    startedAt: Date.now(),
    tokensUsed: 0,
    tokensMax: 200_000,
    model: "",
    activeWorkers: 0,
    maxWorkers: 1,
    pendingTasks: 0,
    completedTasks: 0,
    totalTasks: 0,
    lastEvent: "",
    costUsd: 0,
    round: 0,
    maxRounds: 8
  };
}

export function updateHudFromEvent(hud: HudState, eventType: string, payload: Record<string, unknown>): HudState {
  const updated = { ...hud };

  switch (eventType) {
    case "session.started":
      updated.phase = "planning";
      updated.model = String(payload.modelFamily ?? "");
      updated.startedAt = Date.now();
      break;
    case "phase.transition":
      updated.phase = String(payload.to ?? "");
      if (payload.to === "executing") updated.progress = Math.min(90, updated.progress + 20);
      if (payload.to === "reviewing") updated.progress = Math.min(95, updated.progress + 10);
      if (payload.to === "done") updated.progress = 100;
      break;
    case "tool.called":
      updated.lastEvent = `${payload.tool}`;
      break;
    case "tool.completed":
      updated.lastEvent = `${payload.tool} ${payload.ok ? "✓" : "✗"}`;
      break;
    case "enforcer.checklist":
      updated.round = (payload.round as number) ?? updated.round;
      break;
    case "delegation.started":
      updated.activeWorkers++;
      updated.pendingTasks = Math.max(0, updated.pendingTasks - 1);
      break;
    case "delegation.completed":
      updated.activeWorkers = Math.max(0, updated.activeWorkers - 1);
      updated.completedTasks++;
      break;
    case "cost.update":
      updated.costUsd = payload.costAvailable === false ? 0 : ((payload.totalCostUsd as number) ?? updated.costUsd);
      updated.tokensUsed = (payload.totalTokens as number) ?? updated.tokensUsed;
      break;
    case "session.completed":
      updated.phase = "done";
      updated.progress = 100;
      break;
  }

  updated.lastEvent = updated.lastEvent || eventType;
  return updated;
}

/**
 * Format HUD for terminal display (single line).
 */
export function formatHudTerminal(hud: HudState): string {
  const elapsed = Math.round((Date.now() - hud.startedAt) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const time = `${minutes}m${String(seconds).padStart(2, "0")}s`;

  const bar = renderProgressBar(hud.progress, 20);
  const tokens = hud.tokensUsed > 0 ? `${Math.round(hud.tokensUsed / 1000)}k/${Math.round(hud.tokensMax / 1000)}k` : "";
  const cost = hud.costUsd > 0 ? `$${hud.costUsd.toFixed(4)}` : "";
  const workers = hud.activeWorkers > 0 ? `Workers: ${hud.activeWorkers}/${hud.maxWorkers}` : "";
  const round = hud.round > 0 ? `Round ${hud.round}/${hud.maxRounds}` : "";

  const parts = [
    bar,
    `${hud.progress}%`,
    hud.phase,
    time,
    tokens,
    cost,
    round,
    workers,
    hud.lastEvent
  ].filter(Boolean);

  return parts.join(" | ");
}

/**
 * Format HUD as JSON for web consumption.
 */
export function formatHudJson(hud: HudState): Record<string, unknown> {
  return {
    phase: hud.phase,
    progress: hud.progress,
    elapsed: Math.round((Date.now() - hud.startedAt) / 1000),
    tokensUsed: hud.tokensUsed,
    tokensMax: hud.tokensMax,
    model: hud.model,
    costUsd: hud.costUsd,
    round: hud.round,
    maxRounds: hud.maxRounds,
    activeWorkers: hud.activeWorkers,
    completedTasks: hud.completedTasks,
    totalTasks: hud.totalTasks,
    lastEvent: hud.lastEvent
  };
}

/**
 * Wire HUD to event bus for automatic updates.
 */
export function wireHudToEventBus(bus: AgentEventBus, hud: HudState, onUpdate: (hud: HudState) => void): void {
  bus.on("*", async (event) => {
    const updated = updateHudFromEvent(hud, event.type, event.payload);
    Object.assign(hud, updated);
    onUpdate(hud);
  });
}

function renderProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${"=".repeat(filled)}${filled < width ? ">" : ""}${" ".repeat(Math.max(0, empty - 1))}]`;
}
