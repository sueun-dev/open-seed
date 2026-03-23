import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GAME_CONFIG,
  createInitialGameState,
  createInitialPlayer,
  filterVisibleHazards,
  getDifficulty,
  hasCollision,
  resetGameState,
  updateHazards,
  updatePlayerPosition,
} from '../src/game/state.js';

test('shared state normalizes diagonal movement speed', () => {
  const player = createInitialPlayer();
  const nextPlayer = updatePlayerPosition(
    player,
    {
      up: true,
      down: false,
      left: false,
      right: true,
    },
    1,
  );

  const dx = nextPlayer.x - player.x;
  const dy = player.y - nextPlayer.y;
  const distance = Math.hypot(dx, dy);

  assert.ok(Math.abs(distance - player.speed) < 0.001);
});

test('shared state clamps player within playfield bounds', () => {
  const config = {
    ...DEFAULT_GAME_CONFIG,
    width: 100,
    height: 100,
    playerSize: 20,
    playerSpeed: 400,
  };
  const player = createInitialPlayer(config);

  const nextPlayer = updatePlayerPosition(
    player,
    {
      up: true,
      down: false,
      left: true,
      right: false,
    },
    1,
    config,
  );

  assert.equal(nextPlayer.x, 10);
  assert.equal(nextPlayer.y, 10);
});

test('shared state difficulty is capped at configured maximum', () => {
  assert.equal(getDifficulty(999, DEFAULT_GAME_CONFIG), DEFAULT_GAME_CONFIG.maxDifficulty);
});

test('shared state filters hazards outside the visible margin', () => {
  const hazards = filterVisibleHazards(
    [
      { x: 100, y: 100, radius: 10, velocity: { x: 0, y: 0 } },
      { x: -100, y: 100, radius: 10, velocity: { x: 0, y: 0 } },
    ],
    DEFAULT_GAME_CONFIG,
  );

  assert.equal(hazards.length, 1);
  assert.equal(hazards[0]?.x, 100);
});

test('shared state advances hazard positions using velocity and delta', () => {
  const moved = updateHazards(
    [
      {
        x: 10,
        y: 20,
        radius: 12,
        velocity: { x: 30, y: -10 },
      },
    ],
    0.5,
  );

  assert.deepEqual(moved, [
    {
      x: 25,
      y: 15,
      radius: 12,
      velocity: { x: 30, y: -10 },
    },
  ]);
});

test('shared state detects collisions between player square and hazard circle', () => {
  const player = createInitialPlayer({
    ...DEFAULT_GAME_CONFIG,
    width: 200,
    height: 200,
    playerSize: 20,
  });

  assert.equal(
    hasCollision(
      player,
      {
        x: player.x + 5,
        y: player.y,
        radius: 8,
        velocity: { x: 0, y: 0 },
      },
    ),
    true,
  );

  assert.equal(
    hasCollision(
      player,
      {
        x: player.x + 100,
        y: player.y + 100,
        radius: 8,
        velocity: { x: 0, y: 0 },
      },
    ),
    false,
  );
});

test('shared state reset preserves best time and clears transient state', () => {
  const state = createInitialGameState();
  state.bestTime = 12.5;
  state.elapsedTime = 8;
  state.spawnAccumulator = 0.4;
  state.isGameOver = true;
  state.hazards.push({ x: 10, y: 20, radius: 10, velocity: { x: 1, y: 1 } });
  state.input.left = true;

  const reset = resetGameState(state);

  assert.equal(reset.bestTime, 12.5);
  assert.equal(reset.elapsedTime, 0);
  assert.equal(reset.spawnAccumulator, 0);
  assert.equal(reset.isGameOver, false);
  assert.deepEqual(reset.hazards, []);
  assert.deepEqual(reset.input, { up: false, down: false, left: false, right: false });
});
