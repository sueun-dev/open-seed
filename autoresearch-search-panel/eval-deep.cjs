// Deep eval: checks VS Code fidelity beyond structure
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

const evals = [
  // Layout
  { name: 'D1: Search lives in sidebar (not full-panel)', pass: html.includes('id="sidebarSearch"') && !html.includes('id="searchPanel"') },
  { name: 'D2: No h2 heading (VS Code has no title in search)', pass: !/<h2>Search in Project<\/h2>/.test(html) },
  { name: 'D3: Input height is 26px (VS Code standard)', pass: html.includes('height:26px') },
  { name: 'D4: Toggle buttons compact (20-22px)', pass: /\.srch-toggle\{[^}]*width:2[0-2]px/.test(html) && /\.srch-toggle\{[^}]*height:2[0-2]px/.test(html) },

  // Interactions
  { name: 'D5: Debounced search on typing', pass: html.includes('searchDebounce') && html.includes('oninput') },
  { name: 'D6: Replace toggle with chevron arrow', pass: html.includes('srchReplaceToggle') && html.includes('&#9654;') },
  { name: 'D7: Details section (include/exclude) with ellipsis toggle', pass: html.includes('srchDetailsBtn') && html.includes('srch-details-body') && html.includes('&#x22EF;') },

  // Results
  { name: 'D8: Results grouped by file with badge count', pass: html.includes('srch-file-group') && html.includes('.badge') },
  { name: 'D9: Match highlighting in results', pass: html.includes('mhl') && html.includes('yellow') },
  { name: 'D10: Line numbers in results', pass: html.includes('lnum') },

  // Styling
  { name: 'D11: Border-radius 3px (VS Code, not rounded)', pass: /\.srch-input-wrap\{[^}]*border-radius:3px/.test(html) },
  { name: 'D12: Search nav keeps editor visible (no showFullPanel)', pass: !html.includes("showFullPanel('searchPanel')") },

  // Functional
  { name: 'D13: Case-sensitive toggle affects grep', pass: html.includes("caseSensitive") && html.includes("-i") },
  { name: 'D14: Regex toggle affects grep', pass: html.includes("useRegex") && html.includes("-E") },
  { name: 'D15: Whole-word toggle affects grep', pass: html.includes("wholeWord") && html.includes("-w") },
  { name: 'D16: Include filter passes --include to grep', pass: html.includes("--include") && html.includes("searchInclude") },
  { name: 'D17: Exclude filter passes --exclude to grep', pass: html.includes("--exclude") && html.includes("searchExclude") },

  // Anti-patterns (should NOT exist)
  { name: 'D18: No old search-input class used in search panel', pass: !/<input class="search-input" id="searchIn"/.test(html) },
  { name: 'D19: No old save-btn Search button', pass: !/<button class="save-btn"[^>]*>Search<\/button>/.test(html) },
  { name: 'D20: No old searchGlob input', pass: !html.includes('id="searchGlob"') },
];

let score = 0;
evals.forEach(e => {
  if (e.pass) score++;
  console.log((e.pass ? '✅' : '❌') + ' ' + e.name);
});
const rate = (score / evals.length * 100).toFixed(1);
console.log('\n━━━ Deep Eval Score: ' + score + '/' + evals.length + ' (' + rate + '%) ━━━');

if (score < evals.length) {
  console.log('\nFailing evals:');
  evals.filter(e => !e.pass).forEach(e => console.log('  ❌ ' + e.name));
}
