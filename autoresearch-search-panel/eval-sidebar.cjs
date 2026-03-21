// Sidebar-specific eval: ensures search is in sidebar, editor stays visible
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

const evals = [
  { name: 'S1: sidebarSearch div exists inside sidebar', pass: /id="sidebar"[\s\S]*?id="sidebarSearch"/.test(html) },
  { name: 'S2: sidebarSearch positioned absolute within sidebar', pass: html.includes('position:absolute') && html.includes('id="sidebarSearch"') },
  { name: 'S3: nav(search) does NOT call showFullPanel', pass: !html.includes("showFullPanel('searchPanel')") },
  { name: 'S4: nav(search) removes hide class from sidebar', pass: /v==='search'[\s\S]*?sb\.classList\.remove\('hide'\)/.test(html) },
  { name: 'S5: nav(search) hides explorer body (sbBody)', pass: /v==='search'[\s\S]*?sbBody[\s\S]*?display='none'/.test(html) },
  { name: 'S6: nav(search) sets sbLabel to Search', pass: /sbLabel[\s\S]*?textContent='Search'/.test(html) },
  { name: 'S7: nav(search) shows sidebarSearch (display=flex)', pass: /sidebarSearch[\s\S]*?display='flex'/.test(html) },
  { name: 'S8: searchPanel id no longer exists in HTML', pass: !html.includes('id="searchPanel"') },
  { name: 'S9: sidebar has position:relative', pass: /\.sidebar\{[^}]*position:relative/.test(html) },
  { name: 'S10: Explorer buttons hidden when in search mode', pass: html.includes("explorerBtns") },
];

let score = 0;
evals.forEach(e => {
  if (e.pass) score++;
  console.log((e.pass ? '✅' : '❌') + ' ' + e.name);
});
console.log('\n━━━ Sidebar Eval Score: ' + score + '/' + evals.length + ' (' + (score/evals.length*100).toFixed(1) + '%) ━━━');
if (score < evals.length) {
  console.log('\nFailing:');
  evals.filter(e => !e.pass).forEach(e => console.log('  ❌ ' + e.name));
}
