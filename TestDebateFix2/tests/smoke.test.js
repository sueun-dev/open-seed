import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('index.html includes the game canvas and entry module', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<canvas id="game"/);
  assert.match(html, /src="\/src\/main\.ts"/);
});

test('game loop source contains input, difficulty, collision, and restart logic', async () => {
  const source = await readFile(new URL('../src/game/game-loop.ts', import.meta.url), 'utf8');
  assert.match(source, /handleKeyChange/);
  assert.match(source, /keyup|keydown/i);
  assert.match(source, /restart/);
  assert.match(source, /difficulty|spawnInterval|elapsedTime/i);
  assert.match(source, /collis|hitbox/i);
});
