import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  tick,
  changeDirection,
  spawnFood,
  DIRECTIONS,
} from '../src/game.js';

describe('createInitialState', () => {
  it('should create state with snake of length 3', () => {
    const state = createInitialState(20, 20);
    expect(state.snake).toHaveLength(3);
  });

  it('should place snake in the center', () => {
    const state = createInitialState(20, 20);
    expect(state.snake[0]).toEqual({ x: 10, y: 10 });
  });

  it('should start with score 0 and not running', () => {
    const state = createInitialState(20, 20);
    expect(state.score).toBe(0);
    expect(state.running).toBe(false);
    expect(state.gameOver).toBe(false);
  });

  it('should spawn food on creation', () => {
    const state = createInitialState(20, 20);
    expect(state.food).not.toBeNull();
    expect(state.food).toHaveProperty('x');
    expect(state.food).toHaveProperty('y');
  });

  it('should set default direction to RIGHT', () => {
    const state = createInitialState(20, 20);
    expect(state.direction).toEqual(DIRECTIONS.RIGHT);
  });
});

describe('changeDirection', () => {
  it('should change direction to UP', () => {
    const state = createInitialState(20, 20);
    changeDirection(state, DIRECTIONS.UP);
    expect(state.nextDirection).toEqual(DIRECTIONS.UP);
  });

  it('should not allow reversing direction', () => {
    const state = createInitialState(20, 20);
    state.direction = DIRECTIONS.RIGHT;
    changeDirection(state, DIRECTIONS.LEFT);
    expect(state.nextDirection).toEqual(DIRECTIONS.RIGHT);
  });

  it('should not allow reversing UP to DOWN', () => {
    const state = createInitialState(20, 20);
    state.direction = DIRECTIONS.UP;
    state.nextDirection = DIRECTIONS.UP;
    changeDirection(state, DIRECTIONS.DOWN);
    expect(state.nextDirection).toEqual(DIRECTIONS.UP);
  });
});

describe('tick', () => {
  it('should not change state if not running', () => {
    const state = createInitialState(20, 20);
    const headBefore = { ...state.snake[0] };
    tick(state);
    expect(state.snake[0]).toEqual(headBefore);
  });

  it('should move snake head in direction when running', () => {
    const state = createInitialState(20, 20);
    state.running = true;
    state.food = { x: 0, y: 0 };
    const headBefore = { ...state.snake[0] };
    tick(state);
    expect(state.snake[0].x).toBe(headBefore.x + 1);
    expect(state.snake[0].y).toBe(headBefore.y);
  });

  it('should keep same length when not eating food', () => {
    const state = createInitialState(20, 20);
    state.running = true;
    state.food = { x: 0, y: 0 };
    const lenBefore = state.snake.length;
    tick(state);
    expect(state.snake.length).toBe(lenBefore);
  });

  it('should grow snake and increase score when eating food', () => {
    const state = createInitialState(20, 20);
    state.running = true;
    const head = state.snake[0];
    state.food = { x: head.x + 1, y: head.y };
    const lenBefore = state.snake.length;
    tick(state);
    expect(state.snake.length).toBe(lenBefore + 1);
    expect(state.score).toBe(10);
  });

  it('should set gameOver when hitting top wall', () => {
    const state = createInitialState(20, 20);
    state.running = true;
    state.snake[0] = { x: 5, y: 0 };
    state.direction = DIRECTIONS.UP;
    state.nextDirection = DIRECTIONS.UP;
    tick(state);
    expect(state.gameOver).toBe(true);
    expect(state.running).toBe(false);
  });

  it('should set gameOver when hitting right wall', () => {
    const state = createInitialState(20, 20);
    state.running = true;
    state.snake[0] = { x: 19, y: 5 };
    state.direction = DIRECTIONS.RIGHT;
    state.nextDirection = DIRECTIONS.RIGHT;
    tick(state);
    expect(state.gameOver).toBe(true);
  });

  it('should set gameOver on self collision', () => {
    const state = createInitialState(20, 20);
    state.running = true;
    state.snake = [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 6 },
      { x: 5, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 5 },
    ];
    state.direction = DIRECTIONS.LEFT;
    state.nextDirection = DIRECTIONS.LEFT;
    tick(state);
    expect(state.gameOver).toBe(true);
  });
});

describe('spawnFood', () => {
  it('should return a position within bounds', () => {
    const state = createInitialState(10, 10);
    const food = spawnFood(state);
    expect(food.x).toBeGreaterThanOrEqual(0);
    expect(food.x).toBeLessThan(10);
    expect(food.y).toBeGreaterThanOrEqual(0);
    expect(food.y).toBeLessThan(10);
  });

  it('should not place food on the snake', () => {
    const state = createInitialState(10, 10);
    const occupied = new Set(state.snake.map((s) => `${s.x},${s.y}`));
    for (let i = 0; i < 50; i++) {
      const food = spawnFood(state);
      expect(occupied.has(`${food.x},${food.y}`)).toBe(false);
    }
  });

  it('should return null when board is full', () => {
    const state = createInitialState(2, 2);
    state.snake = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];
    const food = spawnFood(state);
    expect(food).toBeNull();
  });
});
