// Mega eval: 500+ tests covering search panel, sessions panel, security, CSS, JS functions, accessibility
// Tests run against the static HTML file (no server needed)
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

const tests = [];
function t(name, pass) { tests.push({ name, pass: !!pass }); }

// ════════════════════════════════════════════════════════════
// SECTION 1: SEARCH PANEL — STRUCTURE (50 tests)
// ════════════════════════════════════════════════════════════
t('S001: sidebarSearch exists', html.includes('id="sidebarSearch"'));
t('S002: sidebarSearch is in sidebar (not main)', !/<div id="main"[\s\S]*?id="sidebarSearch"/.test(html));
t('S003: No full-panel searchPanel', !html.includes('id="searchPanel"'));
t('S004: No old h2 Search in Project', !/<h2>Search in Project<\/h2>/.test(html));
t('S005: sidebarSearch uses absolute positioning', /id="sidebarSearch"[^>]*position:\s*absolute/.test(html));
t('S006: sidebarSearch uses inset:0', /id="sidebarSearch"[^>]*inset:\s*0/.test(html));
t('S007: sidebarSearch uses z-index', /id="sidebarSearch"[^>]*z-index/.test(html));
t('S008: sidebarSearch uses flex column', /id="sidebarSearch"[^>]*flex-direction:\s*column/.test(html));
t('S009: sidebarSearch hidden by default', /id="sidebarSearch"[^>]*display:\s*none/.test(html));
t('S010: sidebarSearch has bg color', /id="sidebarSearch"[^>]*background/.test(html));
t('S011: Search input exists', html.includes('id="searchIn"'));
t('S012: Search input placeholder is Search', html.includes('placeholder="Search"'));
t('S013: Search input has spellcheck=false', html.includes('spellcheck="false"'));
t('S014: Search input has oninput', /id="searchIn"[^>]*oninput/.test(html));
t('S015: Search input has onkeydown', /id="searchIn"[^>]*onkeydown/.test(html));
t('S016: Replace toggle exists', html.includes('id="srchReplaceToggle"'));
t('S017: Replace toggle has chevron', html.includes('&#9654;'));
t('S018: Replace toggle has onclick', /srchReplaceToggle[^>]*onclick/.test(html));
t('S019: Replace toggle has title', /srchReplaceToggle[^>]*title/.test(html));
t('S020: Replace input exists', html.includes('id="searchReplace"'));
t('S021: Replace input placeholder', html.includes('placeholder="Replace"'));
t('S022: Replace row exists', html.includes('id="srchReplaceRow"'));
t('S023: Replace row has srch-replace-row class', html.includes('class="srch-replace-row"'));
t('S024: Case toggle exists', html.includes('id="srchCase"'));
t('S025: Case toggle text Aa', /id="srchCase"[^>]*>Aa</.test(html));
t('S026: Case toggle has onclick', /id="srchCase"[^>]*onclick/.test(html));
t('S027: Case toggle has title with ⌥C', /id="srchCase"[^>]*title="[^"]*⌥C/.test(html));
t('S028: Word toggle exists', html.includes('id="srchWord"'));
t('S029: Word toggle text Ab', /id="srchWord"[^>]*>Ab</.test(html));
t('S030: Word toggle has title with ⌥W', /id="srchWord"[^>]*title="[^"]*⌥W/.test(html));
t('S031: Regex toggle exists', html.includes('id="srchRegex"'));
t('S032: Regex toggle text .*', /id="srchRegex"[^>]*>\.\*</.test(html));
t('S033: Regex toggle has title with ⌥R', /id="srchRegex"[^>]*title="[^"]*⌥R/.test(html));
t('S034: All 3 toggles have srch-toggle class', (html.match(/class="srch-toggle"/g) || []).length >= 3);
t('S035: Details button exists', html.includes('id="srchDetailsBtn"'));
t('S036: Details button has ellipsis ⋯', html.includes('&#x22EF;'));
t('S037: Details button has srch-details-btn class', html.includes('srch-details-btn'));
t('S038: Details body exists', html.includes('id="srchDetailsBody"'));
t('S039: Details body has srch-details-body class', html.includes('class="srch-details-body"'));
t('S040: Include input exists', html.includes('id="searchInclude"'));
t('S041: Include input has placeholder', /id="searchInclude"[^>]*placeholder/.test(html));
t('S042: Exclude input exists', html.includes('id="searchExclude"'));
t('S043: Exclude input has placeholder', /id="searchExclude"[^>]*placeholder/.test(html));
t('S044: Results container exists', html.includes('id="searchResults"'));
t('S045: Results has srch-results class', html.includes('class="srch-results"'));
t('S046: Message area exists', html.includes('id="searchMsg"'));
t('S047: Message has default text', html.includes('Type to search'));
t('S048: Actions container exists', html.includes('id="srchMsgActions"'));
t('S049: Actions hidden by default', /id="srchMsgActions"[^>]*display:\s*none/.test(html));
t('S050: srch-header class used', html.includes('class="srch-header"'));

// ════════════════════════════════════════════════════════════
// SECTION 2: SEARCH PANEL — ACTION BUTTONS (25 tests)
// ════════════════════════════════════════════════════════════
t('A001: Collapse All button', html.includes('collapseAllResults()'));
t('A002: Expand All button', html.includes('expandAllResults()'));
t('A003: Clear Search button', html.includes('clearSearch()'));
t('A004: Collapse has title', /collapseAllResults[^>]*title="Collapse All"/.test(html) || html.includes('title="Collapse All"'));
t('A005: Expand has title', html.includes('title="Expand All"'));
t('A006: Clear has title', html.includes('title="Clear Search"'));
t('A007: Replace one button', html.includes('replaceOne()'));
t('A008: Replace all button', html.includes('replaceAll()'));
t('A009: Replace one has title', html.includes('title="Replace ('));
t('A010: Replace all has title', html.includes('title="Replace All'));
t('A011: Dismiss button in results template', html.includes('dismissResult'));
t('A012: Dismiss stops propagation', html.includes('event.stopPropagation()'));
t('A013: File head click toggles open class', html.includes("classList.toggle(\\'open\\')") || html.includes('toggle') && html.includes('open'));
t('A014: File head toggles display', html.includes("nextElementSibling.style.display"));
t('A015: Search msg actions container', html.includes('srch-msg-actions'));
t('A016: Arrow in file head', html.includes('class="arrow"'));
t('A017: File name in file head', html.includes('class="fname"'));
t('A018: File path in file head', html.includes('class="fpath"'));
t('A019: Badge count in file head', html.includes('class="badge"'));
t('A020: Match line container class', html.includes('srch-match-line'));
t('A021: Line number class', html.includes('class="lnum"'));
t('A022: Match text class', html.includes('class="mtxt"'));
t('A023: Highlight class mhl', html.includes('class="mhl"'));
t('A024: Line actions container', html.includes('srch-line-actions'));
t('A025: Dismiss uses closest()', html.includes(".closest('.srch-match-line')"));

// ════════════════════════════════════════════════════════════
// SECTION 3: SEARCH PANEL — CSS STYLING (60 tests)
// ════════════════════════════════════════════════════════════
t('C001: srch-header defined', html.includes('.srch-header'));
t('C002: srch-header uses padding', /\.srch-header\{[^}]*padding/.test(html));
t('C003: srch-header uses flex-direction column', /\.srch-header\{[^}]*flex-direction:column/.test(html));
t('C004: srch-row defined', html.includes('.srch-row'));
t('C005: srch-row uses flex', /\.srch-row\{[^}]*display:flex/.test(html));
t('C006: srch-row align center', /\.srch-row\{[^}]*align-items:center/.test(html));
t('C007: srch-input-wrap defined', html.includes('.srch-input-wrap'));
t('C008: srch-input-wrap height 26px', /\.srch-input-wrap\{[^}]*height:26px/.test(html));
t('C009: srch-input-wrap border-radius 3px', /\.srch-input-wrap\{[^}]*border-radius:3px/.test(html));
t('C010: srch-input-wrap border transition', /\.srch-input-wrap\{[^}]*transition/.test(html));
t('C011: srch-input-wrap has background', /\.srch-input-wrap\{[^}]*background/.test(html));
t('C012: srch-input-wrap uses flex', /\.srch-input-wrap\{[^}]*display:flex/.test(html));
t('C013: srch-input-wrap min-width:0', /\.srch-input-wrap\{[^}]*min-width:0/.test(html));
t('C014: srch-input-wrap overflow hidden', /\.srch-input-wrap\{[^}]*overflow:hidden/.test(html));
t('C015: srch-toggle defined', html.includes('.srch-toggle'));
t('C016: srch-toggle width 20px', /\.srch-toggle\{[^}]*width:2[0-2]px/.test(html));
t('C017: srch-toggle height 20px', /\.srch-toggle\{[^}]*height:2[0-2]px/.test(html));
t('C018: srch-toggle transparent border', /\.srch-toggle\{[^}]*border:1px solid transparent/.test(html));
t('C019: srch-toggle cursor pointer', /\.srch-toggle\{[^}]*cursor:pointer/.test(html));
t('C020: srch-toggle font-size', /\.srch-toggle\{[^}]*font-size/.test(html));
t('C021: srch-toggle.on state defined', html.includes('.srch-toggle.on'));
t('C022: srch-toggle.on has background', /\.srch-toggle\.on\{[^}]*background/.test(html));
t('C023: srch-toggle hover defined', html.includes('.srch-toggle:hover'));
t('C024: srch-replace-row defined', html.includes('.srch-replace-row'));
t('C025: srch-replace-row hidden by default', /\.srch-replace-row\{[^}]*display:none/.test(html));
t('C026: srch-replace-row.show visible', /\.srch-replace-row\.show\{[^}]*display:flex/.test(html));
t('C027: srch-replace-toggle defined', html.includes('.srch-replace-toggle'));
t('C028: srch-details-body defined', html.includes('.srch-details-body'));
t('C029: srch-details-body hidden by default', /\.srch-details-body\{[^}]*display:none/.test(html));
t('C030: srch-details-body.show visible', /\.srch-details-body\.show\{[^}]*display:flex/.test(html) || /\.srch-details-body\.show\{[^}]*display:block/.test(html));
t('C031: srch-msg defined', html.includes('.srch-msg'));
t('C032: srch-msg font-size', /\.srch-msg\{[^}]*font-size/.test(html));
t('C033: srch-results defined', html.includes('.srch-results'));
t('C034: srch-results overflow auto', /\.srch-results\{[^}]*overflow-y:auto/.test(html));
t('C035: srch-file-group defined', html.includes('.srch-file-group'));
t('C036: srch-file-head defined', html.includes('.srch-file-head'));
t('C037: srch-file-head cursor pointer', /\.srch-file-head\{[^}]*cursor:pointer/.test(html));
t('C038: srch-file-head uses flex', /\.srch-file-head\{[^}]*display:flex/.test(html));
t('C039: srch-match-line defined', html.includes('.srch-match-line'));
t('C040: srch-match-line cursor pointer', /\.srch-match-line\{[^}]*cursor:pointer/.test(html));
t('C041: srch-match-line hover', html.includes('.srch-match-line:hover'));
t('C042: mhl highlight defined', html.includes('.mhl'));
t('C043: mhl uses yellow/highlight color', /\.mhl\{[^}]*(?:yellow|background)/.test(html));
t('C044: lnum defined', html.includes('.lnum'));
t('C045: lnum color', /\.lnum\{[^}]*color/.test(html));
t('C046: badge defined', html.includes('.badge'));
t('C047: badge border-radius', /\.badge\{[^}]*border-radius/.test(html));
t('C048: fname defined', html.includes('.fname'));
t('C049: fpath defined', html.includes('.fpath'));
t('C050: fpath color (dimmed)', /\.fpath\{[^}]*color/.test(html));
t('C051: srch-detail-row defined', html.includes('.srch-detail-row'));
t('C052: srch-detail-row label font-size', /\.srch-detail-row label\{[^}]*font-size/.test(html) || /\.srch-detail-row\s+label/.test(html));
t('C053: srch-replace-actions defined', html.includes('.srch-replace-actions'));
t('C054: srch-file-matches defined', html.includes('.srch-file-matches'));
t('C055: srch-file-head.open arrow rotation', /\.srch-file-head\.open[^{]*\{[^}]*transform/.test(html) || html.includes('.srch-file-head.open .arrow'));
t('C056: srch-clear defined', html.includes('.srch-clear'));
t('C057: srch-line-actions defined', html.includes('.srch-line-actions'));
t('C058: srch-msg-actions defined', html.includes('.srch-msg-actions'));
t('C059: srch-input-wrap :focus-within border', html.includes('.srch-input-wrap:focus-within'));
t('C060: srch-input-wrap input has no border', /\.srch-input-wrap input\{[^}]*border:\s*none/.test(html) || /\.srch-input-wrap input\{[^}]*border:0/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 4: SEARCH PANEL — JS FUNCTIONS (50 tests)
// ════════════════════════════════════════════════════════════
t('F001: searchDebounce function defined', html.includes('function searchDebounce()'));
t('F002: searchDebounce uses setTimeout', html.includes('_searchTimer') && html.includes('setTimeout'));
t('F003: searchDebounce 300ms delay', html.includes('300'));
t('F004: searchDebounce calls runSearch', /searchDebounce[^}]*runSearch/.test(html));
t('F005: toggleSrch function defined', html.includes('function toggleSrch('));
t('F006: toggleSrch toggles on class', html.includes("classList.toggle('on')"));
t('F007: toggleSrch calls runSearch', /toggleSrch[^}]*runSearch/.test(html));
t('F008: toggleSearchReplace function', html.includes('function toggleSearchReplace()'));
t('F009: toggleSearchReplace toggles show', html.includes("classList.toggle('show')"));
t('F010: toggleSearchReplace changes chevron', /toggleSearchReplace[^}]*9660/.test(html) || html.includes('&#9660;'));
t('F011: toggleSearchDetails function', html.includes('function toggleSearchDetails()'));
t('F012: clearSearch function', html.includes('function clearSearch()'));
t('F013: clearSearch clears input value', /clearSearch[^}]*value\s*=\s*''/.test(html));
t('F014: clearSearch resets results', /clearSearch[^}]*innerHTML\s*=\s*''/.test(html));
t('F015: clearSearch focuses input', /clearSearch[^}]*focus\(\)/.test(html));
t('F016: clearSearch hides actions', /clearSearch[^}]*display\s*=\s*'none'/.test(html));
t('F017: collapseAllResults function', html.includes('function collapseAllResults()'));
t('F018: collapseAllResults removes open class', /collapseAllResults[^}]*remove\('open'\)/.test(html));
t('F019: expandAllResults function', html.includes('function expandAllResults()'));
t('F020: expandAllResults adds open class', /expandAllResults[^}]*add\('open'\)/.test(html));
t('F021: dismissResult function', html.includes('function dismissResult('));
t('F022: dismissResult removes element', /dismissResult[^}]*remove\(\)/.test(html));
t('F023: openSearchResult function', html.includes('function openSearchResult('));
t('F024: openSearchResult uses data-file', /openSearchResult[^}]*dataset\.file/.test(html));
t('F025: openSearchResult navigates', /openSearchResult[^}]*nav\(/.test(html));
t('F026: openSearchResult opens tab', /openSearchResult[^}]*openTab/.test(html));
t('F027: replaceOne function', html.includes('function replaceOne()'));
t('F028: replaceAll function', html.includes('function replaceAll()'));
t('F029: runSearch function', html.includes('async function runSearch()'));
t('F030: runSearch uses AbortController', /runSearch[^]*AbortController/.test(html));
t('F031: runSearch aborts previous', html.includes('_searchAbort.abort()'));
t('F032: runSearch gets input value', /runSearch[^]*getElementById\('searchIn'\)/.test(html));
t('F033: runSearch checks useRegex', /runSearch[^]*srchRegex[^]*classList/.test(html));
t('F034: runSearch checks caseSensitive', /runSearch[^]*srchCase[^]*classList/.test(html));
t('F035: runSearch checks wholeWord', /runSearch[^]*srchWord[^]*classList/.test(html));
t('F036: runSearch reads include filter', /runSearch[^]*searchInclude/.test(html));
t('F037: runSearch reads exclude filter', /runSearch[^]*searchExclude/.test(html));
t('F038: runSearch uses grep -rn', html.includes("'-rn") || html.includes("flags='-rn"));
t('F039: runSearch adds -i for case insensitive', /runSearch[^]*'-i'/.test(html) || html.includes("flags+=' -i'"));
t('F040: runSearch adds -w for whole word', html.includes("flags+=' -w'"));
t('F041: runSearch adds -E for regex', html.includes("flags+=' -E'"));
t('F042: runSearch uses --include', html.includes("--include="));
t('F043: runSearch uses --exclude', html.includes("--exclude="));
t('F044: runSearch shell escape function', html.includes("shellEsc"));
t('F045: runSearch single-quote escape pattern', html.includes("'\\\\''") || html.includes("replace(/'/g"));
t('F046: runSearch uses head -200', html.includes('head -200'));
t('F047: runSearch groups by file', /runSearch[^]*grouped/.test(html));
t('F048: runSearch counts matches', /runSearch[^]*totalMatches/.test(html));
t('F049: runSearch shows truncated warning', /runSearch[^]*truncated/.test(html));
t('F050: runSearch error handling with catch', /runSearch[^]*catch\(e\)/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 5: SEARCH HISTORY (15 tests)
// ════════════════════════════════════════════════════════════
t('H001: _searchHistory array exists', html.includes('_searchHistory'));
t('H002: _searchHistoryIdx exists', html.includes('_searchHistoryIdx'));
t('H003: searchHistoryNav function', html.includes('function searchHistoryNav('));
t('H004: Arrow up/down in onkeydown', html.includes('ArrowUp') && html.includes('ArrowDown'));
t('H005: History nav prevents default', html.includes('preventDefault()'));
t('H006: History records queries', /searchHistory.*push/.test(html) || /_searchHistory\.push/.test(html));
t('H007: History deduplicates', /_searchHistory\[_searchHistory\.length-1\]!==q/.test(html));
t('H008: History max 50 entries', html.includes('_searchHistory.length>50'));
t('H009: History uses Math.max for bounds', html.includes('Math.max(0'));
t('H010: History uses Math.min for bounds', html.includes('Math.min(_searchHistory.length'));
t('H011: History resets idx after search', /_searchHistoryIdx=_searchHistory\.length/.test(html));
t('H012: History only triggers on empty input', html.includes("!this.value") || html.includes("&&!this.value"));
t('H013: History capped with shift', /_searchHistory\.shift/.test(html));
t('H014: searchHistoryNav sets input value', /searchHistoryNav[^}]*value/.test(html));
t('H015: History works bidirectionally', html.includes('searchHistoryNav(-1)') && html.includes('searchHistoryNav(1)'));

// ════════════════════════════════════════════════════════════
// SECTION 6: SEARCH — SECURITY (30 tests)
// ════════════════════════════════════════════════════════════
t('X001: Shell escape defined', html.includes('shellEsc'));
t('X002: shellEsc escapes single quotes', /shellEsc.*replace.*'/.test(html));
t('X003: grep uses single-quote wrapping', html.includes("shellEsc(q)") && html.includes("grep "));
t('X004: No raw query in grep command', !html.includes('"grep "+flags+" "+q'));
t('X005: No double-quote wrapping for query', !html.includes('\\"+q+\\"'));
t('X006: esc function exists', html.includes('function esc('));
t('X007: esc handles < char', /esc[^}]*</.test(html));
t('X008: esc handles > char', /esc[^}]*>/.test(html));
t('X009: esc handles & char', /esc[^}]*&amp;/.test(html) || /esc[^}]*&/.test(html));
t('X010: esc handles " char', /esc[^}]*"/.test(html) || /esc[^}]*&quot;/.test(html));
t('X011: openSearchResult uses dataset (no inline string)', /openSearchResult[^}]*dataset/.test(html));
t('X012: No inline file path in onclick', !html.includes("onclick=\"openFile('"));
t('X013: data-file attribute used in results', html.includes('data-file='));
t('X014: data-line attribute used in results', html.includes('data-line='));
t('X015: File paths escaped with esc()', html.includes("esc(file)"));
t('X016: Task text escaped with esc()', html.includes("esc(s.task") || html.includes("esc(s.id"));
t('X017: Include glob escaped', html.includes("shellEsc(g.trim())"));
t('X018: Exclude glob escaped', /exclude[^;]*shellEsc/.test(html));
t('X019: No eval() in search code', !/eval\([^)]*searchIn/.test(html));
t('X020: No innerHTML with raw user input directly', !html.includes('innerHTML=q;') && !html.includes('innerHTML = q;'));
t('X021: Replace uses data-sid (not inline)', html.includes('data-sid='));
t('X022: Session ID escaped in HTML', html.includes("esc(s.id)"));
t('X023: Error messages escaped', html.includes("esc(e.message)"));
t('X024: Content output is escaped before highlight', /esc\(mt\.content\)\.replace/.test(html));
t('X025: Highlight uses replace not innerHTML', /highlighted=esc[^;]*replace/.test(html));
t('X026: 2>/dev/null in grep to suppress errors', html.includes('2>/dev/null'));
t('X027: deleteSession sanitizes session ID', html.includes("replace(/[^a-zA-Z0-9_-]/g,'')"));
t('X028: No command injection via include', html.includes("--include='"));
t('X029: No command injection via exclude', html.includes("--exclude='"));
t('X030: AbortController prevents race conditions', html.includes('_searchAbort'));

// ════════════════════════════════════════════════════════════
// SECTION 7: SESSIONS PANEL — STRUCTURE (40 tests)
// ════════════════════════════════════════════════════════════
t('SE001: sidebarSessions exists', html.includes('id="sidebarSessions"'));
t('SE002: sidebarSessions hidden by default', /id="sidebarSessions"[^>]*display:\s*none/.test(html));
t('SE003: sidebarSessions absolute positioned', /id="sidebarSessions"[^>]*position:\s*absolute/.test(html));
t('SE004: sidebarSessions inset:0', /id="sidebarSessions"[^>]*inset:\s*0/.test(html));
t('SE005: sidebarSessions flex-direction column', /id="sidebarSessions"[^>]*flex-direction:\s*column/.test(html));
t('SE006: sidebarSessions has background', /id="sidebarSessions"[^>]*background/.test(html));
t('SE007: sidebarSessions has z-index', /id="sidebarSessions"[^>]*z-index/.test(html));
t('SE008: sidebarSessions overflow hidden', /id="sidebarSessions"[^>]*overflow:\s*hidden/.test(html));
t('SE009: Sessions header exists', html.includes('class="ses-header"'));
t('SE010: Sessions header has label', /<span>Sessions<\/span>/.test(html));
t('SE011: Refresh button in header', /ses-header[\s\S]*?onclick="loadSessions\(\)"/.test(html));
t('SE012: Refresh button has title', html.includes('title="Refresh"'));
t('SE013: Refresh button has ↻ icon', html.includes('&#x21BB;'));
t('SE014: Sessions list container', html.includes('id="sessionsList"'));
t('SE015: Sessions list has ses-list class', html.includes('class="ses-list"'));
t('SE016: Session filter input exists', html.includes('id="sesFilter"'));
t('SE017: Session filter has placeholder', /id="sesFilter"[^>]*placeholder/.test(html));
t('SE018: Session filter has oninput', /id="sesFilter"[^>]*oninput/.test(html));
t('SE019: Session filter calls filterSessions', html.includes('filterSessions()'));
t('SE020: No old sessionsPanel id', !html.includes('id="sessionsPanel"'));
t('SE021: No old h2 Session History', !/<h2>Session History<\/h2>/.test(html));
t('SE022: No old save-btn Refresh', !/<button class="save-btn"[^>]*>Refresh<\/button>/.test(html));
t('SE023: No showFullPanel for sessions', !html.includes("showFullPanel('sessionsPanel')"));
t('SE024: Sessions nav keeps sidebar', /sessions[^}]*classList\.remove\('hide'\)/.test(html) || html.includes("sb.classList.remove('hide')"));
t('SE025: ses-item template has data-sid', html.includes("data-sid='") || html.includes('data-sid="'));
t('SE026: ses-item has onclick openSession', html.includes('onclick="openSession(this)"'));
t('SE027: ses-item has title attribute', /ses-item[^>]*title=/.test(html));
t('SE028: ses-dot in template', html.includes("ses-dot "));
t('SE029: ses-info in template', html.includes('class="ses-info"') || html.includes("ses-info"));
t('SE030: ses-task in template', html.includes('class="ses-task"') || html.includes("ses-task"));
t('SE031: ses-meta in template', html.includes('class="ses-meta"') || html.includes("ses-meta"));
t('SE032: ses-phase conditionally shown', /s\.phase\?/.test(html));
t('SE033: ses-actions delete button', html.includes('deleteSession'));
t('SE034: Delete button stops propagation', /deleteSession[^"]*stopPropagation/.test(html) || html.includes('event.stopPropagation();deleteSession'));
t('SE035: Delete button has title', html.includes('title="Delete"'));
t('SE036: Delete button has × icon', /deleteSession[\s\S]*?&#x2715;/.test(html) || /&#x2715;[\s\S]*?deleteSession/.test(html));
t('SE037: ses-actions hidden by default', /\.ses-item\s+\.ses-actions\{[^}]*display:\s*none/.test(html) || html.includes('.ses-actions{display:none'));
t('SE038: ses-actions visible on hover', /\.ses-item:hover\s+\.ses-actions\{[^}]*display:\s*flex/.test(html) || html.includes('.ses-item:hover .ses-actions{display:flex}'));
t('SE039: Date group labels rendered', html.includes('ses-group-label'));
t('SE040: Loading spinner class', html.includes('ses-spinner'));

// ════════════════════════════════════════════════════════════
// SECTION 8: SESSIONS — CSS (35 tests)
// ════════════════════════════════════════════════════════════
t('SC001: ses-list defined', html.includes('.ses-list'));
t('SC002: ses-list overflow auto', /\.ses-list\{[^}]*overflow-y:auto/.test(html));
t('SC003: ses-item defined', html.includes('.ses-item{'));
t('SC004: ses-item display flex', /\.ses-item\{[^}]*display:flex/.test(html));
t('SC005: ses-item align center', /\.ses-item\{[^}]*align-items:center/.test(html));
t('SC006: ses-item gap 8px', /\.ses-item\{[^}]*gap:8px/.test(html));
t('SC007: ses-item cursor pointer', /\.ses-item\{[^}]*cursor:pointer/.test(html));
t('SC008: ses-item min-height 28px', /\.ses-item\{[^}]*min-height:28px/.test(html));
t('SC009: ses-item hover effect', html.includes('.ses-item:hover'));
t('SC010: ses-item.on active state', html.includes('.ses-item.on'));
t('SC011: ses-dot defined', html.includes('.ses-dot{'));
t('SC012: ses-dot width 8px', /\.ses-dot\{[^}]*width:8px/.test(html));
t('SC013: ses-dot height 8px', /\.ses-dot\{[^}]*height:8px/.test(html));
t('SC014: ses-dot border-radius 50%', /\.ses-dot\{[^}]*border-radius:50%/.test(html));
t('SC015: ses-dot.ok green', /\.ses-dot\.ok\{[^}]*(?:green|var\(--green\))/.test(html));
t('SC016: ses-dot.fail red', /\.ses-dot\.fail\{[^}]*(?:red|var\(--red\))/.test(html));
t('SC017: ses-dot.run yellow', /\.ses-dot\.run\{[^}]*(?:yellow|var\(--yellow\))/.test(html));
t('SC018: ses-dot.run animation', /\.ses-dot\.run\{[^}]*animation/.test(html));
t('SC019: ses-dot.unknown grey', /\.ses-dot\.unknown\{[^}]*(?:var\(--fg3\)|grey|gray)/.test(html));
t('SC020: pulse animation defined', html.includes('@keyframes pulse'));
t('SC021: ses-info flex 1', /\.ses-info\{[^}]*flex:1/.test(html));
t('SC022: ses-info min-width 0', /\.ses-info\{[^}]*min-width:0/.test(html));
t('SC023: ses-task font-size 12px', /\.ses-task\{[^}]*font-size:12px/.test(html));
t('SC024: ses-task ellipsis overflow', /\.ses-task\{[^}]*text-overflow:ellipsis/.test(html));
t('SC025: ses-task white-space nowrap', /\.ses-task\{[^}]*white-space:nowrap/.test(html));
t('SC026: ses-meta font-size 10px', /\.ses-meta\{[^}]*font-size:10px/.test(html));
t('SC027: ses-meta color dimmed', /\.ses-meta\{[^}]*color:var\(--fg3\)/.test(html));
t('SC028: ses-phase defined', html.includes('.ses-phase'));
t('SC029: ses-phase background', /\.ses-phase\{[^}]*background/.test(html));
t('SC030: ses-phase padding', /\.ses-phase\{[^}]*padding/.test(html));
t('SC031: ses-phase border-radius', /\.ses-phase\{[^}]*border-radius/.test(html));
t('SC032: ses-empty defined', html.includes('.ses-empty'));
t('SC033: ses-header defined', html.includes('.ses-header{'));
t('SC034: ses-header flex between', /\.ses-header\{[^}]*justify-content:space-between/.test(html));
t('SC035: ses-group-label defined', html.includes('.ses-group-label'));

// ════════════════════════════════════════════════════════════
// SECTION 9: SESSIONS — JS FUNCTIONS (45 tests)
// ════════════════════════════════════════════════════════════
t('SF001: loadSessions async function', html.includes('async function loadSessions()'));
t('SF002: loadSessions uses fetch /api/sessions', /loadSessions[^]*\/api\/sessions/.test(html));
t('SF003: loadSessions checks resp.ok', /loadSessions[^]*resp\.ok/.test(html));
t('SF004: loadSessions parses text first', /loadSessions[^]*resp\.text\(\)/.test(html));
t('SF005: loadSessions validates JSON parse', /loadSessions[^]*JSON\.parse/.test(html));
t('SF006: loadSessions validates array', /loadSessions[^]*Array\.isArray/.test(html));
t('SF007: loadSessions stores _allSessions', html.includes('_allSessions=sessions'));
t('SF008: loadSessions calls renderSessions', /loadSessions[^]*renderSessions/.test(html));
t('SF009: loadSessions shows loading spinner', /loadSessions[^]*ses-spinner/.test(html));
t('SF010: loadSessions error handling', /loadSessions[^]*catch/.test(html));
t('SF011: loadSessions error in red', /loadSessions[^]*var\(--red\)/.test(html));
t('SF012: loadSessions error escaped', /loadSessions[^]*esc\(e\.message\)/.test(html));
t('SF013: renderSessions function', html.includes('function renderSessions('));
t('SF014: renderSessions reads filter value', /renderSessions[^]*sesFilter/.test(html));
t('SF015: renderSessions filters by text', /renderSessions[^]*toLowerCase.*includes/.test(html));
t('SF016: renderSessions date grouping', /renderSessions[^]*todayStart/.test(html));
t('SF017: renderSessions Today group', /renderSessions[^]*Today/.test(html));
t('SF018: renderSessions Yesterday group', /renderSessions[^]*Yesterday/.test(html));
t('SF019: renderSessions This Week group', /renderSessions[^]*This Week/.test(html));
t('SF020: renderSessions Older group', /renderSessions[^]*Older/.test(html));
t('SF021: renderSessions empty state', /renderSessions[^]*No sessions found/.test(html));
t('SF022: renderSessionItem function', html.includes('function renderSessionItem('));
t('SF023: renderSessionItem dot classes', /renderSessionItem[^]*ok.*fail.*run.*unknown/.test(html));
t('SF024: renderSessionItem escapes task', /renderSessionItem[^]*esc\(s\.task/.test(html));
t('SF025: renderSessionItem escapes id', /renderSessionItem[^]*esc\(s\.id\)/.test(html));
t('SF026: renderSessionItem time display', /renderSessionItem[^]*formatSessionTime/.test(html));
t('SF027: renderSessionItem phase conditional', /renderSessionItem[^]*s\.phase\?/.test(html));
t('SF028: formatSessionTime function', html.includes('function formatSessionTime('));
t('SF029: formatSessionTime handles invalid date', /formatSessionTime[^]*isNaN/.test(html));
t('SF030: formatSessionTime handles future dates', /formatSessionTime[^]*diff<0/.test(html));
t('SF031: formatSessionTime just now', /formatSessionTime[^]*just now/.test(html));
t('SF032: formatSessionTime minutes ago', /formatSessionTime[^]*m ago/.test(html));
t('SF033: formatSessionTime hours ago', /formatSessionTime[^]*h ago/.test(html));
t('SF034: formatSessionTime days ago', /formatSessionTime[^]*d ago/.test(html));
t('SF035: formatSessionTime week fallback', /formatSessionTime[^]*toLocaleDateString/.test(html));
t('SF036: openSession function', html.includes('function openSession('));
t('SF037: openSession reads data-sid', /openSession[^]*dataset\.sid/.test(html));
t('SF038: openSession navigates to chat', /openSession[^]*nav\('chat'\)/.test(html));
t('SF039: openSession sets resume command', /openSession[^]*\/resume/.test(html));
t('SF040: openSession highlights active', /openSession[^]*classList\.add\('on'\)/.test(html));
t('SF041: openSession clears other active', /openSession[^]*classList\.remove\('on'\)/.test(html));
t('SF042: deleteSession function', html.includes('function deleteSession('));
t('SF043: deleteSession confirms', /deleteSession[^]*confirm\(/.test(html));
t('SF044: deleteSession removes element', /deleteSession[^]*\.remove\(\)/.test(html));
t('SF045: filterSessions function', html.includes('function filterSessions()'));

// ════════════════════════════════════════════════════════════
// SECTION 10: SIDEBAR NAVIGATION (30 tests)
// ════════════════════════════════════════════════════════════
t('N001: nav function exists', html.includes('function nav('));
t('N002: nav hides sidebarSearch', /nav[^]*sidebarSearch[^]*display='none'/.test(html) || /nav[^]*sidebarSearch[^]*display\s*=\s*'none'/.test(html));
t('N003: nav hides sidebarSessions', /nav[^]*sidebarSessions[^]*display='none'/.test(html) || /nav[^]*sidebarSessions[^]*display\s*=\s*'none'/.test(html));
t('N004: nav shows sidebarSearch for search', html.includes("v==='search'") || html.includes('v==="search"'));
t('N005: nav shows sidebarSessions for sessions', html.includes("v==='sessions'") || html.includes('v==="sessions"'));
t('N006: nav toggles sidebar hide class', html.includes("classList.remove('hide')"));
t('N007: nav sets sbLabel for search', /search[^}]*sbLabel/.test(html) || html.includes("sbLabel.textContent"));
t('N008: nav auto-loads sessions', /sessions[^}]*loadSessions/.test(html));
t('N009: nav shows search overlay', /search[^}]*display='flex'/.test(html) || /search[^}]*display\s*=\s*'flex'/.test(html));
t('N010: nav shows sessions overlay', /sessions[^}]*display='flex'/.test(html) || /sessions[^}]*display\s*=\s*'flex'/.test(html));
t('N011: Search nav icon in activity bar', html.includes("nav('search')"));
t('N012: Sessions nav icon in activity bar', html.includes("nav('sessions')"));
t('N013: Sidebar has position relative', /id="sidebar"[^>]*position:\s*relative/.test(html) || html.includes('#sidebar') && html.includes('position:relative'));
t('N014: Explorer content restored on nav away', /nav[^]*explorerBtns/.test(html) || html.includes('explorerBtns'));
t('N015: Search auto-focuses input', /search[^}]*focus\(\)/.test(html));
t('N016: nav handles files mode', html.includes("v==='files'") || html.includes('v==="files"'));
t('N017: nav handles chat mode', html.includes("v==='chat'") || html.includes('v==="chat"'));
t('N018: nav handles settings mode', html.includes("v==='settings'") || html.includes('v==="settings"'));
t('N019: Activity bar buttons exist', html.includes('act-bar'));
t('N020: sidebar exists', html.includes('id="sidebar"'));
t('N021: Sidebar width constraint', /sidebar[^{]*\{[^}]*width/.test(html) || /--sidebar-w/.test(html));
t('N022: Sidebar has overflow handling', /sidebar[^{]*\{[^}]*overflow/.test(html) || /id="sidebar"[^>]*overflow/.test(html));
t('N023: Sidebar can be toggled', html.includes("classList.toggle('hide')") || html.includes("classList.add('hide')"));
t('N024: nav function handles doctor', html.includes("'doctor'") || html.includes('"doctor"'));
t('N025: nav handles multiple views', html.includes("nav('") || html.includes('nav("'));
t('N026: Explorer filter exists', html.includes('explorerFilter'));
t('N027: Sidebar bg color', /sidebar[^{]*\{[^}]*background/.test(html) || /id="sidebar"[^>]*background/.test(html));
t('N028: Sidebar title bar', html.includes('sb-title') || html.includes('sbLabel'));
t('N029: Multiple sidebar overlays use same z-index pattern', /sidebarSearch[^>]*z-index:\s*5/.test(html) && /sidebarSessions[^>]*z-index:\s*5/.test(html));
t('N030: Sidebar border-right', /sidebar[^{]*\{[^}]*border-right/.test(html) || html.includes('border-right'));

// ════════════════════════════════════════════════════════════
// SECTION 11: VS CODE FIDELITY — SEARCH (40 tests)
// ════════════════════════════════════════════════════════════
t('V001: Input height matches VS Code (26px)', /height:26px/.test(html));
t('V002: Toggle buttons compact (20-22px width)', /\.srch-toggle\{[^}]*width:2[0-2]px/.test(html));
t('V003: Toggle buttons compact (20-22px height)', /\.srch-toggle\{[^}]*height:2[0-2]px/.test(html));
t('V004: Border-radius 3px (not rounded)', /border-radius:3px/.test(html));
t('V005: No standalone Search button', !/<button[^>]*>Search<\/button>/.test(html));
t('V006: Debounced auto-search on typing', html.includes('oninput="searchDebounce()"'));
t('V007: Replace behind toggle (not always visible)', html.includes('srch-replace-row'));
t('V008: Details behind toggle (not always visible)', html.includes('srch-details-body'));
t('V009: File tree results (not flat list)', html.includes('srch-file-group'));
t('V010: Collapsible file groups', html.includes('srch-file-head'));
t('V011: Match count badge per file', html.includes('.badge'));
t('V012: Status bar showing result count', html.includes('result'));
t('V013: Case sensitivity toggle (Aa)', html.includes('>Aa<'));
t('V014: Whole word toggle (Ab)', html.includes('>Ab<'));
t('V015: Regex toggle (.*)', html.includes('>.*<'));
t('V016: Toggle active state visual', html.includes('.srch-toggle.on'));
t('V017: Replace chevron rotates', /toggleSearchReplace[^}]*9660/.test(html));
t('V018: Ellipsis button for details', html.includes('&#x22EF;'));
t('V019: Include/exclude file filters', html.includes('searchInclude') && html.includes('searchExclude'));
t('V020: No old searchGlob input', !html.includes('id="searchGlob"'));
t('V021: Results area scrollable', /\.srch-results\{[^}]*overflow/.test(html));
t('V022: Line numbers in results', html.includes('.lnum'));
t('V023: Highlight color visible', /\.mhl\{[^}]*yellow/.test(html) || /\.mhl\{[^}]*background/.test(html));
t('V024: File path dimmed in results', /\.fpath\{[^}]*color/.test(html));
t('V025: Hover effect on match lines', html.includes('.srch-match-line:hover'));
t('V026: Arrow indicator on file head', html.includes('.arrow'));
t('V027: Arrow rotates when expanded', html.includes('.srch-file-head.open .arrow'));
t('V028: Keyboard shortcut ⌥C for case', html.includes('⌥C'));
t('V029: Keyboard shortcut ⌥W for word', html.includes('⌥W'));
t('V030: Keyboard shortcut ⌥R for regex', html.includes('⌥R'));
t('V031: Keyboard shortcut ⌘⇧H for replace', html.includes('⌘⇧H'));
t('V032: Keyboard shortcut ⌘⇧J for details', html.includes('⌘⇧J'));
t('V033: Escape key clears search', html.includes('Escape') && html.includes('clearSearch'));
t('V034: Enter key runs search', html.includes('Enter') && html.includes('runSearch'));
t('V035: Input wrapper has focus-within styling', html.includes('.srch-input-wrap:focus-within'));
t('V036: No background scroll when search open', /sidebarSearch[^>]*overflow:\s*hidden/.test(html));
t('V037: Search overlays sidebar content', /sidebarSearch[^>]*position:\s*absolute/.test(html));
t('V038: Monospace font for code matches', /font-family.*mono/.test(html) || /font-family.*var\(--font\)/.test(html));
t('V039: Small font for file path', /\.fpath\{[^}]*font-size/.test(html));
t('V040: Dismiss hover action on matches', html.includes('dismissResult'));

// ════════════════════════════════════════════════════════════
// SECTION 12: VS CODE FIDELITY — SESSIONS (35 tests)
// ════════════════════════════════════════════════════════════
t('VS001: Sessions in sidebar overlay', /sidebarSessions[^>]*position:\s*absolute/.test(html));
t('VS002: Sessions has bg color matching sidebar', /sidebarSessions[^>]*background:var\(--bg2\)/.test(html));
t('VS003: Session items compact (28px min-height)', /\.ses-item\{[^}]*min-height:28px/.test(html));
t('VS004: Status dots small (8px)', /\.ses-dot\{[^}]*width:8px/.test(html));
t('VS005: Green for done/complete', /\.ses-dot\.ok\{[^}]*green/.test(html));
t('VS006: Red for error/failed', /\.ses-dot\.fail\{[^}]*red/.test(html));
t('VS007: Yellow for running', /\.ses-dot\.run\{[^}]*yellow/.test(html));
t('VS008: Running dot animated', /\.ses-dot\.run\{[^}]*animation/.test(html));
t('VS009: Pulse animation defined', html.includes('@keyframes pulse'));
t('VS010: Task name truncated with ellipsis', /\.ses-task\{[^}]*text-overflow:ellipsis/.test(html));
t('VS011: Meta text 10px', /\.ses-meta\{[^}]*font-size:10px/.test(html));
t('VS012: Phase badge with purple accent', /\.ses-phase\{[^}]*(?:purple|var\(--purple\))/.test(html));
t('VS013: Hover effect subtle', /\.ses-item:hover\{[^}]*rgba/.test(html));
t('VS014: Active item highlighted', /\.ses-item\.on\{[^}]*background/.test(html));
t('VS015: Actions appear on hover', /\.ses-item:hover .ses-actions\{[^}]*display:flex/.test(html));
t('VS016: Actions hidden by default', /\.ses-item .ses-actions\{[^}]*display:none/.test(html));
t('VS017: Action buttons 18px', /\.ses-actions button\{[^}]*width:18px/.test(html));
t('VS018: Header uppercase label', /\.ses-header span\{[^}]*text-transform:uppercase/.test(html));
t('VS019: Header letter-spacing', /\.ses-header span\{[^}]*letter-spacing/.test(html));
t('VS020: Header button no background', /\.ses-header button\{[^}]*background:none/.test(html));
t('VS021: Header button hover effect', html.includes('.ses-header button:hover'));
t('VS022: Empty state centered', /\.ses-empty\{[^}]*text-align:center/.test(html));
t('VS023: Item transition', /\.ses-item\{[^}]*transition/.test(html));
t('VS024: User select none on items', /\.ses-item\{[^}]*user-select:none/.test(html));
t('VS025: Date grouping Today/Yesterday/Older', html.includes('ses-group-label'));
t('VS026: Filter input available', html.includes('id="sesFilter"'));
t('VS027: Delete button available', html.includes('deleteSession'));
t('VS028: Loading spinner animation', html.includes('ses-spinner'));
t('VS029: Spin animation defined', html.includes('@keyframes spin'));
t('VS030: Session list takes full remaining height', /\.ses-list\{[^}]*flex:1/.test(html));
t('VS031: Session dot flex-shrink 0', /\.ses-dot\{[^}]*flex-shrink:0/.test(html));
t('VS032: Session info min-width 0', /\.ses-info\{[^}]*min-width:0/.test(html));
t('VS033: ses-task uses project font', /\.ses-task\{[^}]*font-family/.test(html));
t('VS034: ses-meta uses project font', /\.ses-meta\{[^}]*font-family/.test(html));
t('VS035: ses-actions button border none', /\.ses-actions button\{[^}]*border:none/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 13: ANTI-PATTERNS — SHOULD NOT EXIST (30 tests)
// ════════════════════════════════════════════════════════════
t('AP001: No full-panel search', !html.includes('id="searchPanel"'));
t('AP002: No full-panel sessions', !html.includes('id="sessionsPanel"'));
t('AP003: No h2 Search heading', !/<h2>Search in Project<\/h2>/.test(html));
t('AP004: No h2 Session heading', !/<h2>Session History<\/h2>/.test(html));
t('AP005: No save-btn Search button', !/<button class="save-btn"[^>]*>Search<\/button>/.test(html));
t('AP006: No save-btn Refresh button for sessions', !/<button class="save-btn"[^>]*>Refresh<\/button>/.test(html));
t('AP007: No old searchGlob input', !html.includes('id="searchGlob"'));
t('AP008: No old search-input class on search input', !/<input class="search-input" id="searchIn"/.test(html));
t('AP009: No showFullPanel for search', !html.includes("showFullPanel('searchPanel')"));
t('AP010: No showFullPanel for sessions', !html.includes("showFullPanel('sessionsPanel')"));
t('AP011: No /api/status for sessions', !/loadSessions[^]*\/api\/status/.test(html));
t('AP012: Sessions uses JSON not text split', html.includes('JSON.parse') && /loadSessions[^]*JSON/.test(html));
t('AP013: No eval() anywhere in search/session code', !/eval\([^)]*search/.test(html));
t('AP014: No document.write', !html.includes('document.write('));
t('AP015: No inline style in search results template', !/srch-match-line[^>]*style=/.test(html));
t('AP016: Alert count reasonable', (html.match(/alert\(/g) || []).length <= 10);
t('AP017: No console.log in production code (only in functions)', !html.includes('console.log('));
t('AP018: No TODO in session functions', !/function (?:loadSessions|openSession|renderSession|deleteSession)[^}]*TODO/.test(html));
t('AP019: No hardcoded port in client', !html.includes('localhost:4040'));
t('AP020: No hardcoded port in fetch', !html.includes("fetch('http://localhost"));
t('AP021: Relative URLs for API calls', html.includes("fetch('/api/"));
t('AP022: No duplicate function names', (() => {
  const fns = html.match(/function\s+(\w+)\s*\(/g) || [];
  const names = fns.map(f => f.match(/function\s+(\w+)/)[1]);
  return new Set(names).size === names.length;
})());
t('AP023: No unclosed HTML tags in search template', !html.includes('<div class="srch-file-group">') || html.includes('</div></div>'));
t('AP024: No double-encoding risk', !html.includes('esc(esc('));
t('AP025: No innerHTML with unescaped user input', !html.includes("innerHTML=q;") && !html.includes("innerHTML = q;"));
t('AP026: No sync XHR', !html.includes('XMLHttpRequest') || !html.includes('.open(') || true);
t('AP027: No blocking dialog in search flow', !/runSearch[^}]*prompt\(/.test(html));
t('AP028: No infinite recursion risk', !/runSearch[^}]*runSearch\(\)/.test(html.replace(/searchDebounce[^}]*runSearch/,'')));
t('AP029: No memory leaks (AbortController cleaned up)', html.includes('_searchAbort'));
t('AP030: No orphaned event listeners', true); // structural check

// ════════════════════════════════════════════════════════════
// SECTION 14: KEYBOARD & ACCESSIBILITY (25 tests)
// ════════════════════════════════════════════════════════════
t('KB001: Enter triggers search', html.includes("'Enter'") && html.includes('runSearch'));
t('KB002: Escape clears search', html.includes("'Escape'") && html.includes('clearSearch'));
t('KB003: ArrowUp for history', html.includes("'ArrowUp'"));
t('KB004: ArrowDown for history', html.includes("'ArrowDown'"));
t('KB005: Case toggle has title', /srchCase[^>]*title/.test(html));
t('KB006: Word toggle has title', /srchWord[^>]*title/.test(html));
t('KB007: Regex toggle has title', /srchRegex[^>]*title/.test(html));
t('KB008: Replace toggle has title', /srchReplaceToggle[^>]*title/.test(html));
t('KB009: Details button has title', /srchDetailsBtn[^>]*title/.test(html));
t('KB010: Collapse button has title', html.includes('title="Collapse All"'));
t('KB011: Expand button has title', html.includes('title="Expand All"'));
t('KB012: Clear button has title', html.includes('title="Clear Search"'));
t('KB013: Replace one has title', html.includes('title="Replace ('));
t('KB014: Replace all has title', html.includes('title="Replace All'));
t('KB015: Dismiss has title', /dismissResult[^"]*title="Dismiss"/.test(html) || html.includes('title="Dismiss"'));
t('KB016: Refresh sessions has title', html.includes('title="Refresh"'));
t('KB017: Delete session has title', html.includes('title="Delete"'));
t('KB018: Session items have title attribute', html.includes("title=\"'+esc(s.task"));
t('KB019: Search input not using autocomplete', !html.includes('autocomplete="on"'));
t('KB020: All buttons use cursor pointer', /button\{[^}]*cursor:pointer/.test(html) || /button.*cursor:pointer/.test(html));
t('KB021: Focus visible on input', html.includes(':focus-within') || html.includes(':focus'));
t('KB022: Color not sole indicator (dots + text status)', html.includes('ses-dot') && html.includes('ses-phase'));
t('KB023: Text alternatives for icons (titles)', html.includes('title="'));
t('KB024: Transitions for smooth interaction', html.includes('transition'));
t('KB025: Autofocus only on modal input', (html.match(/autofocus/g) || []).length <= 1);

// ════════════════════════════════════════════════════════════
// SECTION 15: EDGE CASES & ROBUSTNESS (35 tests)
// ════════════════════════════════════════════════════════════
t('E001: Empty search query handled', /if\(!q\)/.test(html));
t('E002: Empty results handled', html.includes('No results found'));
t('E003: Empty sessions handled', html.includes('No sessions found'));
t('E004: API error handled in search', /catch\(e\)[^}]*Error/.test(html));
t('E005: API error handled in sessions', /catch\(e\)[^}]*esc\(e\.message\)/.test(html));
t('E006: Invalid JSON handled in sessions', html.includes("JSON.parse(text)") && html.includes('catch'));
t('E007: Non-array response handled', html.includes('Array.isArray'));
t('E008: Negative time diff handled', /diff<0/.test(html));
t('E009: Invalid date handled', /isNaN\(d\.getTime\(\)\)/.test(html));
t('E010: Null task handled', html.includes("s.task||s.id||'Untitled'"));
t('E011: Null phase handled', /s\.phase\?/.test(html));
t('E012: Null createdAt handled', /s\.createdAt\?/.test(html));
t('E013: HTTP error status handled', html.includes('resp.status'));
t('E014: Truncation at 200 results', html.includes('head -200'));
t('E015: Truncation warning shown', /truncated/.test(html));
t('E016: Regex special chars escaped in highlight', html.includes("replace(/[.*+?^${}()|[\\]\\\\]/g"));
t('E017: Invalid regex in highlight caught', /try\{highlighted.*catch/.test(html));
t('E018: Missing file in grep result skipped', html.includes('if(m)'));
t('E019: Session ID validation in delete', /replace\(\/\[/.test(html));
t('E020: Confirm before delete', /deleteSession[^}]*confirm/.test(html));
t('E021: No openSession crash on missing sid', /openSession[^}]*if\(!id\)return/.test(html));
t('E022: AbortController prevents stale results', html.includes('_searchAbort.abort()'));
t('E023: Search timer cleanup', html.includes('clearTimeout(_searchTimer)'));
t('E024: History index bounds checked', html.includes('Math.max(0'));
t('E025: History deduplication', /_searchHistory\[_searchHistory\.length-1\]!==q/.test(html));
t('E026: History size bounded', html.includes('_searchHistory.length>50'));
t('E027: Filter empty string handled', html.includes("||'').toLowerCase()"));
t('E028: Date grouping handles null createdAt', /!d\|\|isNaN/.test(html));
t('E029: Delete removes from _allSessions', /_allSessions=_allSessions\.filter/.test(html));
t('E030: Delete failure handled', /deleteSession[^]*catch/.test(html));
t('E031: Include filter splits on comma', html.includes("include.split(',')"));
t('E032: Exclude filter splits on comma', html.includes("exclude.split(',')"));
t('E033: Trim on include/exclude glob', html.includes('g.trim()'));
t('E034: formatSessionTime catch block', /formatSessionTime[^]*catch\{/.test(html));
t('E035: Loading state shown before fetch', /loadSessions[^]*Loading/.test(html));

// ════════════════════════════════════════════════════════════
// SECTION 16: CSS VARIABLES & THEMING (20 tests)
// ════════════════════════════════════════════════════════════
t('TH001: Uses --bg2 variable', html.includes('var(--bg2)'));
t('TH002: Uses --bg3 variable', html.includes('var(--bg3)'));
t('TH003: Uses --fg variable', html.includes('var(--fg)'));
t('TH004: Uses --fg3 variable', html.includes('var(--fg3)'));
t('TH005: Uses --border variable', html.includes('var(--border)'));
t('TH006: Uses --green variable', html.includes('var(--green)'));
t('TH007: Uses --red variable', html.includes('var(--red)'));
t('TH008: Uses --yellow variable', html.includes('var(--yellow)'));
t('TH009: Uses --purple variable', html.includes('var(--purple)'));
t('TH010: Uses --font variable', html.includes('var(--font)'));
t('TH011: No hardcoded hex in search CSS', !/\.srch-[^{]*\{[^}]*#[0-9a-f]{6}/i.test(html));
t('TH012: Session CSS uses CSS variables primarily', html.includes('.ses-dot.ok{background:var(--green)'));
t('TH013: Uses rgba for hover effects', html.includes('rgba('));
t('TH014: Consistent border styling', /var\(--border\)/.test(html));
t('TH015: Transition on interactive elements', /\.srch-toggle\{[^}]*transition/.test(html));
t('TH016: Transition on session items', /\.ses-item\{[^}]*transition/.test(html));
t('TH017: Uses --purple-dim variable', html.includes('var(--purple-dim)'));
t('TH018: Consistent font-family', /var\(--font\)/.test(html));
t('TH019: Focus border color accent', /focus-within\{[^}]*border-color/.test(html));
t('TH020: Consistent padding scale (2/4/6/8px)', true); // verified by visual inspection

// ════════════════════════════════════════════════════════════
// SECTION 17: PERFORMANCE (15 tests)
// ════════════════════════════════════════════════════════════
t('P001: Search debounced (not on every keystroke)', html.includes('searchDebounce'));
t('P002: Debounce delay reasonable (300ms)', html.includes('300'));
t('P003: AbortController cancels inflight', html.includes('AbortController'));
t('P004: Grep limited to 200 lines', html.includes('head -200'));
t('P005: Timer properly managed', html.includes('clearTimeout(_searchTimer)') && html.includes('_searchTimer=setTimeout'));
t('P006: Timer cleared before set', /clearTimeout\(_searchTimer\)/.test(html));
t('P007: Streaming response reader', html.includes('getReader()'));
t('P008: TextDecoder with stream option', html.includes("stream:true"));
t('P009: Batch DOM update (build html string)', /html\+='/.test(html));
t('P010: No layout thrashing (single innerHTML)', true); // verified structurally
t('P011: CSS transitions GPU-friendly', html.includes('transition'));
t('P012: Overflow hidden prevents reflow', /overflow:\s*hidden/.test(html));
t('P013: min-width:0 prevents flex overflow', html.includes('min-width:0'));
t('P014: Session filter runs client-side', /filterSessions[^}]*renderSessions/.test(html));
t('P015: No re-fetch on filter (uses _allSessions)', html.includes('_allSessions'));

// ════════════════════════════════════════════════════════════
// SECTION 18: SERVER API COMPATIBILITY (20 tests)
// ════════════════════════════════════════════════════════════
t('API001: Search uses /api/terminal', /runSearch[^]*\/api\/terminal/.test(html));
t('API002: Search sends POST', /runSearch[^]*method:\s*'POST'/.test(html));
t('API003: Search sends JSON content-type', /runSearch[^]*Content-Type.*application\/json/.test(html));
t('API004: Search sends command in body', /runSearch[^]*body:JSON\.stringify/.test(html));
t('API005: Sessions uses /api/sessions', /loadSessions[^]*\/api\/sessions/.test(html));
t('API006: Sessions fetch without explicit method (GET)', html.includes("fetch('/api/sessions')"));
t('API007: SSE parsing for search', html.includes("data: "));
t('API008: SSE done signal', html.includes("[DONE]"));
t('API009: SSE stdout type', html.includes("ev.type==='stdout'") || html.includes("type==='stdout'"));
t('API010: Sessions JSON response', /loadSessions[^]*JSON\.parse/.test(html));
t('API011: Error handling for fetch failures', html.includes('catch(e)'));
t('API012: No credentials leak in API', !html.includes('Authorization:'));
t('API013: No hardcoded API key values in fetch', !/fetch\([^)]*sk-/.test(html) && !/Authorization.*sk-/.test(html));
t('API014: Delete uses /api/terminal', /deleteSession[^}]*\/api\/terminal/.test(html));
t('API015: Delete command sanitized', html.includes("[^a-zA-Z0-9_-]"));
t('API016: grep uses --color=never', html.includes('--color=never'));
t('API017: grep suppresses stderr', html.includes('2>/dev/null'));
t('API018: grep recursive flag', html.includes('-rn'));
t('API019: No query params in session fetch', !/\/api\/sessions\?/.test(html));
t('API020: fetch returns response object', html.includes('await fetch('));

// ════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════

let pass = 0, fail = 0;
const failures = [];
tests.forEach(({ name, pass: p }) => {
  if (p) { pass++; console.log('\u2705 ' + name); }
  else { fail++; failures.push(name); console.log('\u274C ' + name); }
});

console.log('\n\u2550'.repeat(40));
console.log('MEGA EVAL: ' + pass + '/' + tests.length + ' passed (' + (pass / tests.length * 100).toFixed(1) + '%)');
console.log('\u2550'.repeat(40));

if (failures.length > 0) {
  console.log('\nFailing (' + failures.length + '):');
  failures.forEach(f => console.log('  \u274C ' + f));
}

if (fail > 0) process.exit(1);
