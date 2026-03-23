import type { GameSnapshot } from './service.js';

export interface RealtimeRunSummary {
  readonly id: string;
  readonly survivalTimeMs: number;
  readonly hazardCount: number;
  readonly difficultyPeak: number;
}

export interface RealtimeSnapshotEvent {
  readonly type: 'snapshot';
  readonly sequence: number;
  readonly snapshot: GameSnapshot;
}

export interface RealtimeRunCreatedEvent {
  readonly type: 'run:created';
  readonly sequence: number;
  readonly run: RealtimeRunSummary;
}

export interface RealtimeDisconnectedEvent {
  readonly type: 'disconnected';
  readonly sequence: number;
  readonly reason: 'closed';
}

export type RealtimeEvent =
  | RealtimeSnapshotEvent
  | RealtimeRunCreatedEvent
  | RealtimeDisconnectedEvent;

export interface RealtimeClient {
  readonly id: string;
  push(event: RealtimeEvent): void;
}

export interface RealtimeChannel {
  subscribe(client: RealtimeClient): () => void;
  publishSnapshot(snapshot: GameSnapshot): RealtimeSnapshotEvent;
  publishRunCreated(run: RealtimeRunSummary): RealtimeRunCreatedEvent;
  getClientCount(): number;
}

function cloneSnapshot(snapshot: GameSnapshot): GameSnapshot {
  return {
    status: snapshot.status,
    game: {
      title: snapshot.game.title,
      controls: [...snapshot.game.controls],
      objective: snapshot.game.objective,
    },
    stats: snapshot.stats.latestRun
      ? {
          totalRuns: snapshot.stats.totalRuns,
          bestSurvivalTimeMs: snapshot.stats.bestSurvivalTimeMs,
          averageSurvivalTimeMs: snapshot.stats.averageSurvivalTimeMs,
          latestRun: { ...snapshot.stats.latestRun },
        }
      : {
          totalRuns: snapshot.stats.totalRuns,
          bestSurvivalTimeMs: snapshot.stats.bestSurvivalTimeMs,
          averageSurvivalTimeMs: snapshot.stats.averageSurvivalTimeMs,
          latestRun: null,
        },
  };
}

function cloneRun(run: RealtimeRunSummary): RealtimeRunSummary {
  return {
    id: run.id,
    survivalTimeMs: run.survivalTimeMs,
    hazardCount: run.hazardCount,
    difficultyPeak: run.difficultyPeak,
  };
}

export function createRealtimeChannel(initialSnapshot: GameSnapshot): RealtimeChannel {
  let sequence = 0;
  let currentSnapshot = cloneSnapshot(initialSnapshot);
  const clients = new Map<string, RealtimeClient>();

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  function broadcast(event: RealtimeEvent): void {
    for (const client of clients.values()) {
      client.push(event);
    }
  }

  return {
    subscribe(client: RealtimeClient): () => void {
      clients.set(client.id, client);

      const snapshotEvent: RealtimeSnapshotEvent = {
        type: 'snapshot',
        sequence: nextSequence(),
        snapshot: cloneSnapshot(currentSnapshot),
      };

      client.push(snapshotEvent);

      return () => {
        if (!clients.delete(client.id)) {
          return;
        }

        const disconnectedEvent: RealtimeDisconnectedEvent = {
          type: 'disconnected',
          sequence: nextSequence(),
          reason: 'closed',
        };

        client.push(disconnectedEvent);
      };
    },

    publishSnapshot(snapshot: GameSnapshot): RealtimeSnapshotEvent {
      currentSnapshot = cloneSnapshot(snapshot);
      const event: RealtimeSnapshotEvent = {
        type: 'snapshot',
        sequence: nextSequence(),
        snapshot: cloneSnapshot(currentSnapshot),
      };
      broadcast(event);
      return event;
    },

    publishRunCreated(run: RealtimeRunSummary): RealtimeRunCreatedEvent {
      const event: RealtimeRunCreatedEvent = {
        type: 'run:created',
        sequence: nextSequence(),
        run: cloneRun(run),
      };
      broadcast(event);
      return event;
    },

    getClientCount(): number {
      return clients.size;
    },
  };
}
