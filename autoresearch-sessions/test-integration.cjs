const http = require('http');
function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Fetching live page from http://localhost:4040/...\n');
  const html = await fetch('http://localhost:4040/');

  const tests = [
    // Structure
    ['sidebarSessions exists', html.includes('id="sidebarSessions"')],
    ['sessionsPanel removed', !html.includes('id="sessionsPanel"')],
    ['No old Session History heading', !html.includes('<h2>Session History</h2>')],

    // Sidebar overlay
    ['sidebarSessions is absolute positioned', /sidebarSessions[^>]*position:absolute/.test(html)],
    ['sidebarSessions has overflow:hidden', /sidebarSessions[^>]*overflow:hidden/.test(html)],

    // UI elements
    ['ses-header exists', html.includes('class="ses-header"')],
    ['Refresh button in header', html.includes('onclick="loadSessions()"')],
    ['sessionsList container', html.includes('id="sessionsList"')],
    ['ses-list class on list container', html.includes('class="ses-list"')],

    // CSS classes defined
    ['ses-item CSS', html.includes('.ses-item{')],
    ['ses-dot CSS', html.includes('.ses-dot{')],
    ['ses-task CSS', html.includes('.ses-task{')],
    ['ses-meta CSS', html.includes('.ses-meta{')],
    ['ses-phase CSS', html.includes('.ses-phase{')],
    ['ses-empty CSS', html.includes('.ses-empty{')],
    ['ses-header CSS', html.includes('.ses-header{')],

    // JS functions
    ['loadSessions function', html.includes('async function loadSessions()')],
    ['formatSessionTime function', html.includes('function formatSessionTime(')],
    ['openSession function', html.includes('function openSession(')],
    ['Uses /api/sessions', html.includes("fetch('/api/sessions')")],

    // Animations
    ['Pulse animation for running', html.includes('@keyframes pulse')],
    ['run dot has animation', /\.ses-dot\.run\{[^}]*animation/.test(html)],

    // No old artifacts
    ['No old save-btn Refresh', !html.includes('onclick="loadSessions()" style="font-size:11px;padding:5px')],
    ['No showFullPanel for sessions', !html.includes("showFullPanel('sessionsPanel')")],
    ['sessionsPanel not in hide list', !html.includes("'sessionsPanel'")],
  ];

  let pass = 0, fail = 0;
  tests.forEach(([name, result]) => {
    console.log((result ? '✅' : '❌') + ' ' + name);
    if (result) pass++; else fail++;
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Sessions Integration: ' + pass + '/' + tests.length + ' passed');
  if (fail > 0) { console.log('FAILURES: ' + fail); process.exit(1); }
  else console.log('ALL PASSED ✅');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
