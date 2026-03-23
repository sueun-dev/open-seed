// Snake Game — Shared Domain Core
// Pure deterministic state module. No I/O, no DOM, no side effects.

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 20;
export const CELL_SIZE = 20;

export enum Direction {
  Up = 'UP',
  Down = 'DOWN',
  Left = 'LEFT',
  Right = 'RIGHT',
}

export interface Point {
  x: number;
  y: number;
}

export interface GameState {
  snake: Point[];
  direction: Direction;
  nextDirection: Direction;
  food: Point;
  score: number;
  level: number;
  isRunning: boolean;
  isGameOver: boolean;
  isPaused: boolean;
  isMuted: boolean;
  tickInterval: number;
}

const OPPOSITE: Record<Direction, Direction> = {
  [Direction.Up]: Direction.Down,
  [Direction.Down]: Direction.Up,
  [Direction.Left]: Direction.Right,
  [Direction.Right]: Direction.Left,
};

const BASE_TICK_MS = 200;
const MIN_TICK_MS = 60;
const TICK_DECREMENT_PER_LEVEL = 20;
const POINTS_PER_FOOD = 10;
const FOOD_PER_LEVEL = 5;

export function levelFromScore(score: number): number {
  return Math.floor(score / (POINTS_PER_FOOD * FOOD_PER_LEVEL)) + 1;
}

export function tickIntervalFromLevel(level: number): number {
  return Math.max(MIN_TICK_MS, BASE_TICK_MS - (level - 1) * TICK_DECREMENT_PER_LEVEL);
}

export function spawnFood(snake: Point[], width: number, height: number): Point {
  const occupied = new Set(snake.map((p) => `${p.x},${p.y}`));
  const free: Point[] = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (!occupied.has(`${x},${y}`)) {
        free.push({ x, y });
      }
    }
  }
  if (free.length === 0) {
    return { x: 0, y: 0 };
  }
  return free[Math.floor(Math.random() * free.length)];
}

export function createInitialState(): GameState {
  const snake: Point[] = [
    { x: 10, y: 10 },
    { x: 9, y: 10 },
    { x: 8, y: 10 },
  ];
  return {
    snake,
    direction: Direction.Right,
    nextDirection: Direction.Right,
    food: spawnFood(snake, GRID_WIDTH, GRID_HEIGHT),
    score: 0,
    level: 1,
    isRunning: false,
    isGameOver: false,
    isPaused: false,
    isMuted: false,
    tickInterval: BASE_TICK_MS,
  };
}

export function changeDirection(state: GameState, newDir: Direction): GameState {
  if (OPPOSITE[newDir] === state.direction) {
    return state;
  }
  return { ...state, nextDirection: newDir };
}

export function moveSnake(state: GameState): Point[] {
  const head = state.snake[0];
  const dir = state.nextDirection;
  let nx = head.x;
  let ny = head.y;

  switch (dir) {
    case Direction.Up:
      ny -= 1;
      break;
    case Direction.Down:
      ny += 1;
      break;
    case Direction.Left:
      nx -= 1;
      break;
    case Direction.Right:
      nx += 1;
      break;
  }

  return [{ x: nx, y: ny }, ...state.snake.slice(0, -1)];
}

export function checkWallCollision(head: Point): boolean {
  return head.x < 0 || head.x >= GRID_WIDTH || head.y < 0 || head.y >= GRID_HEIGHT;
}

export function checkSelfCollision(snake: Point[]): boolean {
  const head = snake[0];
  for (let i = 1; i < snake.length; i++) {
    if (snake[i].x === head.x && snake[i].y === head.y) {
      return true;
    }
  }
  return false;
}

export interface TickResult {
  state: GameState;
  ate: boolean;
  died: boolean;
  leveledUp: boolean;
}

export function tick(state: GameState): TickResult {
  if (!state.isRunning || state.isGameOver || state.isPaused) {
    return { state, ate: false, died: false, leveledUp: false };
  }

  const newSnake = moveSnake(state);
  const head = newSnake[0];

  if (checkWallCollision(head) || checkSelfCollision(newSnake)) {
    return {
      state: { ...state, isRunning: false, isGameOver: true },
      ate: false,
      died: true,
      leveledUp: false,
    };
  }

  const ate = head.x === state.food.x && head.y === state.food.y;
  let snake = newSnake;
  let score = state.score;
  let food = state.food;
  let leveledUp = false;

  if (ate) {
    snake = [head, ...state.snake];
    score += POINTS_PER_FOOD;
    food = spawnFood(snake, GRID_WIDTH, GRID_HEIGHT);
  }

  const prevLevel = state.level;
  const newLevel = levelFromScore(score);
  if (newLevel > prevLevel) {
    leveledUp = true;
  }

  const tickInterval = tickIntervalFromLevel(newLevel);

  return {
    state: {
      ...state,
      snake,
      direction: state.nextDirection,
      food,
      score,
      level: newLevel,
      tickInterval,
    },
    ate,
    died: false,
    leveledUp,
  };
}

export function startGame(state: GameState): GameState {
  if (state.isGameOver) {
    return { ...createInitialState(), isRunning: true, isMuted: state.isMuted };
  }
  return { ...state, isRunning: true };
}

export function pauseGame(state: GameState): GameState {
  if (!state.isRunning || state.isGameOver) return state;
  return { ...state, isPaused: !state.isPaused };
}

export function toggleMute(state: GameState): GameState {
  return { ...state, isMuted: !state.isMuted };
}
