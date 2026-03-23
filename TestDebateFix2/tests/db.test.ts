import test from 'node:test';
import assert from 'node:assert/strict';
import { getRunRepository, resetRunRepository } from '../src/server/db/client.js';
import { createRunRecord, summarizeRuns } from '../src/server/db/schema.js';

test('schema rounds and clamps persisted run values', () => {
  const record = createRunRecord(
    {
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      survivalTimeMs: -4.7,
      hazardCount: -2.2,
      difficultyPeak: 0.126,
    },
    3,
  );

  assert.deepEqual(record, {
    id: 'run-3',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    survivalTimeMs: 0,
    hazardCount: 0,
    difficultyPeak: 1,
  });
});

test('schema summarizes empty records deterministically', () => {
  assert.deepEqual(summarizeRuns([]), {
    totalRuns: 0,
    bestSurvivalTimeMs: 0,
    averageSurvivalTimeMs: 0,
    latestRun: null,
  });
});

test('in-memory run repository stores records computes summary and resets sequence', () => {
  resetRunRepository();
  const repository = getRunRepository();

  repository.createRun({
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:05.000Z',
    survivalTimeMs: 5000,
    hazardCount: 4,
    difficultyPeak: 1.8,
  });

  repository.createRun({
    startedAt: '2026-01-01T00:01:00.000Z',
    endedAt: '2026-01-01T00:01:09.000Z',
    survivalTimeMs: 9000,
    hazardCount: 7,
    difficultyPeak: 2.4,
  });

  const summary = repository.getSummary();

  assert.equal(repository.listRuns().length, 2);
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.bestSurvivalTimeMs, 9000);
  assert.equal(summary.averageSurvivalTimeMs, 7000);
  assert.equal(summary.latestRun?.id, 'run-2');

  repository.clear();
  assert.deepEqual(repository.listRuns(), []);

  repository.createRun({
    startedAt: '2026-01-01T00:02:00.000Z',
    endedAt: '2026-01-01T00:02:03.000Z',
    survivalTimeMs: 3000,
    hazardCount: 2,
    difficultyPeak: 1.4,
  });

  assert.equal(repository.listRuns()[0]?.id, 'run-1');
});
