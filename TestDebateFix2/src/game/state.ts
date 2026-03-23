export type Vector = {
  x: number;
  y: number;
};

export type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

export type PlayerState = {
  x: number;
  y: number;
  size: number;
  speed: number;
};

export type HazardState = {
  x: number;
  y: number;
  radius: number;
  velocity: Vector;
};

export type GameState = {
  elapsedTime: number;
  bestTime: number;
  spawnAccumulator: number;
  isGameOver: boolean;
  player: PlayerState;
  hazards: HazardState[];
  input: InputState;
};

export type GameConfig = {
  width: number;
  height: number;
  playerSize: number;
  playerSpeed: number;
  baseSpawnRate: number;
  baseHazardSpeed: number;
  maxDifficulty: number;
  safeRadius: number;
};

export const DEFAULT_GAME_CONFIG: GameConfig = {
  width: 900,
  height: 600,
  playerSize: 28,
  playerSpeed: 320,
  baseSpawnRate: 1.1,
  baseHazardSpeed: 190,
  maxDifficulty: 3.8,
  safeRadius: 170,
};

export function createInitialInputState(): InputState {
  return { up: false, down: false, left: false, right: false };
}

export function createInitialPlayer(config: GameConfig = DEFAULT_GAME_CONFIG): PlayerState {
  return {
    x: config.width / 2,
    y: config.height / 2,
    size: config.playerSize,
    speed: config.playerSpeed,
  };
}

export function createInitialGameState(bestTime = 0, config: GameConfig = DEFAULT_GAME_CONFIG): GameState {
  return {
    elapsedTime: 0,
    bestTime,
    spawnAccumulator: 0,
    isGameOver: false,
    player: createInitialPlayer(config),
    hazards: [],
    input: createInitialInputState(),
  };
}

export function resetGameState(previous: GameState, config: GameConfig = DEFAULT_GAME_CONFIG): GameState {
  return createInitialGameState(previous.bestTime, config);
}

export function getDifficulty(elapsedTime: number, config: GameConfig = DEFAULT_GAME_CONFIG): number {
  return Math.min(config.maxDifficulty, 1 + elapsedTime / 18);
}

export function clampPlayerToBounds(player: PlayerState, config: GameConfig = DEFAULT_GAME_CONFIG): PlayerState {
  const halfSize = player.size / 2;
  return {
    ...player,
    x: Math.min(config.width - halfSize, Math.max(halfSize, player.x)),
    y: Math.min(config.height - halfSize, Math.max(halfSize, player.y)),
  };
}

export function updatePlayerPosition(
  player: PlayerState,
  input: InputState,
  deltaSeconds: number,
  config: GameConfig = DEFAULT_GAME_CONFIG,
): PlayerState {
  const horizontal = Number(input.right) - Number(input.left);
  const vertical = Number(input.down) - Number(input.up);
  const magnitude = Math.hypot(horizontal, vertical) || 1;

  return clampPlayerToBounds(
    {
      ...player,
      x: player.x + (horizontal / magnitude) * player.speed * deltaSeconds,
      y: player.y + (vertical / magnitude) * player.speed * deltaSeconds,
    },
    config,
  );
}

export function updateHazards(hazards: HazardState[], deltaSeconds: number): HazardState[] {
  return hazards.map((hazard) => ({
    ...hazard,
    x: hazard.x + hazard.velocity.x * deltaSeconds,
    y: hazard.y + hazard.velocity.y * deltaSeconds,
  }));
}

export function filterVisibleHazards(hazards: HazardState[], config: GameConfig = DEFAULT_GAME_CONFIG): HazardState[] {
  return hazards.filter((hazard) => {
    const margin = hazard.radius + 24;
    return (
      hazard.x >= -margin &&
      hazard.x <= config.width + margin &&
      hazard.y >= -margin &&
      hazard.y <= config.height + margin
    );
  });
}

export function hasCollision(player: PlayerState, hazard: HazardState): boolean {
  const halfSize = player.size / 2;
  const nearestX = Math.max(player.x - halfSize, Math.min(hazard.x, player.x + halfSize));
  const nearestY = Math.max(player.y - halfSize, Math.min(hazard.y, player.y + halfSize));
  const distanceX = hazard.x - nearestX;
  const distanceY = hazard.y - nearestY;
  return distanceX * distanceX + distanceY * distanceY <= hazard.radius * hazard.radius;
}

export function getBestTime(previousBestTime: number, elapsedTime: number): number {
  return Math.max(previousBestTime, elapsedTime);
}
