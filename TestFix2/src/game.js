/**
 * Snake game core logic — pure, no DOM dependency.
 */

export const DIRECTIONS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

export function createInitialState(cols, rows) {
  const cx = Math.floor(cols / 2);
  const cy = Math.floor(rows / 2);
  const snake = [
    { x: cx, y: cy },
    { x: cx - 1, y: cy },
    { x: cx - 2, y: cy },
  ];
  const state = {
    cols,
    rows,
    snake,
    direction: DIRECTIONS.RIGHT,
    nextDirection: DIRECTIONS.RIGHT,
    food: null,
    score: 0,
    gameOver: false,
    running: false,
  };
  state.food = spawnFood(state);
  return state;
}

export function spawnFood(state) {
  const occupied = new Set(state.snake.map((s) => `${s.x},${s.y}`));
  const free = [];
  for (let x = 0; x < state.cols; x++) {
    for (let y = 0; y < state.rows; y++) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

export function changeDirection(state, newDir) {
  const cur = state.direction;
  if (newDir.x + cur.x === 0 && newDir.y + cur.y === 0) return;
  state.nextDirection = newDir;
}

export function tick(state) {
  if (state.gameOver || !state.running) return state;

  state.direction = state.nextDirection;
  const head = state.snake[0];
  const newHead = {
    x: head.x + state.direction.x,
    y: head.y + state.direction.y,
  };

  if (
    newHead.x < 0 ||
    newHead.x >= state.cols ||
    newHead.y < 0 ||
    newHead.y >= state.rows
  ) {
    state.gameOver = true;
    state.running = false;
    return state;
  }

  if (state.snake.some((s) => s.x === newHead.x && s.y === newHead.y)) {
    state.gameOver = true;
    state.running = false;
    return state;
  }

  state.snake.unshift(newHead);

  if (state.food && newHead.x === state.food.x && newHead.y === state.food.y) {
    state.score += 10;
    state.food = spawnFood(state);
  } else {
    state.snake.pop();
  }

  return state;
}

export function isOpposite(a, b) {
  return a.x + b.x === 0 && a.y + b.y === 0;
}
