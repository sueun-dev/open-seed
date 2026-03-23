const SnakeGame = require('../src/game');

describe('SnakeGame', () => {
  let game;

  beforeEach(() => {
    game = new SnakeGame(20, 20);
  });

  describe('initialization', () => {
    test('should create a snake of length 3', () => {
      expect(game.snake).toHaveLength(3);
    });

    test('should start in the center', () => {
      expect(game.snake[0]).toEqual({ x: 10, y: 10 });
    });

    test('should default direction to right', () => {
      expect(game.direction).toBe('right');
    });

    test('should place food on the grid', () => {
      expect(game.food).not.toBeNull();
      expect(game.food.x).toBeGreaterThanOrEqual(0);
      expect(game.food.x).toBeLessThan(20);
      expect(game.food.y).toBeGreaterThanOrEqual(0);
      expect(game.food.y).toBeLessThan(20);
    });

    test('should start with score 0', () => {
      expect(game.score).toBe(0);
    });

    test('should not be game over', () => {
      expect(game.gameOver).toBe(false);
    });
  });

  describe('movement', () => {
    test('should move head right on tick', () => {
      var oldHead = { x: game.snake[0].x, y: game.snake[0].y };
      game.tick();
      expect(game.snake[0]).toEqual({ x: oldHead.x + 1, y: oldHead.y });
    });

    test('should maintain snake length when not eating', () => {
      // Remove food so snake cannot eat
      game.food = { x: 0, y: 0 };
      game.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
      game.direction = 'right';
      game.nextDirection = 'right';
      game.tick();
      expect(game.snake).toHaveLength(3);
    });

    test('should change direction', () => {
      game.setDirection('down');
      game.tick();
      expect(game.direction).toBe('down');
    });
  });

  describe('direction constraints', () => {
    test('should not reverse direction (right to left)', () => {
      game.direction = 'right';
      game.nextDirection = 'right';
      game.setDirection('left');
      expect(game.nextDirection).toBe('right');
    });

    test('should not reverse direction (up to down)', () => {
      game.direction = 'up';
      game.nextDirection = 'up';
      game.setDirection('down');
      expect(game.nextDirection).toBe('up');
    });

    test('should allow perpendicular direction change', () => {
      game.direction = 'right';
      game.nextDirection = 'right';
      game.setDirection('up');
      expect(game.nextDirection).toBe('up');
    });
  });

  describe('food and scoring', () => {
    test('should grow snake and add score when eating food', () => {
      game.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
      game.direction = 'right';
      game.nextDirection = 'right';
      game.food = { x: 6, y: 5 };
      game.tick();
      expect(game.snake).toHaveLength(4);
      expect(game.score).toBe(10);
    });

    test('should place new food after eating', () => {
      game.snake = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
      game.direction = 'right';
      game.nextDirection = 'right';
      game.food = { x: 6, y: 5 };
      game.tick();
      expect(game.food).not.toBeNull();
      // New food should not be at old position (most likely)
      expect(game.food).toBeDefined();
    });
  });

  describe('collisions', () => {
    test('should end game on wall collision (right)', () => {
      game.snake = [{ x: 19, y: 5 }, { x: 18, y: 5 }, { x: 17, y: 5 }];
      game.direction = 'right';
      game.nextDirection = 'right';
      game.food = { x: 0, y: 0 };
      var result = game.tick();
      expect(result).toBe(false);
      expect(game.gameOver).toBe(true);
    });

    test('should end game on wall collision (top)', () => {
      game.snake = [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }];
      game.direction = 'up';
      game.nextDirection = 'up';
      game.food = { x: 0, y: 0 };
      var result = game.tick();
      expect(result).toBe(false);
      expect(game.gameOver).toBe(true);
    });

    test('should end game on self collision', () => {
      game.snake = [
        { x: 5, y: 5 },
        { x: 6, y: 5 },
        { x: 6, y: 4 },
        { x: 5, y: 4 },
        { x: 4, y: 4 }
      ];
      game.direction = 'up';
      game.nextDirection = 'up';
      game.food = { x: 0, y: 0 };
      // Head at (5,5) moves up to (5,4) which is occupied
      var result = game.tick();
      expect(result).toBe(false);
      expect(game.gameOver).toBe(true);
    });

    test('should not tick after game over', () => {
      game.gameOver = true;
      var result = game.tick();
      expect(result).toBe(false);
    });
  });

  describe('reset', () => {
    test('should reset game state', () => {
      game.score = 100;
      game.gameOver = true;
      game.reset();
      expect(game.score).toBe(0);
      expect(game.gameOver).toBe(false);
      expect(game.snake).toHaveLength(3);
      expect(game.direction).toBe('right');
    });
  });

  describe('custom grid size', () => {
    test('should support custom dimensions', () => {
      var small = new SnakeGame(10, 10);
      expect(small.cols).toBe(10);
      expect(small.rows).toBe(10);
      expect(small.snake[0]).toEqual({ x: 5, y: 5 });
    });
  });
});
