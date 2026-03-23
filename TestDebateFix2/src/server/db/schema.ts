export interface RunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly survivalTimeMs: number;
  readonly hazardCount: number;
  readonly difficultyPeak: number;
}

export interface RunSummary {
  readonly totalRuns: number;
  readonly bestSurvivalTimeMs: number;
  readonly averageSurvivalTimeMs: number;
  readonly latestRun: RunRecord | null;
}

export interface CreateRunRecordInput {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly survivalTimeMs: number;
  readonly hazardCount: number;
  readonly difficultyPeak: number;
}

export function createRunRecord(
  input: CreateRunRecordInput,
  sequence: number,
): RunRecord {
  return {
    id: `run-${sequence}`,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    survivalTimeMs: Math.max(0, Math.round(input.survivalTimeMs)),
    hazardCount: Math.max(0, Math.round(input.hazardCount)),
    difficultyPeak: Math.max(1, Number(input.difficultyPeak.toFixed(2))),
  };
}

export function summarizeRuns(records: readonly RunRecord[]): RunSummary {
  if (records.length === 0) {
    return {
      totalRuns: 0,
      bestSurvivalTimeMs: 0,
      averageSurvivalTimeMs: 0,
      latestRun: null,
    };
  }

  const totalSurvival = records.reduce((sum, record) => sum + record.survivalTimeMs, 0);
  const bestSurvivalTimeMs = records.reduce(
    (best, record) => Math.max(best, record.survivalTimeMs),
    0,
  );

  return {
    totalRuns: records.length,
    bestSurvivalTimeMs,
    averageSurvivalTimeMs: Math.round(totalSurvival / records.length),
    latestRun: records[records.length - 1],
  };
}
