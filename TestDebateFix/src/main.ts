import './styles.css';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  createInitialState,
  getDifficulty,
  stepGame,
  type GameState,
  type InputState,
} from './game';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found');
}

app.innerHTML = `
  <main class="game-shell">
    <header class="game-header">
      <div>
        <div class="title">Shape Dodge</div>
        <div class="subtitle">화살표 키 또는 WASD로 회피 · 스페이스로 재시작</div>
      </div>
      <div class="hud" aria-live="polite">
        <div class="hud-chip" id="time-chip">Time 0.0s</div>
        <div class="hud-chip" id="score-chip">Score 0</div>
        <div class="hud-chip" id="difficulty-chip">Difficulty 0%</div>
      </div>
    </header>
    <section class="canvas-wrap">
      <canvas id="game" width="${GAME_WIDTH}" height="${GAME_HEIGHT}" aria-label="Arcade dodge game"></canvas>
    </section>
  </main>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const timeChip = document.querySelector<HTMLDivElement>('#time-chip');
const scoreChip = document.querySelector<HTMLDivElement>('#score-chip');
const difficultyChip = document.querySelector<HTMLDivElement>('#difficulty-chip');

if (!canvas || !timeChip || !scoreChip || !difficultyChip) {
  throw new Error('Game UI failed to initialize');
}

const context = canvas.getContext('2d');

if (!context) {
  throw new Error('Canvas context unavailable');
}

const input: InputState = {
  left: false,
  right: false,
  up: false,
  down: false,
  restartPressed: false,
};

let state: GameState = createInitialState();
let lastFrame = performance.now();

function syncHud(currentState: GameState): void {
  timeChip.textContent = `Time ${currentState.elapsedTime.toFixed(1)}s`;
  scoreChip.textContent = `Score ${currentState.score}`;
  difficultyChip.textContent = `Difficulty ${Math.round(getDifficulty(currentState.elapsedTime) * 100)}%`;
}

function draw(currentState: GameState): void {
  context.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  context.fillStyle = '#020617';
  context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  context.strokeStyle = 'rgba(34, 211, 238, 0.18)';
  context.lineWidth = 1;
  for (let x = 40; x < GAME_WIDTH; x += 40) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, GAME_HEIGHT);
    context.stroke();
  }

  context.fillStyle = '#22d3ee';
  context.fillRect(currentState.player.x, currentState.player.y, currentState.player.size, currentState.player.size);

  context.fillStyle = '#fb7185';
  for (const obstacle of currentState.obstacles) {
    context.fillRect(obstacle.x, obstacle.y, obstacle.size, obstacle.size);
  }

  if (currentState.gameOver) {
    context.fillStyle = 'rgba(2, 6, 23, 0.72)';
    context.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    context.fillStyle = '#e5e7eb';
    context.textAlign = 'center';
    context.font = 'bold 38px Arial';
    context.fillText('Game Over', GAME_WIDTH / 2, GAME_HEIGHT / 2 - 24);
    context.font = '20px Arial';
    context.fillText(`생존 시간 ${currentState.elapsedTime.toFixed(1)}초`, GAME_WIDTH / 2, GAME_HEIGHT / 2 + 16);
    context.fillText('스페이스를 눌러 다시 시작', GAME_WIDTH / 2, GAME_HEIGHT / 2 + 54);
  }
}

function frame(now: number): void {
  const deltaSeconds = (now - lastFrame) / 1000;
  lastFrame = now;
  state = stepGame(state, input, deltaSeconds);
  syncHud(state);
  draw(state);
  input.restartPressed = false;
  requestAnimationFrame(frame);
}

function setMovementKey(code: string, pressed: boolean): boolean {
  switch (code) {
    case 'ArrowLeft':
    case 'KeyA':
      input.left = pressed;
      return true;
    case 'ArrowRight':
    case 'KeyD':
      input.right = pressed;
      return true;
    case 'ArrowUp':
    case 'KeyW':
      input.up = pressed;
      return true;
    case 'ArrowDown':
    case 'KeyS':
      input.down = pressed;
      return true;
    default:
      return false;
  }
}

document.addEventListener('keydown', (event) => {
  const handled = setMovementKey(event.code, true);
  if (event.code === 'Space') {
    input.restartPressed = true;
  }
  if (handled || event.code === 'Space') {
    event.preventDefault();
  }
});

document.addEventListener('keyup', (event) => {
  if (setMovementKey(event.code, false)) {
    event.preventDefault();
  }
});

syncHud(state);
draw(state);
requestAnimationFrame(frame);
