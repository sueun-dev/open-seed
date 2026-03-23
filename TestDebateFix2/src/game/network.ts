import type {
  RealtimeChannel,
  RealtimeClient,
  RealtimeDisconnectedEvent,
  RealtimeEvent,
  RealtimeRunCreatedEvent,
  RealtimeSnapshotEvent,
} from '../server/realtime.js';
import type { GameSnapshot } from '../server/service.js';

export interface RealtimeTransport {
  connect(client: RealtimeClient): () => void;
}

export interface NetworkState {
  readonly connected: boolean;
  readonly lastSequence: number;
  readonly snapshot: GameSnapshot | null;
  readonly receivedRuns: readonly string[];
  readonly disconnectReason: RealtimeDisconnectedEvent['reason'] | null;
}

function cloneSnapshot(snapshot: GameSnapshot): GameSnapshot {
  return {
    status: snapshot.status,
    game: {
      title: snapshot.game.title,
      controls: [...snapshot.game.controls],
      objective: snapshot.game.objective,
    },
    stats: {
      totalRuns: snapshot.stats.totalRuns,
      bestSurvivalTimeMs: snapshot.stats.bestSurvivalTimeMs,
      averageSurvivalTimeMs: snapshot.stats.averageSurvivalTimeMs,
      latestRun: snapshot.stats.latestRun
        ? {
            id: snapshot.stats.latestRun.id,
            startedAt: snapshot.stats.latestRun.startedAt,
            endedAt: snapshot.stats.latestRun.endedAt,
            survivalTimeMs: snapshot.stats.latestRun.survivalTimeMs,
            hazardCount: snapshot.stats.latestRun.hazardCount,
            difficultyPeak: snapshot.stats.latestRun.difficultyPeak,
          }
        : null,
    },
  };
}

function cloneRunEvent(event: RealtimeRunCreatedEvent): RealtimeRunCreatedEvent {
  return {
    type: event.type,
    sequence: event.sequence,
    run: {
      id: event.run.id,
      survivalTimeMs: event.run.survivalTimeMs,
      hazardCount: event.run.hazardCount,
      difficultyPeak: event.run.difficultyPeak,
    },
  };
}

export function createRealtimeTransport(channel: RealtimeChannel): RealtimeTransport {
  return {
    connect(client: RealtimeClient): () => void {
      return channel.subscribe(client);
    },
  };
}

export function createNetworkSync(clientId = 'local-client') {
  let unsubscribe: (() => void) | null = null;
  let state: NetworkState = {
    connected: false,
    lastSequence: 0,
    snapshot: null,
    receivedRuns: [],
    disconnectReason: null,
  };

  function applySnapshot(event: RealtimeSnapshotEvent): void {
    state = {
      ...state,
      connected: true,
      lastSequence: event.sequence,
      snapshot: cloneSnapshot(event.snapshot),
      disconnectReason: null,
    };
  }

  function applyRunCreated(event: RealtimeRunCreatedEvent): void {
    state = {
      ...state,
      connected: true,
      lastSequence: event.sequence,
      receivedRuns: [...state.receivedRuns, event.run.id],
      disconnectReason: null,
    };
  }

  function applyDisconnected(event: RealtimeDisconnectedEvent): void {
    state = {
      ...state,
      connected: false,
      lastSequence: event.sequence,
      disconnectReason: event.reason,
    };
  }

  function receive(event: RealtimeEvent): void {
    if (event.sequence <= state.lastSequence) {
      return;
    }

    if (event.type === 'snapshot') {
      applySnapshot(event);
      return;
    }

    if (event.type === 'run:created') {
      applyRunCreated(cloneRunEvent(event));
      return;
    }

    applyDisconnected(event);
  }

  return {
    connect(transport: RealtimeTransport): void {
      if (unsubscribe) {
        unsubscribe();
      }

      unsubscribe = transport.connect({
        id: clientId,
        push(event) {
          receive(event);
        },
      });
    },
    disconnect(): void {
      if (!unsubscribe) {
        return;
      }

      unsubscribe();
      unsubscribe = null;
      state = {
        ...state,
        connected: false,
      };
    },
    receive,
    getState(): NetworkState {
      return {
        connected: state.connected,
        lastSequence: state.lastSequence,
        snapshot: state.snapshot ? cloneSnapshot(state.snapshot) : null,
        receivedRuns: [...state.receivedRuns],
        disconnectReason: state.disconnectReason,
      };
    },
  };
}
