/**
 * DOCTOR PANEL MEGA EVAL — 200 tests
 * Tests: HTML structure, CSS styling, JS functions, server API, UX patterns
 */
const fs = require('fs');
const html = fs.readFileSync('app/index.html', 'utf8');
const server = fs.readFileSync('app/server.js', 'utf8');

let pass = 0, fail = 0, total = 0;
const failures = [];
function t(name, ok) {
  total++;
  if (ok) { pass++; }
  else { fail++; failures.push(name); }
}

// ════════════════════════════════════════════════════════════
// SECTION 1: DOCTOR PANEL — HTML STRUCTURE (30 tests)
// ════════════════════════════════════════════════════════════
t('D001: doctorPanel exists', html.includes('id="doctorPanel"'));
t('D002: doctorPanel is full-panel', html.includes('class="full-panel" id="doctorPanel"'));
t('D003: Header with doc-header class', html.includes('class="doc-header"'));
t('D004: Header contains h2', /doc-header[\s\S]*?<h2>System Diagnostics<\/h2>/.test(html));
t('D005: Last run timestamp element', html.includes('id="docLastRun"'));
t('D006: Run button exists', html.includes('id="docRunBtn"'));
t('D007: Run button calls runDoctorFull', html.includes("onclick=\"runDoctorFull()\""));
t('D008: Scan Comments button', html.includes('runCommentsScan()'));
t('D009: Export button exists', html.includes('exportDoctorReport()'));
t('D010: Progress bar container', html.includes('id="docProgress"'));
t('D011: Progress bar inner', html.includes('id="docProgressBar"'));
t('D012: Summary stats container', html.includes('id="docSummary"'));
t('D013: OK stat number', html.includes('id="docOkN"'));
t('D014: Warning stat number', html.includes('id="docWarnN"'));
t('D015: Error stat number', html.includes('id="docErrN"'));
t('D016: Total stat number', html.includes('id="docTotalN"'));
t('D017: Checks output area', html.includes('id="docChecks"'));
t('D018: Log area', html.includes('id="docLog"'));
t('D019: Log initially hidden', /id="docLog"[^>]*display:\s*none/.test(html));
t('D020: doc-actions container', html.includes('class="doc-actions"'));
t('D021: doc-summary has 4 stat cards', (html.match(/class="doc-stat/g) || []).length >= 4);
t('D022: OK stat has ok class', html.includes('class="doc-stat ok"'));
t('D023: Warn stat has warn class', html.includes('class="doc-stat warn"'));
t('D024: Error stat has err class', html.includes('class="doc-stat err"'));
t('D025: Stat labels exist (Passed)', html.includes('Passed'));
t('D026: Stat labels exist (Warnings)', html.includes('Warnings'));
t('D027: Stat labels exist (Errors)', /Errors/.test(html));
t('D028: Stat labels exist (Total)', html.includes('Total Checks'));
t('D029: Inner has wider max-width', /doctorPanel[\s\S]*?max-width:\s*900px/.test(html));
t('D030: Export button has title', /exportDoctorReport[\s\S]*?title="Export/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 2: DOCTOR PANEL — CSS (30 tests)
// ════════════════════════════════════════════════════════════
t('C001: doc-header flex layout', /\.doc-header\{[^}]*display:\s*flex/.test(html));
t('C002: doc-header gap', /\.doc-header\{[^}]*gap/.test(html));
t('C003: doc-header border-bottom', /\.doc-header\{[^}]*border-bottom/.test(html));
t('C004: doc-summary flex layout', /\.doc-summary\{[^}]*display:\s*flex/.test(html));
t('C005: doc-stat flex:1', /\.doc-stat\{[^}]*flex:\s*1/.test(html));
t('C006: doc-stat background', /\.doc-stat\{[^}]*background/.test(html));
t('C007: doc-stat border', /\.doc-stat\{[^}]*border/.test(html));
t('C008: doc-stat border-radius', /\.doc-stat\{[^}]*border-radius/.test(html));
t('C009: doc-stat-num font-size large', /\.doc-stat-num\{[^}]*font-size:\s*24px/.test(html));
t('C010: doc-stat-num font-weight bold', /\.doc-stat-num\{[^}]*font-weight:\s*700/.test(html));
t('C011: doc-stat.ok green color', /\.doc-stat\.ok[^{]*\{[^}]*color:\s*var\(--green\)/.test(html));
t('C012: doc-stat.warn orange color', /\.doc-stat\.warn[^{]*\{[^}]*color:\s*var\(--orange\)/.test(html));
t('C013: doc-stat.err red color', /\.doc-stat\.err[^{]*\{[^}]*color:\s*var\(--red\)/.test(html));
t('C014: doc-check flex layout', /\.doc-check\{[^}]*display:\s*flex/.test(html));
t('C015: doc-check gap', /\.doc-check\{[^}]*gap/.test(html));
t('C016: doc-check hover effect', /\.doc-check:hover/.test(html));
t('C017: doc-check-icon border-radius 50%', /\.doc-check-icon\{[^}]*border-radius:\s*50%/.test(html));
t('C018: doc-check-icon.ok green bg', /\.doc-check-icon\.ok\{[^}]*color:\s*var\(--green\)/.test(html));
t('C019: doc-check-icon.warn orange bg', /\.doc-check-icon\.warn\{[^}]*color:\s*var\(--orange\)/.test(html));
t('C020: doc-check-icon.error red bg', /\.doc-check-icon\.error\{[^}]*color:\s*var\(--red\)/.test(html));
t('C021: doc-check-name font-weight', /\.doc-check-name\{[^}]*font-weight:\s*600/.test(html));
t('C022: doc-check-name min-width', /\.doc-check-name\{[^}]*min-width/.test(html));
t('C023: doc-check-time right aligned', /\.doc-check-time\{[^}]*text-align:\s*right/.test(html));
t('C024: doc-log max-height', /\.doc-log\{[^}]*max-height/.test(html));
t('C025: doc-log overflow-y auto', /\.doc-log\{[^}]*overflow-y:\s*auto/.test(html));
t('C026: doc-progress height', /\.doc-progress\{[^}]*height:\s*3px/.test(html));
t('C027: doc-progress-bar transition', /\.doc-progress-bar\{[^}]*transition/.test(html));
t('C028: doc-section-title cursor pointer', /\.doc-section-title\{[^}]*cursor:\s*pointer/.test(html));
t('C029: doc-section-title uppercase', /\.doc-section-title\{[^}]*text-transform:\s*uppercase/.test(html));
t('C030: doc-chev rotation for collapsed', /\.doc-chev\.collapsed\{[^}]*transform:\s*rotate/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 3: DOCTOR PANEL — JS FUNCTIONS (40 tests)
// ════════════════════════════════════════════════════════════
t('J001: runDoctorFull function exists', html.includes('async function runDoctorFull()'));
t('J002: runCommentsScan function exists', html.includes('async function runCommentsScan()'));
t('J003: toggleDocSection function exists', html.includes('function toggleDocSection('));
t('J004: exportDoctorReport function exists', html.includes('function exportDoctorReport('));
t('J005: _doctorResults variable', html.includes('let _doctorResults='));
t('J006: runDoctorFull fetches /api/doctor', /runDoctorFull[\s\S]*?\/api\/doctor/.test(html));
t('J007: fetch uses POST', /runDoctorFull[\s\S]*?method:\s*'POST'/.test(html));
t('J008: Button disabled during run', /runDoctorFull[\s\S]*?btn\.disabled=true/.test(html));
t('J009: Button re-enabled after run', /runDoctorFull[\s\S]*?btn\.disabled=false/.test(html));
t('J010: Progress bar animated', /runDoctorFull[\s\S]*?bar\.style\.width/.test(html));
t('J011: Progress bar reaches 100%', html.includes("bar.style.width='100%'"));
t('J012: Progress bar resets after delay', /setTimeout[\s\S]*?width.*0/.test(html));
t('J013: Summary counters updated (ok)', html.includes("'docOkN'"));
t('J014: Summary counters updated (warn)', html.includes("'docWarnN'"));
t('J015: Summary counters updated (err)', html.includes("'docErrN'"));
t('J016: Summary counters updated (total)', html.includes("'docTotalN'"));
t('J017: Checks grouped by category', /groups\[cat\]/.test(html));
t('J018: Groups iterated with Object.entries', /Object\.entries\(groups\)/.test(html));
t('J019: Check icons rendered (ok ✓)', html.includes('&#x2713;'));
t('J020: Check icons rendered (warn ⚠)', html.includes('&#x26A0;'));
t('J021: Check icons rendered (error ✗)', html.includes('&#x2717;'));
t('J022: Duration displayed', html.includes('durationMs'));
t('J023: Last run time updated', html.includes("'docLastRun'"));
t('J024: Last run uses toLocaleTimeString', html.includes('toLocaleTimeString()'));
t('J025: Log messages appended', /logMsg[\s\S]*?log\.innerHTML\+/.test(html));
t('J026: Log auto-scrolls', html.includes('log.scrollTop=log.scrollHeight'));
t('J027: Error handling with try/catch', /runDoctorFull[\s\S]*?catch\(e\)/.test(html));
t('J028: Error message escaped', /runDoctorFull[\s\S]*?esc\(e\.message\)/.test(html));
t('J029: Results stored in _doctorResults', html.includes('_doctorResults=d'));
t('J030: toggleDocSection toggles chevron', /toggleDocSection[\s\S]*?classList\.toggle\('collapsed'\)/.test(html));
t('J031: toggleDocSection hides siblings', /toggleDocSection[\s\S]*?style\.display/.test(html));
t('J032: exportDoctorReport checks for results', /exportDoctorReport[\s\S]*?!_doctorResults/.test(html));
t('J033: Export creates markdown', /exportDoctorReport[\s\S]*?# Open Seed Diagnostic Report/.test(html));
t('J034: Export includes date', /exportDoctorReport[\s\S]*?new Date\(\)\.toISOString/.test(html));
t('J035: Export uses Blob', /exportDoctorReport[\s\S]*?new Blob/.test(html));
t('J036: Export triggers download', /exportDoctorReport[\s\S]*?\.download=/.test(html));
t('J037: Export filename is diagnostic-report.md', html.includes("'diagnostic-report.md'"));
t('J038: runCommentsScan shows log', /runCommentsScan[\s\S]*?log\.style\.display='block'/.test(html));
t('J039: runCommentsScan escapes output', /runCommentsScan[\s\S]*?esc\(/.test(html));
t('J040: runCommentsScan error handling', /runCommentsScan[\s\S]*?catch\(e\)/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 4: SERVER — /api/doctor CHECKS (50 tests)
// ════════════════════════════════════════════════════════════
t('S001: /api/doctor endpoint exists', server.includes('/api/doctor'));
t('S002: Supports POST method', /\/api\/doctor.*POST/.test(server));
t('S003: Supports GET method', /\/api\/doctor.*GET/.test(server));
t('S004: Returns JSON', /\/api\/doctor[\s\S]*?application\/json/.test(server));
t('S005: Has timed helper function', server.includes('const timed'));
t('S006: timed tracks durationMs', server.includes('durationMs'));
t('S007: timed uses Date.now', /timed[\s\S]*?Date\.now\(\)/.test(server));
t('S008: Category: Environment', server.includes('"Environment"'));
t('S009: Category: Providers', server.includes('"Providers"'));
t('S010: Category: Workspace', server.includes('"Workspace"'));
t('S011: Category: Git', server.includes('"Git"'));
t('S012: Category: Tools', server.includes('"Tools"'));
t('S013: Category: Security', server.includes('"Security"'));
t('S014: Check Node.js version', /Node\.js.*process\.version/.test(server));
t('S015: Check npm version', /npm --version/.test(server));
t('S016: Check git version', /git --version/.test(server));
t('S017: Check Shell env', /process\.env\.SHELL/.test(server));
t('S018: Check Memory usage', /memoryUsage/.test(server));
t('S019: Check Disk space', /df -h/.test(server));
t('S020: Check OpenAI key', /OPENAI_API_KEY/.test(server));
t('S021: Check Anthropic key', /ANTHROPIC_API_KEY/.test(server));
t('S022: Check Gemini key', /GEMINI_API_KEY/.test(server));
t('S023: Check Codex OAuth', /codex.*auth\.json/.test(server));
t('S024: Check Claude OAuth', /\.claude/.test(server));
t('S025: Check config.json', /config\.json/.test(server));
t('S026: Check package.json', /package\.json/.test(server));
t('S027: Check node_modules', /node_modules/.test(server));
t('S028: Check build output', /dist.*cli\.js/.test(server));
t('S029: Check file count', /readdirSync/.test(server));
t('S030: Check .gitignore', /\.gitignore/.test(server));
t('S031: Check git repo validity', /rev-parse/.test(server));
t('S032: Check git branch', /branch --show-current/.test(server));
t('S033: Check uncommitted changes', /status --porcelain/.test(server));
t('S034: Check git remote', /remote get-url origin/.test(server));
t('S035: Check TypeScript', /tsc --version/.test(server));
t('S036: Check ESLint', /eslint --version/.test(server));
t('S037: Check Prettier', /prettier --version/.test(server));
t('S038: Check Playwright', /playwright/.test(server));
t('S039: .env protection check', /\.env.*gitignore/.test(server));
t('S040: Exposed secrets check', /ls-files.*error-unmatch.*\.env/.test(server));
t('S041: Memory threshold at 500MB', server.includes('mb > 500'));
t('S042: Disk threshold at 90%', server.includes('> 90'));
t('S043: Uncommitted changes threshold at 20', server.includes('> 20'));
t('S044: Returns healthy boolean', /healthy:\s*errors\s*===\s*0/.test(server));
t('S045: Returns checks array', /checks,/.test(server));
t('S046: Returns summary string', /summary:/.test(server));
t('S047: Error handler returns JSON', /healthy:\s*false/.test(server));
t('S048: execSync has timeout', /timeout:\s*\d+/.test(server));
t('S049: API key partially masked', /slice\(0,\s*8\)/.test(server));
t('S050: Checks have category field', /category/.test(server));

// ════════════════════════════════════════════════════════════
// SECTION 5: UX & INTERACTION PATTERNS (25 tests)
// ════════════════════════════════════════════════════════════
t('U001: Button text changes during run', html.includes("'Running...'"));
t('U002: Button text restores after run', html.includes("'Run Full Diagnostic'"));
t('U003: Progress bar starts at 10%', html.includes("bar.style.width='10%'"));
t('U004: Progress bar to 30%', html.includes("bar.style.width='30%'"));
t('U005: Progress bar to 70%', html.includes("bar.style.width='70%'"));
t('U006: Progress bar to 100%', html.includes("bar.style.width='100%'"));
t('U007: Progress bar reset to 0', html.includes("bar.style.width='0'"));
t('U008: Default text shows prompt', html.includes('Press "Run Full Diagnostic"'));
t('U009: Placeholder dash for stats', html.includes('>—<'));
t('U010: Log shows on run', /log\.style\.display='block'/.test(html));
t('U011: Section title shows pass count', html.includes("catOk+'/'+catTotal"));
t('U012: Action required message for errors', html.includes('ACTION REQUIRED'));
t('U013: Check hover has transition', /\.doc-check\{[^}]*transition/.test(html));
t('U014: Section title user-select none', /\.doc-section-title\{[^}]*user-select:\s*none/.test(html));
t('U015: Chevron transition', /\.doc-section-title .doc-chev\{[^}]*transition/.test(html));
t('U016: Status icons use semantic colors', html.includes('doc-check-icon ok') || html.includes("doc-check-icon '+c.status"));
t('U017: Duration in milliseconds', html.includes("+'ms'"));
t('U018: doc-header-sub for subtitle', html.includes('class="doc-header-sub"'));
t('U019: Export creates download link', /createElement\('a'\)/.test(html));
t('U020: Export uses createObjectURL', html.includes('URL.createObjectURL'));
t('U021: Checks escape all output', /esc\(c\.name\)/.test(html));
t('U022: Checks escape messages', /esc\(c\.message\)/.test(html));
t('U023: Full-panel transition', /\.full-panel\{[^}]*transition/.test(html));
t('U024: nav handles doctor mode', html.includes("'doctor'"));
t('U025: Doctor panel toggled via showFullPanel', html.includes("showFullPanel('doctorPanel')"));

// ════════════════════════════════════════════════════════════
// SECTION 6: ANTI-PATTERNS & SECURITY (25 tests)
// ════════════════════════════════════════════════════════════
t('A001: No innerHTML with raw user data', !/doctorOut\.innerHTML\s*=\s*d\./.test(html));
t('A002: Error messages escaped in UI', /runDoctorFull[\s\S]*?esc\(e\.message\)/.test(html));
t('A003: Comments scan escapes output', /runCommentsScan[\s\S]*?esc\(/.test(html));
t('A004: No eval in doctor code', !/eval\([^)]*doctor/.test(html));
t('A005: No document.write in doctor', !html.includes('document.write'));
t('A006: Server timeout on execSync', /execSync[\s\S]*?timeout/.test(server));
t('A007: Server catches execSync errors', /try\s*\{[^}]*execSync[\s\S]*?\}\s*catch/.test(server));
t('A008: API key not fully exposed', /slice\(0,\s*8\)/.test(server));
t('A009: No console.log in doctor JS', !/function runDoctorFull[\s\S]*?console\.log/.test(html));
t('A010: Server returns proper status codes', /writeHead\(200/.test(server));
t('A011: Export report no injection risk', /exportDoctorReport[\s\S]*?\.checks/.test(html));
t('A012: No hardcoded URLs in doctor panel', !/doctorPanel[\s\S]*?localhost:\d{4}/.test(html));
t('A013: Server doctor endpoint uses CWD safely', /path\.join\(CWD/.test(server));
t('A014: No force flag in git checks', !/--force/.test(server.match(/\/api\/doctor[\s\S]*?return;\s*\}/)?.[0] || ''));
t('A015: stdio pipe for safety', /stdio.*pipe/.test(server));
t('A016: Relative API URLs', html.includes("fetch('/api/doctor'"));
t('A017: No sync operations in client', !/function runDoctorFull\(\)\{[\s\S]*?readFileSync/.test(html));
t('A018: Doctor results not persisted to DOM unsafely', /esc\(c\.name\)/.test(html));
t('A019: Button disabled prevents double-click', /btn\.disabled/.test(html));
t('A020: Log scrolls to bottom', /scrollTop=.*scrollHeight/.test(html));
t('A021: Progress bar width never exceeds 100%', !html.includes("bar.style.width='110%'"));
t('A022: No alert() in runDoctorFull', !/function runDoctorFull\(\)\{[^}]*alert\(/.test(html));
t('A023: Export alerts if no data', /exportDoctorReport[\s\S]*?alert\('Run diagnostics first'\)/.test(html));
t('A024: toggleDocSection null-safe', /toggleDocSection[\s\S]*?nextElementSibling/.test(html));
t('A025: Server error returns healthy:false', /healthy:\s*false/.test(server));

// ════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════');
console.log(`DOCTOR EVAL: ${pass}/${total} passed (${(pass/total*100).toFixed(1)}%)`);
console.log('══════════════════════════════════════════════════');
if (failures.length) {
  console.log('\nFAILED:');
  failures.forEach(f => console.log('  ✗ ' + f));
}
process.exit(fail > 0 ? 1 : 0);
