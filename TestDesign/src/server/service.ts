import { ScoreInput, validateScoreInput, ValidationError } from './db/schema.js';
import { insertScore, getTopScores, getScoreCount, clearScores, findRank } from './db/client.js';
import type { ScoreRecord } from './db/schema.js';

export { ValidationError };

export interface SubmitResult {
  readonly rank: number;
  readonly entry: ScoreRecord;
}

export interface LeaderboardResult {
  readonly scores: readonly ScoreRecord[];
  readonly count: number;
}

export function submitScore(data: unknown): SubmitResult {
  const input: ScoreInput = validateScoreInput(data);
  const entry = insertScore(input);
  const rank = findRank(entry.score);
  return { rank, entry };
}

export function fetchTopScores(limit: number): LeaderboardResult {
  const scores = getTopScores(limit);
  const count = getScoreCount();
  return { scores, count };
}

export function resetScores(): void {
  clearScores();
}
