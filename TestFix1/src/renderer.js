/**
 * Snake Game — Canvas renderer
 */
(function (exports) {
  'use strict';

  function Renderer(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.cellW = canvas.width / game.cols;
    this.cellH = canvas.height / game.rows;
  }

  Renderer.prototype.draw = function () {
    var ctx = this.ctx;
    var cw = this.cellW;
    var ch = this.cellH;
    var game = this.game;

    // Clear
    ctx.fillStyle = '#16213e';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Grid lines (subtle)
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    for (var x = 0; x <= game.cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cw, 0);
      ctx.lineTo(x * cw, this.canvas.height);
      ctx.stroke();
    }
    for (var y = 0; y <= game.rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * ch);
      ctx.lineTo(this.canvas.width, y * ch);
      ctx.stroke();
    }

    // Food
    if (game.food) {
      ctx.fillStyle = '#e94560';
      ctx.beginPath();
      ctx.arc(
        game.food.x * cw + cw / 2,
        game.food.y * ch + ch / 2,
        Math.min(cw, ch) / 2.5,
        0, Math.PI * 2
      );
      ctx.fill();
    }

    // Snake
    for (var i = 0; i < game.snake.length; i++) {
      var seg = game.snake[i];
      var isHead = i === 0;
      ctx.fillStyle = isHead ? '#00d2ff' : '#0f3460';
      var pad = 1;
      ctx.fillRect(seg.x * cw + pad, seg.y * ch + pad, cw - pad * 2, ch - pad * 2);
      if (isHead) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(seg.x * cw + cw / 2, seg.y * ch + ch / 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Renderer;
  } else {
    exports.Renderer = Renderer;
  }
})(typeof window !== 'undefined' ? window : this);
