/**
 * Renders game state to a canvas 2D context.
 */
export function render(ctx, state, cellSize, colors) {
  const { cols, rows, snake, food, gameOver } = state;
  const w = cols * cellSize;
  const h = rows * cellSize;

  // Background
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= cols; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cellSize, 0);
    ctx.lineTo(x * cellSize, h);
    ctx.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cellSize);
    ctx.lineTo(w, y * cellSize);
    ctx.stroke();
  }

  // Food
  if (food) {
    ctx.fillStyle = colors.food;
    const padding = 2;
    ctx.beginPath();
    ctx.arc(
      food.x * cellSize + cellSize / 2,
      food.y * cellSize + cellSize / 2,
      cellSize / 2 - padding,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // Snake
  snake.forEach((seg, i) => {
    const isHead = i === 0;
    ctx.fillStyle = isHead ? colors.snakeHead : colors.snake;
    const p = isHead ? 0 : 1;
    ctx.fillRect(
      seg.x * cellSize + p,
      seg.y * cellSize + p,
      cellSize - p * 2,
      cellSize - p * 2
    );
    if (isHead) {
      ctx.fillStyle = colors.bg;
      ctx.beginPath();
      ctx.arc(
        seg.x * cellSize + cellSize * 0.35,
        seg.y * cellSize + cellSize * 0.35,
        2,
        0,
        Math.PI * 2
      );
      ctx.arc(
        seg.x * cellSize + cellSize * 0.65,
        seg.y * cellSize + cellSize * 0.35,
        2,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  });

  // Game over overlay
  if (gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${cellSize * 1.5}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Game Over', w / 2, h / 2 - cellSize);
    ctx.font = `${cellSize * 0.8}px system-ui`;
    ctx.fillText(`Score: ${state.score}`, w / 2, h / 2 + cellSize * 0.5);
    ctx.font = `${cellSize * 0.6}px system-ui`;
    ctx.fillText('Press Space to Restart', w / 2, h / 2 + cellSize * 2);
  }
}
