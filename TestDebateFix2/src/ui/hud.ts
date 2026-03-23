export type HudState = {
  elapsedTime: number;
  bestTime: number;
  difficulty: number;
  isGameOver: boolean;
};

export function drawHud(
  context: CanvasRenderingContext2D,
  width: number,
  state: HudState,
): void {
  context.save();
  context.fillStyle = 'rgba(9, 17, 31, 0.72)';
  context.fillRect(16, 16, 220, 92);

  context.fillStyle = '#ecf4ff';
  context.font = '700 18px Arial';
  context.fillText(`Time ${state.elapsedTime.toFixed(1)}s`, 30, 44);

  context.fillStyle = '#98accf';
  context.font = '14px Arial';
  context.fillText(`Best ${state.bestTime.toFixed(1)}s`, 30, 68);
  context.fillText(`Difficulty x${state.difficulty.toFixed(2)}`, 30, 90);

  if (state.isGameOver) {
    context.fillStyle = 'rgba(9, 17, 31, 0.82)';
    context.fillRect(width / 2 - 230, 210, 460, 140);
    context.strokeStyle = '#2b3d68';
    context.lineWidth = 2;
    context.strokeRect(width / 2 - 230, 210, 460, 140);

    context.fillStyle = '#ff6b6b';
    context.font = '700 34px Arial';
    context.textAlign = 'center';
    context.fillText('Game Over', width / 2, 258);

    context.fillStyle = '#ecf4ff';
    context.font = '18px Arial';
    context.fillText('Press Enter or Space to restart', width / 2, 300);
    context.textAlign = 'start';
  }

  context.restore();
}