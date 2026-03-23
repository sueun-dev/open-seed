import { getRunRepository } from './db/client.js';
import type { CreateRunRecordInput, RunRecord, RunSummary } from './db/schema.js';

export interface CreateRunRequest {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly survivalTimeMs: number;
  readonly hazardCount: number;
  readonly difficultyPeak: number;
}

export interface GameSnapshot {
  readonly status: 'ready';
  readonly game: {
    readonly title: string;
    readonly controls: readonly string[];
    readonly objective: string;
  };
  readonly stats: RunSummary;
}

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function createRun(request: CreateRunRequest): RunRecord {
  if (!isValidIsoDate(request.startedAt) || !isValidIsoDate(request.endedAt)) {
    throw new Error('startedAt and endedAt must be valid ISO date strings.');
  }

  if (request.survivalTimeMs < 0) {
    throw new Error('survivalTimeMs must be zero or greater.');
  }

  if (request.hazardCount < 0) {
    throw new Error('hazardCount must be zero or greater.');
  }

  if (request.difficultyPeak < 1) {
    throw new Error('difficultyPeak must be at least 1.');
  }

  const input: CreateRunRecordInput = {
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    survivalTimeMs: request.survivalTimeMs,
    hazardCount: request.hazardCount,
    difficultyPeak: request.difficultyPeak,
  };

  return getRunRepository().createRun(input);
}

export function listRuns(): readonly RunRecord[] {
  return getRunRepository().listRuns();
}

export function getGameSnapshot(): GameSnapshot {
  return {
    status: 'ready',
    game: {
      title: 'Shape Survivor',
      controls: ['WASD', 'Arrow Keys', 'Enter', 'Space'],
      objective: 'Avoid incoming hazards for as long as possible.',
    },
    stats: getRunRepository().getSummary(),
  };
}
