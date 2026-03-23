import { createInitialState, tick } from './game.js';
import { render } from './renderer.js';
import { setupKeyboard, setupTouch } from './input.js';

const COLS = 20;
const ROWS = 20;
const CELL_SIZE = 20;
const BASE_INTERVAL = 150;
const MIN_INTERVAL = 60;

const COLORS = {
  bg: '#16213e',
  grid: 'rgba(255,255,255,0.05)',
  snake: '#00d2ff',
  snakeHead: '#00ffcc',
  food: '#e94560',
};

const canvas = document.getElementById('game-canvas');
canvas.width = COLS * CELL_SIZE;
canvas.height = ROWS * CELL_SIZE;
const ctx = canvas.getContext('2d');

const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const messageEl = document.getElementById('message');

let bestScore = parseInt(localStorage.getItem('snake-best') || '0', 10);
bestEl.textContent = bestScore;

let state = createInitialState(COLS, ROWS);
let loopId = null;

function getState() {
  return state;
}

function getInterval() {
  const speedUp = Math.floor(state.score / 50) * 10;
  return Math.max(MIN_INTERVAL, BASE_INTERVAL - speedUp);
}

function gameLoop() {
  tick(state);
  scoreEl.textContent = state.score;

  if (state.score > bestScore) {
    bestScore = state.score;
    bestEl.textContent = bestScore;
    localStorage.setItem('snake-best', String(bestScore));
  }

  render(ctx, state, CELL_SIZE, COLORS);

  if (state.gameOver) {
    messageEl.textContent = 'Game Over! Press Space or Tap to Restart';
    stopLoop();
    return;
  }

  loopId = setTimeout(gameLoop, getInterval());
}

function stopLoop() {
  if (loopId !== null) {
    clearTimeout(loopId);
    loopId = null;
  }
}

function startOrRestart() {
  if (state.running) return;
  stopLoop();
  if (state.gameOver || !state.running) {
    state = createInitialState(COLS, ROWS);
    scoreEl.textContent = '0';
  }
  state.running = true;
  messageEl.textContent = '';
  gameLoop();
}

setupKeyboard(getState, startOrRestart);
setupTouch(canvas, getState, startOrRestart);

// Initial render
render(ctx, state, CELL_SIZE, COLORS);
