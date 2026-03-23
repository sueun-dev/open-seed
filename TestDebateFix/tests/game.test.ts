import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  getObstacleSpeed,
  getSpawnInterval,
  stepGame,
} from '../src/game';

describe('game difficulty', () => {
  it('reduces spawn interval over time', () => {
    expect(getSpawnInterval(0)).toBeGreaterThan(getSpawnInterval(30));
  });

  it('increases obstacle speed over time', () => {
    expect(getObstacleSpeed(30)).toBeGreaterThan(getObstacleSpeed(0));
  });
});

describe('game state', () => {
  it('restarts from game over when restart is pressed', () => {
    const state = {
      ...createInitialState(),
      gameOver: true,
      elapsedTime: 5,
      score: 50,
    };

    const next = stepGame(state, {
      left: false,
      right: false,
      up: false,
      down: false,
      restartPressed: true,
    }, 0.016);

    expect(next.gameOver).toBe(false);
    expect(next.elapsedTime).toBe(0);
    expect(next.score).toBe(0);
  });
});
