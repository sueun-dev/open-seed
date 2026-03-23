/**
 * Snake Game — Main entry point
 */
(function () {
  'use strict';

  var canvas = document.getElementById('game-canvas');
  var overlay = document.getElementById('overlay');
  var overlayMsg = overlay.querySelector('.msg');
  var scoreEl = document.getElementById('score');
  var highScoreEl = document.getElementById('high-score');

  var COLS = 20;
  var ROWS = 20;
  var BASE_INTERVAL = 150; // ms per tick

  var game = new SnakeGame(COLS, ROWS);
  var renderer = new Renderer(canvas, game);
  var tickTimer = null;
  var highScore = parseInt(localStorage.getItem('snake-high') || '0', 10);
  highScoreEl.textContent = highScore;

  function showOverlay(html) {
    overlayMsg.innerHTML = html;
    overlay.classList.add('active');
    overlay.style.width = canvas.offsetWidth + 'px';
    overlay.style.height = canvas.offsetHeight + 'px';
  }

  function hideOverlay() {
    overlay.classList.remove('active');
  }

  function updateScore() {
    scoreEl.textContent = game.score;
    if (game.score > highScore) {
      highScore = game.score;
      highScoreEl.textContent = highScore;
      localStorage.setItem('snake-high', String(highScore));
    }
  }

  function speed() {
    // Speed up as score increases
    return Math.max(60, BASE_INTERVAL - Math.floor(game.score / 50) * 10);
  }

  function gameLoop() {
    var alive = game.tick();
    updateScore();
    renderer.draw();

    if (!alive) {
      clearInterval(tickTimer);
      tickTimer = null;
      showOverlay('💀 게임 오버!<br>점수: ' + game.score + '<br><kbd>Space</kbd> 또는 탭하여 재시작');
      return;
    }

    // Adjust speed dynamically
    clearInterval(tickTimer);
    tickTimer = setInterval(gameLoop, speed());
  }

  function startGame() {
    if (tickTimer) {
      clearInterval(tickTimer);
    }
    game.reset();
    updateScore();
    hideOverlay();
    renderer.draw();
    game.started = true;
    tickTimer = setInterval(gameLoop, speed());
  }

  new InputHandler(game, { onStart: startGame });

  // Initial render
  renderer.draw();
  showOverlay('🐍 스네이크 게임<br><kbd>Space</kbd> 또는 탭하여 시작');
})();
