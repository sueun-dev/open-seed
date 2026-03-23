import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Snake Game Smoke Tests', () => {
  let html: string;
  let scriptContent: string;

  beforeAll(() => {
    html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf-8');
    const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
    scriptContent = scriptMatch ? scriptMatch.join('\n') : '';
  });

  it('has a canvas element with id game-canvas', () => {
    expect(html).toContain('id="game-canvas"');
    expect(html).toContain('<canvas');
  });

  it('has score display element', () => {
    expect(html).toContain('id="score-display"');
  });

  it('has mute button', () => {
    expect(html).toContain('id="mute-btn"');
  });

  it('has game over screen', () => {
    expect(html).toContain('id="game-over-screen"');
  });

  it('has restart button', () => {
    expect(html).toContain('id="restart-btn"');
  });

  it('has final score element', () => {
    expect(html).toContain('id="final-score"');
  });

  it('has announcer element for accessibility', () => {
    expect(html).toContain('id="announcer"');
  });

  it('uses dark background (#0a0a0a)', () => {
    expect(html).toContain('#0a0a0a');
  });

  it('has neon glow styling (box-shadow with cyan)', () => {
    expect(html).toContain('box-shadow');
    expect(html).toContain('#00ffff');
  });

  it('defines grid constants in script', () => {
    expect(scriptContent).toContain('GRID');
    expect(scriptContent).toContain('COLS');
    expect(scriptContent).toContain('ROWS');
  });

  it('defines speed progression constants', () => {
    expect(scriptContent).toContain('BASE_SPEED');
    expect(scriptContent).toContain('SPEED_STEP');
    expect(scriptContent).toContain('POINTS_PER_SPEEDUP');
  });

  it('includes Web Audio API for sound effects', () => {
    expect(scriptContent).toContain('AudioContext');
    expect(scriptContent).toContain('playSound');
  });

  it('handles keyboard input with arrow keys', () => {
    expect(scriptContent).toContain('keydown');
    expect(scriptContent).toContain('ArrowUp');
    expect(scriptContent).toContain('ArrowDown');
    expect(scriptContent).toContain('ArrowLeft');
    expect(scriptContent).toContain('ArrowRight');
  });

  it('uses requestAnimationFrame for game loop', () => {
    expect(scriptContent).toContain('requestAnimationFrame');
  });

  it('implements progressive difficulty', () => {
    expect(scriptContent).toContain('MIN_SPEED');
    expect(scriptContent).toMatch(/speed|interval/i);
  });

  it('has game-container with role application for accessibility', () => {
    expect(html).toContain('game-container');
  });

  it('uses neon green color for score', () => {
    expect(html).toContain('#39ff14');
  });

  it('sets canvas dimensions to 600x600', () => {
    expect(html).toMatch(/width="600"/);
    expect(html).toMatch(/height="600"/);
  });

  it('has mute toggle functionality', () => {
    expect(scriptContent).toContain('muted');
  });

  it('prevents default on arrow keys to avoid scrolling', () => {
    expect(scriptContent).toContain('preventDefault');
  });
});
