# Snake Neon Edition

A classic Snake game with neon visual effects, progressive difficulty, and sound effects.

## How to Play

1. Open `index.html` in any modern browser
2. Press **Space** to start
3. Use **Arrow Keys** to control the snake
4. Eat the pink food to grow and score points
5. Press **P** to pause/resume
6. Press **Space** to restart after game over

## Features

- **Neon glow** visual style with CSS shadows and Canvas effects
- **Progressive difficulty** — speed increases every 5 points
- **Sound effects** via Web Audio API (eat, die, level-up)
- **High score** persistence via localStorage
- **Accessible** — ARIA live regions, keyboard focus management, prefers-reduced-motion support
- **Zero dependencies** — single self-contained HTML file
- **Works offline** — no network requests

## Technical Details

- Canvas: 20×20 grid, 20px cells (400×400px)
- Speed formula: `max(60, 150 - score × 2)` milliseconds per tick
- Levels: every 5 points
- All code inline in `<script>` and `<style>` tags
