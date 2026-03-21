// Integration test: fetch the actual page and validate the search panel HTML
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
    // Structure tests
    ['Search in sidebar exists', html.includes('id="sidebarSearch"')],
    ['Search not in full-panel', !html.includes('id="searchPanel"')],
    ['No old h2 Search in Project', !html.includes('<h2>Search in Project</h2>')],
    ['Search input exists', html.includes('id="searchIn"')],
    ['Search input placeholder is "Search"', html.includes('placeholder="Search"')],

    // Toggle buttons
    ['Case toggle (Aa)', html.includes('id="srchCase"') && html.includes('>Aa</div>')],
    ['Word toggle (Ab)', html.includes('id="srchWord"') && html.includes('>Ab</div>')],
    ['Regex toggle (.*)', html.includes('id="srchRegex"') && html.includes('>.*</div>')],
    ['Toggles have srch-toggle class', (html.match(/class="srch-toggle"/g) || []).length >= 3],

    // Replace row
    ['Replace toggle button', html.includes('id="srchReplaceToggle"')],
    ['Replace input', html.includes('id="searchReplace"')],
    ['Replace row hidden by default', html.includes('class="srch-replace-row"')],

    // Files include/exclude
    ['Include input', html.includes('id="searchInclude"')],
    ['Exclude input', html.includes('id="searchExclude"')],
    ['Details toggle (ellipsis button)', html.includes('id="srchDetailsBtn"')],
    ['Details body hidden by default', html.includes('class="srch-details-body"')],

    // Results area
    ['Results container', html.includes('id="searchResults"')],
    ['Status message area', html.includes('id="searchMsg"')],

    // JS functions
    ['runSearch function', html.includes('function runSearch()')],
    ['searchDebounce function', html.includes('function searchDebounce()')],
    ['toggleSrch function', html.includes('function toggleSrch(')],
    ['toggleSearchReplace function', html.includes('function toggleSearchReplace()')],
    ['toggleSearchDetails function', html.includes('function toggleSearchDetails()')],

    // CSS classes
    ['srch-file-group class defined', html.includes('.srch-file-group')],
    ['srch-file-head class defined', html.includes('.srch-file-head')],
    ['srch-match-line class defined', html.includes('.srch-match-line')],
    ['mhl highlight class defined', html.includes('.mhl')],

    // No old artifacts
    ['No old searchGlob input', !html.includes('id="searchGlob"')],
    ['No old save-btn Search', !(/<button class="save-btn"[^>]*>Search<\/button>/.test(html))],
    ['No old search-input class on main input', !html.includes('class="search-input" id="searchIn"')],
  ];

  let pass = 0, fail = 0;
  tests.forEach(([name, result]) => {
    console.log((result ? '✅' : '❌') + ' ' + name);
    if (result) pass++; else fail++;
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Integration Tests: ' + pass + '/' + tests.length + ' passed');
  if (fail > 0) {
    console.log('FAILURES: ' + fail);
    process.exit(1);
  } else {
    console.log('ALL PASSED ✅');
  }
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
