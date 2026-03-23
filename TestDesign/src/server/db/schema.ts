export interface ScoreRecord {
  readonly id: string;
  readonly playerName: string;
  readonly score: number;
  readonly level: number;
  readonly createdAt: string;
}

export interface ScoreInput {
  readonly playerName: string;
  readonly score: number;
  readonly level: number;
}

export class ValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

const NAME_MAX_LENGTH = 32;
const NAME_PATTERN = /^[a-zA-Z0-9\s]+$/;
const MAX_SCORE = 1_000_000;

export function validateScoreInput(data: unknown): ScoreInput {
  if (typeof data !== 'object' || data === null) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['playerName'] !== 'string') {
    throw new ValidationError('playerName must be a string');
  }
  const trimmed = obj['playerName'].trim();
  if (trimmed.length === 0) {
    throw new ValidationError('playerName must not be empty');
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw new ValidationError(`playerName must be at most ${NAME_MAX_LENGTH} characters`);
  }
  if (!NAME_PATTERN.test(trimmed)) {
    throw new ValidationError('playerName must contain only alphanumeric characters and spaces');
  }

  if (typeof obj['score'] !== 'number' || !Number.isInteger(obj['score'])) {
    throw new ValidationError('score must be an integer');
  }
  if (obj['score'] < 0) {
    throw new ValidationError('score must be non-negative');
  }
  if (obj['score'] > MAX_SCORE) {
    throw new ValidationError(`score must be at most ${MAX_SCORE}`);
  }

  const level = typeof obj['level'] === 'number' && Number.isInteger(obj['level']) && obj['level'] > 0
    ? obj['level']
    : 1;

  return { playerName: trimmed, score: obj['score'], level };
}
