import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkSync, createRealtimeTransport } from '../src/game/network.js';
import {
  createRealtimeChannel,
  type RealtimeEvent,
  type RealtimeRunSummary,
} from '../src/server/realtime.js';
import { getGameSnapshot } from '../src/server/service.js';
import { resetRunRepository } from '../src/server/db/client.js';

function createRun(runId: string): RealtimeRunSummary {
  return {
    id: runId,
    survivalTimeMs: 12345,
    hazardCount: 8,
    difficultyPeak: 2.6,
  };
}

test('realtime channel sends deterministic snapshot on subscribe and deep clones payloads', () => {
  resetRunRepository();
  const snapshot = getGameSnapshot();
  const channel = createRealtimeChannel(snapshot);
  const events: RealtimeEvent[] = [];

  const unsubscribe = channel.subscribe({
    id: 'observer',
    push(event) {
      events.push(event);
    },
  });

  assert.equal(channel.getClientCount(), 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'snapshot');
  assert.equal(events[0]?.sequence, 1);

  if (events[0]?.type !== 'snapshot') {
    throw new Error('Expected snapshot event.');
  }

  const mutatedSnapshot = {
    ...events[0].snapshot,
    game: {
      ...events[0].snapshot.game,
      title: 'Mutated',
    },
  };
  events[0] = {
    ...events[0],
    snapshot: mutatedSnapshot,
  };

  const replay = channel.publishSnapshot(snapshot);

  assert.equal(replay.sequence, 2);
  assert.equal(replay.snapshot.game.title, 'Shape Survivor');

  unsubscribe();
  assert.equal(channel.getClientCount(), 0);
});

test('network sync ignores stale events and tracks ordered run notifications', () => {
  resetRunRepository();
  const channel = createRealtimeChannel(getGameSnapshot());
  const transport = createRealtimeTransport(channel);
  const network = createNetworkSync('client-a');

  network.connect(transport);
  const initial = network.getState();
  assert.equal(initial.connected, true);
  assert.equal(initial.lastSequence, 1);
  assert.ok(initial.snapshot);
  assert.deepEqual(initial.receivedRuns, []);

  const runEvent = channel.publishRunCreated(createRun('run-1'));
  const stateAfterRun = network.getState();
  assert.equal(runEvent.sequence, 2);
  assert.equal(stateAfterRun.lastSequence, 2);
  assert.deepEqual(stateAfterRun.receivedRuns, ['run-1']);

  const stale = {
    type: 'run:created',
    sequence: 2,
    run: createRun('run-stale'),
  } as const;
  network.receive(stale);
  assert.deepEqual(network.getState().receivedRuns, ['run-1']);

  network.receive({
    type: 'run:created',
    sequence: 3,
    run: createRun('run-2'),
  });
  assert.deepEqual(network.getState().receivedRuns, ['run-1', 'run-2']);
});

test('disconnect closes transport, updates reason, and blocks future events', () => {
  resetRunRepository();
  const channel = createRealtimeChannel(getGameSnapshot());
  const transport = createRealtimeTransport(channel);
  const network = createNetworkSync('client-b');

  network.connect(transport);
  assert.equal(channel.getClientCount(), 1);

  network.disconnect();
  const disconnected = network.getState();
  assert.equal(channel.getClientCount(), 0);
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.disconnectReason, 'closed');

  const nextEvent = channel.publishRunCreated(createRun('run-after-close'));
  assert.equal(nextEvent.sequence, 3);
  assert.deepEqual(network.getState().receivedRuns, []);
});
