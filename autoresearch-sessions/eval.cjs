const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

const evals = [
  // Core: sidebar not fullscreen
  { name: 'S1: Sessions in sidebar (not full-panel)', pass: html.includes('id="sidebarSessions"') && !html.includes('id="sessionsPanel"') },
  { name: 'S2: nav(sessions) does NOT call showFullPanel', pass: !html.includes("showFullPanel('sessionsPanel')") },
  { name: 'S3: nav(sessions) keeps sidebar visible (remove hide)', pass: /v==='sessions'[\s\S]*?sb\.classList\.remove\('hide'\)/.test(html) },
  { name: 'S4: nav(sessions) sets sbLabel to Sessions', pass: /sbLabel[\s\S]*?textContent='Sessions'/.test(html) },

  // API
  { name: 'S5: Uses /api/sessions (not /api/status)', pass: html.includes("fetch('/api/sessions')") && !html.includes("fetch('/api/status')") },
  { name: 'S6: Parses JSON sessions array', pass: html.includes('.json()') && html.includes('s.task') && html.includes('s.status') },

  // UI components
  { name: 'S7: Individual ses-item elements', pass: html.includes('ses-item') && html.includes("class=\"ses-item\"") },
  { name: 'S8: Status dots (ok/fail/run/unknown)', pass: html.includes('ses-dot ok') || (html.includes("dotClass") && html.includes("'ok'") && html.includes("'fail'") && html.includes("'run'")) },
  { name: 'S9: Task text truncated with ellipsis', pass: /\.ses-task\{[^}]*text-overflow:ellipsis/.test(html) },
  { name: 'S10: Relative time display (ago)', pass: html.includes('formatSessionTime') && html.includes('ago') },

  // Phase badge
  { name: 'S11: Phase badge displayed', pass: html.includes('ses-phase') && html.includes('s.phase') },

  // Interactivity
  { name: 'S12: Click handler on session items', pass: html.includes('openSession') },
  { name: 'S13: Refresh button in header', pass: html.includes('ses-header') && /ses-header[\s\S]*?loadSessions/.test(html) },
  { name: 'S14: Auto-loads on nav (no manual Refresh needed)', pass: /v==='sessions'[\s\S]*?loadSessions\(\)/.test(html) },

  // No old artifacts
  { name: 'S15: No old h2 Session History heading', pass: !html.includes('<h2>Session History</h2>') },
  { name: 'S16: No old save-btn Refresh button', pass: !/<button class="save-btn"[^>]*>Refresh<\/button>/.test(html) },
  { name: 'S17: sessionsPanel id removed from HTML', pass: !html.includes('id="sessionsPanel"') },
  { name: 'S18: sessionsPanel removed from fullscreen hide list', pass: !html.includes("'sessionsPanel'") },

  // Styling
  { name: 'S19: Sidebar sessions has overflow:hidden', pass: html.includes('id="sidebarSessions"') && /sidebarSessions[^>]*overflow:hidden/.test(html) },
  { name: 'S20: Empty state message', pass: html.includes('ses-empty') && html.includes('No sessions found') },
];

let score = 0;
evals.forEach(e => {
  if (e.pass) score++;
  console.log((e.pass ? '✅' : '❌') + ' ' + e.name);
});
const rate = (score / evals.length * 100).toFixed(1);
console.log('\n━━━ Sessions Eval Score: ' + score + '/' + evals.length + ' (' + rate + '%) ━━━');
if (score < evals.length) {
  console.log('\nFailing:');
  evals.filter(e => !e.pass).forEach(e => console.log('  ❌ ' + e.name));
}
