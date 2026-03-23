import { GameLoop } from './game/game-loop.js';
import { renderHud } from './ui/hud.js';

const canvas = document.querySelector('#game');
const hud = document.querySelector('#hud');

if (!canvas || !hud) {
  throw new Error('Required DOM nodes are missing');
}

const game = new GameLoop(canvas);
game.setStateListener((snapshot) => renderHud(hud, snapshot));

document.addEventListener('keydown', (event) => game.keydown(event));
document.addEventListener('keyup', (event) => game.keyup(event));
window.addEventListener('blur', () => game.blur());

game.start();
