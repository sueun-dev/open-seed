import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('main entry wires keyboard and blur handling', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(source, /keydown/);
  assert.match(source, /keyup/);
  assert.match(source, /blur/);
});

test('browser shell contains canvas mount and game bootstrap script', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /<canvas/i);
  assert.match(html, /src="\/src\/main\.ts"/i);
});
