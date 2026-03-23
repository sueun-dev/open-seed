export enum Direction {
  Up = 'UP',
  Down = 'DOWN',
  Left = 'LEFT',
  Right = 'RIGHT',
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export enum GamePhase {
  Ready = 'READY',
  Playing = 'PLAYING',
  Paused = 'PAUSED',
  GameOver = 'GAME_OVER',
}

export interface GameState {
  readonly snake: readonly Point[];
  readonly food: Point;
  readonly direction: Direction;
  readonly nextDirection: Direction;
  readonly phase: GamePhase;
  readonly score: number;
  readonly level: number;
  readonly foodEaten: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
}

export const DIRECTION_VECTORS: Record<Direction, Point> = {
  [Direction.Up]: { x: 0, y: -1 },
  [Direction.Down]: { x: 0, y: 1 },
  [Direction.Left]: { x: -1, y: 0 },
  [Direction.Right]: { x: 1, y: 0 },
};

export const OPPOSITE: Record<Direction, Direction> = {
  [Direction.Up]: Direction.Down,
  [Direction.Down]: Direction.Up,
  [Direction.Left]: Direction.Right,
  [Direction.Right]: Direction.Left,
};

export const BASE_INTERVAL_MS = 150;
export const MIN_INTERVAL_MS = 60;
export const INTERVAL_DECREASE_PER_LEVEL = 10;
export const FOODS_PER_LEVEL = 5;
export const POINTS_PER_FOOD = 10;

export function getInterval(level: number): number {
  return Math.max(MIN_INTERVAL_MS, BASE_INTERVAL_MS - (level - 1) * INTERVAL_DECREASE_PER_LEVEL);
}

export function createInitialState(gridWidth = 20, gridHeight = 20): GameState {
  const centerX = Math.floor(gridWidth / 2);
  const centerY = Math.floor(gridHeight / 2);
  const snake: Point[] = [
    { x: centerX, y: centerY },
    { x: centerX - 1, y: centerY },
    { x: centerX - 2, y: centerY },
  ];
  const state: GameState = {
    snake,
    food: { x: 0, y: 0 },
    direction: Direction.Right,
    nextDirection: Direction.Right,
    phase: GamePhase.Ready,
    score: 0,
    level: 1,
    foodEaten: 0,
    gridWidth,
    gridHeight,
  };
  return { ...state, food: spawnFood(state) };
}

export function spawnFood(state: GameState): Point {
  const occupied = new Set(state.snake.map((p) => `${p.x},${p.y}`));
  const empty: Point[] = [];
  for (let x = 0; x < state.gridWidth; x++) {
    for (let y = 0; y < state.gridHeight; y++) {
      if (!occupied.has(`${x},${y}`)) {
        empty.push({ x, y });
      }
    }
  }
  if (empty.length === 0) {
    return { x: 0, y: 0 };
  }
  return empty[Math.floor(Math.random() * empty.length)];
}

export function changeDirection(state: GameState, dir: Direction): GameState {
  if (dir === OPPOSITE[state.direction]) {
    return state;
  }
  return { ...state, nextDirection: dir };
}

export interface TickResult {
  readonly state: GameState;
  readonly ate: boolean;
  readonly died: boolean;
  readonly leveledUp: boolean;
}

export function tick(state: GameState): TickResult {
  if (state.phase !== GamePhase.Playing) {
    return { state, ate: false, died: false, leveledUp: false };
  }

  const direction = state.nextDirection;
  const head = state.snake[0];
  const vec = DIRECTION_VECTORS[direction];
  const newHead: Point = {
    x: head.x + vec.x,
    y: head.y + vec.y,
  };

  // Wall collision
  if (
    newHead.x < 0 ||
    newHead.x >= state.gridWidth ||
    newHead.y < 0 ||
    newHead.y >= state.gridHeight
  ) {
    return {
      state: { ...state, phase: GamePhase.GameOver, direction },
      ate: false,
      died: true,
      leveledUp: false,
    };
  }

  // Self collision (check against body excluding tail since it will move)
  const ate = newHead.x === state.food.x && newHead.y === state.food.y;
  const body = ate ? state.snake : state.snake.slice(0, -1);
  if (body.some((p) => p.x === newHead.x && p.y === newHead.y)) {
    return {
      state: { ...state, phase: GamePhase.GameOver, direction },
      ate: false,
      died: true,
      leveledUp: false,
    };
  }

  const newSnake = [newHead, ...body];
  let newScore = state.score;
  let newFoodEaten = state.foodEaten;
  let newLevel = state.level;
  let newFood = state.food;
  let leveledUp = false;

  if (ate) {
    newScore += POINTS_PER_FOOD * state.level;
    newFoodEaten += 1;
    if (newFoodEaten >= FOODS_PER_LEVEL) {
      newLevel += 1;
      newFoodEaten = 0;
      leveledUp = true;
    }
    const tempState: GameState = {
      ...state,
      snake: newSnake,
      direction,
      score: newScore,
      foodEaten: newFoodEaten,
      level: newLevel,
    };
    newFood = spawnFood(tempState);
  }

  return {
    state: {
      ...state,
      snake: newSnake,
      food: newFood,
      direction,
      nextDirection: direction,
      score: newScore,
      level: newLevel,
      foodEaten: newFoodEaten,
    },
    ate,
    died: false,
    leveledUp,
  };
}
