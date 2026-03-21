const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

const evals = [
  { name: 'E1: Inline toggle buttons (Aa, Ab, .*)', pass: html.includes('srchCase') && html.includes('srchWord') && html.includes('srchRegex') && html.includes('srch-toggle') },
  { name: 'E2: Replace row with chevron', pass: html.includes('srchReplaceRow') && html.includes('toggleSearchReplace') && html.includes('srch-replace-row') },
  { name: 'E3: Include/exclude files section', pass: html.includes('searchInclude') && html.includes('searchExclude') && html.includes('srch-details-toggle') },
  { name: 'E4: Collapsible file tree results', pass: html.includes('srch-file-group') && html.includes('srch-file-head') && html.includes('srch-file-matches') },
  { name: 'E5: No standalone Search button', pass: html.indexOf('save-btn') === -1 || html.indexOf('>Search</button>') === -1 },
  { name: 'E6: VS Code dark theme styling', pass: html.includes('height:26px') && html.includes('border-radius:3px') && html.includes('srch-panel') }
];

let score = 0;
const breakdown = [];
evals.forEach(e => {
  if (e.pass) score++;
  console.log((e.pass ? '✅' : '❌') + ' ' + e.name);
  breakdown.push({ name: e.name, pass_count: e.pass ? 1 : 0, total: 1 });
});
console.log('\nScore: ' + score + '/6 (' + (score / 6 * 100).toFixed(1) + '%)');

// Output JSON for dashboard
const result = {
  score,
  max_score: 6,
  pass_rate: +(score / 6 * 100).toFixed(1),
  breakdown
};
console.log('\n__RESULT__' + JSON.stringify(result));
