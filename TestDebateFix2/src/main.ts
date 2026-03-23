import { GameLoop } from './game/game-loop.js';

const canvas = document.querySelector<HTMLCanvasElement>('#game');

if (!canvas) {
  throw new Error('Game canvas not found.');
}

const game = new GameLoop(canvas);
const gameplayKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Enter',
  'Space',
]);

window.addEventListener('keydown', (event) => {
  if (!gameplayKeys.has(event.code)) {
    return;
  }

  event.preventDefault();
  game.handleKeyChange(event.code, true);
});

window.addEventListener('keyup', (event) => {
  if (!gameplayKeys.has(event.code)) {
    return;
  }

  event.preventDefault();
  game.handleKeyChange(event.code, false);
});

window.addEventListener('blur', () => {
  game.resetInput();
});

game.start();
