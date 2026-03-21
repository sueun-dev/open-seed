// V3 eval: checks all VS Code search features including new additions
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

const evals = [
  // Core layout
  { name: 'V1: Search in sidebar', pass: html.includes('id="sidebarSearch"') },
  { name: 'V2: No full-panel search', pass: !html.includes('id="searchPanel"') },

  // Input row
  { name: 'V3: Replace toggle chevron', pass: html.includes('srchReplaceToggle') },
  { name: 'V4: Case toggle (Aa)', pass: html.includes('id="srchCase"') },
  { name: 'V5: Word toggle (Ab)', pass: html.includes('id="srchWord"') },
  { name: 'V6: Regex toggle (.*)', pass: html.includes('id="srchRegex"') },
  { name: 'V7: Ellipsis details button (⋯)', pass: html.includes('srch-details-btn') && html.includes('&#x22EF;') },

  // Replace row
  { name: 'V8: Replace input', pass: html.includes('id="searchReplace"') },
  { name: 'V9: Replace one button', pass: html.includes('replaceOne()') },
  { name: 'V10: Replace all button', pass: html.includes('replaceAll()') },

  // Details section
  { name: 'V11: Files to include', pass: html.includes('id="searchInclude"') },
  { name: 'V12: Files to exclude', pass: html.includes('id="searchExclude"') },

  // Message bar with actions
  { name: 'V13: Collapse All button', pass: html.includes('collapseAllResults') },
  { name: 'V14: Expand All button', pass: html.includes('expandAllResults') },
  { name: 'V15: Clear Search button', pass: html.includes('clearSearch') },
  { name: 'V16: Actions shown after search', pass: html.includes("srchMsgActions") },

  // Results
  { name: 'V17: File tree results', pass: html.includes('srch-file-group') },
  { name: 'V18: Match highlighting', pass: html.includes('mhl') },
  { name: 'V19: Line numbers', pass: html.includes('lnum') },
  { name: 'V20: Dismiss button on hover', pass: html.includes('dismissResult') && html.includes('srch-line-actions') },

  // Keyboard shortcuts in tooltips
  { name: 'V21: Case shortcut in tooltip', pass: /Match Case.*⌥C/s.test(html) || html.includes('Match Case (⌥C)') },
  { name: 'V22: Regex shortcut in tooltip', pass: html.includes('⌥R') },
  { name: 'V23: Escape clears search', pass: html.includes("Escape") && html.includes("clearSearch") },

  // Debounce & auto-search
  { name: 'V24: Debounced search', pass: html.includes('searchDebounce') },
  { name: 'V25: No standalone Search button', pass: !/<button[^>]*>Search<\/button>/.test(html) },
];

let score = 0;
evals.forEach(e => {
  if (e.pass) score++;
  console.log((e.pass ? '✅' : '❌') + ' ' + e.name);
});
const rate = (score / evals.length * 100).toFixed(1);
console.log('\n━━━ V3 Eval Score: ' + score + '/' + evals.length + ' (' + rate + '%) ━━━');
if (score < evals.length) {
  console.log('\nFailing:');
  evals.filter(e => !e.pass).forEach(e => console.log('  ❌ ' + e.name));
}
