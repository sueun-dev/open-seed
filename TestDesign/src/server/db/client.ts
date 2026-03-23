import { ScoreRecord, ScoreInput } from './schema.js';

const MAX_ENTRIES = 100;

let store: ScoreRecord[] = [];
let nextId = 1;

export function insertScore(input: ScoreInput): ScoreRecord {
  const record: ScoreRecord = {
    id: String(nextId++),
    playerName: input.playerName,
    score: input.score,
    level: input.level,
    createdAt: new Date().toISOString(),
  };

  // Insert in sorted position (descending by score, ascending by createdAt for ties)
  let inserted = false;
  for (let i = 0; i < store.length; i++) {
    if (
      record.score > store[i].score ||
      (record.score === store[i].score && record.createdAt < store[i].createdAt)
    ) {
      store.splice(i, 0, record);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    if (store.length >= MAX_ENTRIES) {
      // New score is lower than all existing — don't insert
      nextId--; // reclaim id
      return record; // return record but don't persist
    }
    store.push(record);
  }

  // Enforce cap
  if (store.length > MAX_ENTRIES) {
    store = store.slice(0, MAX_ENTRIES);
  }

  return record;
}

export function getTopScores(limit: number): readonly ScoreRecord[] {
  const clamped = Math.max(1, Math.min(100, limit));
  return store.slice(0, clamped);
}

export function getScoreCount(): number {
  return store.length;
}

export function clearScores(): void {
  store = [];
  nextId = 1;
}

export function findRank(score: number): number {
  let rank = 1;
  for (const entry of store) {
    if (entry.score > score) {
      rank++;
    } else {
      break;
    }
  }
  return rank;
}
