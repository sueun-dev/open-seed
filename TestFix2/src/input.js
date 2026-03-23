import { DIRECTIONS, changeDirection } from './game.js';

const KEY_MAP = {
  ArrowUp: DIRECTIONS.UP,
  ArrowDown: DIRECTIONS.DOWN,
  ArrowLeft: DIRECTIONS.LEFT,
  ArrowRight: DIRECTIONS.RIGHT,
  w: DIRECTIONS.UP,
  W: DIRECTIONS.UP,
  s: DIRECTIONS.DOWN,
  S: DIRECTIONS.DOWN,
  a: DIRECTIONS.LEFT,
  A: DIRECTIONS.LEFT,
  d: DIRECTIONS.RIGHT,
  D: DIRECTIONS.RIGHT,
};

export function setupKeyboard(getState, onStart) {
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onStart();
      return;
    }
    const dir = KEY_MAP[e.key];
    if (dir) {
      e.preventDefault();
      changeDirection(getState(), dir);
    }
  });
}

export function setupTouch(canvas, getState, onStart) {
  let startX = 0;
  let startY = 0;

  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx < 20 && absDy < 20) {
      onStart();
      return;
    }

    let dir;
    if (absDx > absDy) {
      dir = dx > 0 ? DIRECTIONS.RIGHT : DIRECTIONS.LEFT;
    } else {
      dir = dy > 0 ? DIRECTIONS.DOWN : DIRECTIONS.UP;
    }
    changeDirection(getState(), dir);
  }, { passive: true });

  // Button controls
  const btnMap = {
    'btn-up': DIRECTIONS.UP,
    'btn-down': DIRECTIONS.DOWN,
    'btn-left': DIRECTIONS.LEFT,
    'btn-right': DIRECTIONS.RIGHT,
  };
  Object.entries(btnMap).forEach(([id, dir]) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const state = getState();
        if (!state.running) {
          onStart();
        }
        changeDirection(getState(), dir);
      });
    }
  });
}
