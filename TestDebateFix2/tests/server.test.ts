import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../src/server/index.js';
import { resetRunRepository } from '../src/server/db/client.js';

function listen(server: ReturnType<typeof createAppServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Server address unavailable.'));
        return;
      }

      resolve(address.port);
    });
  });
}

test('server serves static index and api health route', async (context) => {
  resetRunRepository();
  const server = createAppServer();
  const port = await listen(server);
  context.after(() => server.close());

  const [indexResponse, healthResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/api/health`),
  ]);

  assert.equal(indexResponse.status, 200);
  assert.match(await indexResponse.text(), /<canvas/i);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok' });
});

test('server persists run summaries through api routes', async (context) => {
  resetRunRepository();
  const server = createAppServer();
  const port = await listen(server);
  context.after(() => server.close());

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:12.345Z',
      survivalTimeMs: 12345,
      hazardCount: 8,
      difficultyPeak: 2.6,
    }),
  });

  assert.equal(createResponse.status, 201);

  const [runsResponse, snapshotResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/runs`),
    fetch(`http://127.0.0.1:${port}/api/game`),
  ]);

  assert.equal(runsResponse.status, 200);
  assert.equal(snapshotResponse.status, 200);

  const runsPayload = (await runsResponse.json()) as {
    runs: Array<{ id: string; survivalTimeMs: number }>;
  };
  const snapshotPayload = (await snapshotResponse.json()) as {
    stats: { totalRuns: number; bestSurvivalTimeMs: number; latestRun: { id: string } | null };
  };

  assert.equal(runsPayload.runs.length, 1);
  assert.equal(runsPayload.runs[0]?.id, 'run-1');
  assert.equal(runsPayload.runs[0]?.survivalTimeMs, 12345);
  assert.equal(snapshotPayload.stats.totalRuns, 1);
  assert.equal(snapshotPayload.stats.bestSurvivalTimeMs, 12345);
  assert.equal(snapshotPayload.stats.latestRun?.id, 'run-1');
});

test('server returns validation errors for invalid run payloads', async (context) => {
  resetRunRepository();
  const server = createAppServer();
  const port = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startedAt: 'invalid',
      endedAt: '2026-01-01T00:00:12.345Z',
      survivalTimeMs: -1,
      hazardCount: 8,
      difficultyPeak: 0.5,
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'startedAt and endedAt must be valid ISO date strings.',
  });
});
