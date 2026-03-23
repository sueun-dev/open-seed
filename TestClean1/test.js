const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

const file = path.join(__dirname, 'index.html');
console.log('Testing: ' + file);
console.log('');

// File existence and size
assert(fs.existsSync(file), 'index.html exists');
const html = fs.readFileSync(file, 'utf8');
assert(html.length > 1000, 'index.html is not empty (size: ' + html.length + ' bytes)');

// Canvas
console.log('\nCanvas:');
assert(html.includes('<canvas'), 'has <canvas> element');
assert(html.includes('getContext'), 'uses canvas 2d context');
assert(html.includes('COLS') && html.includes('ROWS'), 'has grid constants (COLS, ROWS)');
assert(html.includes('CELL'), 'has cell size constant');

// Keyboard controls
console.log('\nKeyboard Controls:');
assert(html.includes('keydown'), 'has keydown event listener');
assert(html.includes('ArrowUp') || html.includes('ArrowDown'), 'handles arrow keys');
assert(html.includes('"w"') || html.includes("'w'") || html.includes('w:') || html.includes('W:'), 'handles WASD keys');
assert(html.includes('preventDefault'), 'prevents default on arrow keys');

// Web Audio API SFX
console.log('\nAudio:');
assert(html.includes('AudioContext') || html.includes('webkitAudioContext'), 'uses Web Audio API');
assert(html.includes('createOscillator') || html.includes('OscillatorNode'), 'creates oscillator for SFX');
assert(html.includes('sfxEat'), 'has eat sound effect');
assert(html.includes('sfxDie'), 'has die sound effect');
assert(html.includes('sfxLevel'), 'has level-up sound effect');
assert(html.includes('ensureAudio'), 'lazy-inits audio on user gesture');

// Progressive difficulty
console.log('\nProgressive Difficulty:');
assert(html.includes('BASE_INTERVAL'), 'has base interval constant');
assert(html.includes('MIN_INTERVAL'), 'has minimum interval constant');
assert(html.includes('SPEEDUP_EVERY'), 'has speedup threshold');
assert(html.includes('SPEEDUP_AMOUNT'), 'has speedup amount');
assert(html.includes('getInterval') || html.includes('interval'), 'calculates dynamic interval');

// Neon styling
console.log('\nNeon Style:');
assert(html.includes('text-shadow') || html.includes('shadowBlur'), 'has glow effects');
assert(html.includes('#0ff') || html.includes('cyan') || html.includes('0,255,255'), 'uses cyan neon color');
assert(html.includes('#0f0') || html.includes('0,255,0'), 'uses green neon color');
assert(html.includes('#f0f') || html.includes('255,0,255') || html.includes('magenta'), 'uses magenta neon color');
assert(html.includes('background') && html.includes('#000'), 'dark background');

// Score/Level/High display
console.log('\nHUD:');
assert(html.includes('id="score"'), 'has score display');
assert(html.includes('id="level"'), 'has level display');
assert(html.includes('id="high"'), 'has high score display');
assert(html.includes('localStorage'), 'persists high score in localStorage');

// Game-over/restart
console.log('\nGame Flow:');
assert(html.includes('startScreen') || html.includes('start-screen'), 'has start screen');
assert(html.includes('gameOver') || html.includes('game-over') || html.includes('game_over'), 'has game over state');
assert(html.includes('finalScore') || html.includes('final-score'), 'shows final score');
assert(html.includes('resetGame') || html.includes('restart'), 'has restart functionality');

// Accessibility
console.log('\nAccessibility:');
assert(html.includes('aria-live'), 'has aria-live regions');
assert(html.includes('role='), 'has ARIA roles');
assert(html.includes('lang='), 'has lang attribute');
assert(html.includes('announcer'), 'has screen reader announcer');
assert(html.includes('Escape'), 'has Escape key for pause');

// 180-degree reversal prevention
console.log('\nGame Logic:');
assert(html.includes('direction') && html.includes('nextDirection'), 'buffers direction input');
assert(html.includes('spawnFood'), 'has food spawning logic');

// Build output
console.log('\nbuild script:');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
assert(pkg.scripts && pkg.scripts.build, 'package.json has build script');
assert(pkg.scripts && pkg.scripts.test, 'package.json has test script');
assert(pkg.scripts && pkg.scripts.start, 'package.json has start script');

// Summary
console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
console.log('='.repeat(40));

if (failed > 0) {
  process.exit(1);
}
