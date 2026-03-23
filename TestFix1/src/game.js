/**
 * Snake Game — core logic (no DOM dependency)
 * Exports: SnakeGame class via window or module.exports
 */
(function (exports) {
  'use strict';

  var DIRECTIONS = {
    up:    { x:  0, y: -1 },
    down:  { x:  0, y:  1 },
    left:  { x: -1, y:  0 },
    right: { x:  1, y:  0 }
  };

  var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  function SnakeGame(cols, rows) {
    this.cols = cols || 20;
    this.rows = rows || 20;
    this.reset();
  }

  SnakeGame.prototype.reset = function () {
    var cx = Math.floor(this.cols / 2);
    var cy = Math.floor(this.rows / 2);
    this.snake = [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy }
    ];
    this.direction = 'right';
    this.nextDirection = 'right';
    this.food = null;
    this.score = 0;
    this.gameOver = false;
    this.started = false;
    this._placeFood();
  };

  SnakeGame.prototype._placeFood = function () {
    var occupied = {};
    for (var i = 0; i < this.snake.length; i++) {
      occupied[this.snake[i].x + ',' + this.snake[i].y] = true;
    }
    var free = [];
    for (var x = 0; x < this.cols; x++) {
      for (var y = 0; y < this.rows; y++) {
        if (!occupied[x + ',' + y]) free.push({ x: x, y: y });
      }
    }
    if (free.length === 0) {
      this.gameOver = true;
      return;
    }
    this.food = free[Math.floor(Math.random() * free.length)];
  };

  SnakeGame.prototype.setDirection = function (dir) {
    if (DIRECTIONS[dir] && dir !== OPPOSITE[this.direction]) {
      this.nextDirection = dir;
    }
  };

  SnakeGame.prototype.tick = function () {
    if (this.gameOver) return false;

    this.direction = this.nextDirection;
    var d = DIRECTIONS[this.direction];
    var head = this.snake[0];
    var newHead = { x: head.x + d.x, y: head.y + d.y };

    // Wall collision
    if (newHead.x < 0 || newHead.x >= this.cols || newHead.y < 0 || newHead.y >= this.rows) {
      this.gameOver = true;
      return false;
    }

    // Self collision
    for (var i = 0; i < this.snake.length; i++) {
      if (this.snake[i].x === newHead.x && this.snake[i].y === newHead.y) {
        this.gameOver = true;
        return false;
      }
    }

    this.snake.unshift(newHead);

    // Eat food
    if (this.food && newHead.x === this.food.x && newHead.y === this.food.y) {
      this.score += 10;
      this._placeFood();
    } else {
      this.snake.pop();
    }

    return true;
  };

  SnakeGame.DIRECTIONS = DIRECTIONS;
  SnakeGame.OPPOSITE = OPPOSITE;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SnakeGame;
  } else {
    exports.SnakeGame = SnakeGame;
  }
})(typeof window !== 'undefined' ? window : this);
