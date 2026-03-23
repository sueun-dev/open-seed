export const GAME_WIDTH = 800;
export const GAME_HEIGHT = 520;
const PLAYER_SIZE = 28;
const PLAYER_SPEED = 300;
const BASE_OBSTACLE_SPEED = 180;
const MAX_OBSTACLE_SPEED = 420;
const BASE_SPAWN_INTERVAL = 0.9;
const MIN_SPAWN_INTERVAL = 0.28;
const MAX_DELTA = 0.033;

export type InputState = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  restartPressed: boolean;
};

export type Player = {
  x: number;
  y: number;
  size: number;
};

export type Obstacle = {
  x: number;
  y: number;
  size: number;
  speed: number;
};

export type GameState = {
  player: Player;
  obstacles: Obstacle[];
  elapsedTime: number;
  spawnTimer: number;
  gameOver: boolean;
  score: number;
};

export function createInitialState(): GameState {
  return {
    player: {
      x: GAME_WIDTH / 2 - PLAYER_SIZE / 2,
      y: GAME_HEIGHT - PLAYER_SIZE - 32,
      size: PLAYER_SIZE,
    },
    obstacles: [],
    elapsedTime: 0,
    spawnTimer: 0,
    gameOver: false,
    score: 0,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getDifficulty(elapsedTime: number): number {
  return clamp(elapsedTime / 30, 0, 1);
}

export function getSpawnInterval(elapsedTime: number): number {
  const difficulty = getDifficulty(elapsedTime);
  return BASE_SPAWN_INTERVAL - (BASE_SPAWN_INTERVAL - MIN_SPAWN_INTERVAL) * difficulty;
}

export function getObstacleSpeed(elapsedTime: number): number {
  const difficulty = getDifficulty(elapsedTime);
  return BASE_OBSTACLE_SPEED + (MAX_OBSTACLE_SPEED - BASE_OBSTACLE_SPEED) * difficulty;
}

export function intersects(a: Player, b: Obstacle): boolean {
  return (
    a.x < b.x + b.size &&
    a.x + a.size > b.x &&
    a.y < b.y + b.size &&
    a.y + a.size > b.y
  );
}

function randomSize(): number {
  return 18 + Math.random() * 30;
}

function spawnObstacle(elapsedTime: number): Obstacle {
  const size = randomSize();
  const lane = Math.random() * (GAME_WIDTH - size);
  const speedJitter = 0.8 + Math.random() * 0.6;

  return {
    x: lane,
    y: -size,
    size,
    speed: getObstacleSpeed(elapsedTime) * speedJitter,
  };
}

export function stepGame(state: GameState, input: InputState, deltaSeconds: number): GameState {
  const dt = Math.min(deltaSeconds, MAX_DELTA);

  if (state.gameOver) {
    if (input.restartPressed) {
      return createInitialState();
    }
    return state;
  }

  const horizontal = Number(input.right) - Number(input.left);
  const vertical = Number(input.down) - Number(input.up);

  const nextPlayer = {
    ...state.player,
    x: clamp(state.player.x + horizontal * PLAYER_SPEED * dt, 0, GAME_WIDTH - state.player.size),
    y: clamp(state.player.y + vertical * PLAYER_SPEED * dt, 0, GAME_HEIGHT - state.player.size),
  };

  const elapsedTime = state.elapsedTime + dt;
  let spawnTimer = state.spawnTimer + dt;
  const spawnInterval = getSpawnInterval(elapsedTime);
  const obstacles = state.obstacles
    .map((obstacle) => ({
      ...obstacle,
      y: obstacle.y + obstacle.speed * dt,
    }))
    .filter((obstacle) => obstacle.y < GAME_HEIGHT + obstacle.size);

  while (spawnTimer >= spawnInterval) {
    spawnTimer -= spawnInterval;
    obstacles.push(spawnObstacle(elapsedTime));
  }

  const collided = obstacles.some((obstacle) => intersects(nextPlayer, obstacle));

  return {
    player: nextPlayer,
    obstacles,
    elapsedTime,
    spawnTimer,
    gameOver: collided,
    score: Math.floor(elapsedTime * 10),
  };
}
