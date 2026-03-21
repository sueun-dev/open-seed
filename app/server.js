/**
 * agent40 desktop app — web server with SSE streaming.
 *
 * Features:
 * - Real-time streaming via Server-Sent Events
 * - Structured tool call display
 * - Session management
 * - Doctor/Comments/Status endpoints
 *
 * Usage: node app/server.js [--port 4040] [--cwd /path/to/project]
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const args = process.argv.slice(2);
const PORT = parseInt(args.find((a, i) => args[i - 1] === "--port") || process.env.PORT || "4040", 10);
const APP_DIR = __dirname;
const PROJECT_DIR = path.join(APP_DIR, "..");

// Resolve the absolute path to the node binary so spawn() works in .app bundles
// (macOS .app sandboxed environment doesn't inherit PATH from login shell)
const NODE_BIN = process.execPath;

// Fix PATH for .app bundles — inherit login shell's PATH so child processes
// can find node, npm, claude, python3, git, etc.
try {
  const { execSync } = require("node:child_process");
  const shellPath = execSync("/bin/zsh -lc 'echo $PATH' 2>/dev/null", { encoding: "utf8" }).trim();
  if (shellPath) {
    process.env.PATH = shellPath;
  }
  // Also resolve claude CLI path explicitly
  const claudePath = execSync("/bin/zsh -lc 'which claude' 2>/dev/null", { encoding: "utf8" }).trim();
  if (claudePath && require("node:fs").existsSync(claudePath)) {
    process.env.CLAUDE_BIN = claudePath;
  }
} catch {}

// ═══ Workspace Management ═══
// Global settings dir (not per-workspace)
const GLOBAL_SETTINGS_DIR = path.join(require("os").homedir(), ".openseed");
const WORKSPACE_HISTORY_PATH = path.join(GLOBAL_SETTINGS_DIR, "workspaces.json");
if (!fs.existsSync(GLOBAL_SETTINGS_DIR)) fs.mkdirSync(GLOBAL_SETTINGS_DIR, { recursive: true });

// CWD is mutable — changes when user opens a folder
let CWD = args.find((a, i) => args[i - 1] === "--cwd") || null;

// Try to restore last workspace from saved history
if (!CWD || CWD === require("os").homedir()) {
  try {
    const hist = JSON.parse(fs.readFileSync(WORKSPACE_HISTORY_PATH, "utf8"));
    if (hist.lastOpened && fs.existsSync(hist.lastOpened)) {
      CWD = hist.lastOpened;
    }
  } catch {}
}

// If still nothing, start with no workspace (null = welcome screen)
if (!CWD || !fs.existsSync(CWD)) CWD = null;

function saveWorkspaceHistory(dir) {
  try {
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(WORKSPACE_HISTORY_PATH, "utf8")); } catch {}
    hist.lastOpened = dir;
    const recent = hist.recent || [];
    const idx = recent.indexOf(dir);
    if (idx !== -1) recent.splice(idx, 1);
    recent.unshift(dir);
    hist.recent = recent.slice(0, 20);
    fs.writeFileSync(WORKSPACE_HISTORY_PATH, JSON.stringify(hist, null, 2), "utf8");
  } catch {}
}

// ═══ User Profile & Autonomous AGI State ═══
// These are per-workspace, so use functions to resolve paths
function getUserProfilePath() { return CWD ? path.join(CWD, ".agent", "user-profile.json") : path.join(GLOBAL_SETTINGS_DIR, "user-profile.json"); }
function getAutoAgiStatePath() { return CWD ? path.join(CWD, ".agent", "auto-agi-state.json") : null; }
function getTaskQueuePath() { return CWD ? path.join(CWD, ".agent", "task-queue.json") : null; }

function loadJson(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function saveJson(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

// User profile: learns from interactions
function getUserProfile() {
  return loadJson(getUserProfilePath(), {
    preferences: {},
    patterns: [],
    recentTasks: [],
    codebaseKnowledge: {},
    techStack: [],
    workingHours: [],
    totalSessions: 0,
    lastActive: null,
  });
}
function updateUserProfile(update) {
  const profile = getUserProfile();
  Object.assign(profile, update);
  profile.lastActive = new Date().toISOString();
  saveJson(getUserProfilePath(), profile);
  return profile;
}

// Codebase mapping (Aider-style) — build repo understanding
function buildRepoMap(dir) {
  const map = { files: [], dirs: [], languages: {}, entryPoints: [], configs: [], totalFiles: 0, totalLines: 0 };
  const ignore = new Set([".git", "node_modules", "dist", ".agent", "coverage", ".next", "__pycache__", ".research", "release"]);
  const langMap = { ".ts": "TypeScript", ".tsx": "TypeScript/React", ".js": "JavaScript", ".jsx": "JavaScript/React", ".py": "Python", ".rs": "Rust", ".go": "Go", ".swift": "Swift", ".html": "HTML", ".css": "CSS", ".json": "JSON", ".md": "Markdown" };
  const configFiles = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml", ".env", "Dockerfile", "docker-compose.yml"];

  function walk(d, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (ignore.has(e.name) || e.name.startsWith(".")) continue;
        const full = path.join(d, e.name);
        const rel = path.relative(dir, full);
        if (e.isDirectory()) {
          map.dirs.push(rel);
          walk(full, depth + 1);
        } else {
          map.files.push(rel);
          map.totalFiles++;
          const ext = path.extname(e.name).toLowerCase();
          const lang = langMap[ext];
          if (lang) map.languages[lang] = (map.languages[lang] || 0) + 1;
          if (configFiles.includes(e.name)) map.configs.push(rel);
          if (e.name === "index.ts" || e.name === "main.ts" || e.name === "app.ts" || e.name === "index.js" || e.name === "main.js") {
            map.entryPoints.push(rel);
          }
          try { map.totalLines += fs.readFileSync(full, "utf8").split("\n").length; } catch {}
        }
      }
    } catch {}
  }
  walk(dir);
  return map;
}

// Autonomous AGI: persistent task queue
function getTaskQueue() { const p = getTaskQueuePath(); return p ? loadJson(p, { tasks: [], completed: [], active: null }) : { tasks: [], completed: [], active: null }; }
function saveTaskQueue(q) { const p = getTaskQueuePath(); if (p) saveJson(p, q); }

// Auto AGI state
let autoAgiRunning = false;
let autoAgiAbort = false;

// ── Active child process tracking (for session liveness) ──
// Maps child PID → { childCwd, startedAt }
const _activeChildren = new Map();

// SSE clients listening for session status changes
const _sessionSSEClients = new Set();

function cleanupDeadSession(childPid, childCwd, exitCode) {
  _activeChildren.delete(childPid);
  // Find and update any session file still marked "running" with this PID
  try {
    const sessDir = path.join(childCwd, ".agent", "sessions");
    if (!fs.existsSync(sessDir)) return;
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".json") && !f.includes(".tmp"));
    for (const f of files) {
      try {
        const fp = path.join(sessDir, f);
        const data = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (data.status === "running" && data.pid === childPid) {
          data.status = exitCode === 0 ? "completed" : "failed";
          data.phase = exitCode === 0 ? "done" : "crashed";
          data.updatedAt = new Date().toISOString();
          fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
          // Notify all SSE clients
          broadcastSessionUpdate(data);
        }
      } catch {}
    }
  } catch {}
}

function broadcastSessionUpdate(session) {
  const payload = JSON.stringify({ type: "session.update", id: session.id, status: session.status, phase: session.phase || "" });
  for (const client of _sessionSSEClients) {
    try { client.write(`data: ${payload}\n\n`); } catch { _sessionSSEClients.delete(client); }
  }
}

function safePath(userPath) {
  if (!CWD) return null;
  const abs = require("node:path").resolve(CWD, userPath);
  if (abs !== CWD && !abs.startsWith(CWD + require("node:path").sep)) return null;
  return abs;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  try {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── SSE Streaming Run ──
  if (url.pathname === "/api/run/stream" && req.method === "POST") {
    const body = await readBody(req);
    const { task, mode, projectDir, activeFile, activeFileContent, selection, openTabs, provider: reqProvider, model: reqModel } = safeJsonParse(body) || {};

    // If projectDir is specified, use workspace/{projectDir} as CWD
    // This isolates generated apps from the agent's own code
    let childCwd = CWD;
    if (projectDir) {
      const workspaceRoot = path.join(CWD, "workspace");
      childCwd = path.join(workspaceRoot, projectDir);
      if (!fs.existsSync(childCwd)) {
        fs.mkdirSync(childCwd, { recursive: true });
      }
      // Copy agent config to workspace so engine has provider settings
      // Always overwrite to ensure timeouts are 0 (unlimited)
      const srcConfig = path.join(CWD, ".agent", "config.json");
      const dstConfigDir = path.join(childCwd, ".agent");
      const dstConfig = path.join(dstConfigDir, "config.json");
      if (fs.existsSync(srcConfig)) {
        if (!fs.existsSync(dstConfigDir)) fs.mkdirSync(dstConfigDir, { recursive: true });
        try {
          const cfg = JSON.parse(fs.readFileSync(srcConfig, "utf8"));
          // Force all provider timeouts to 0 (unlimited)
          for (const p of ["openai", "anthropic", "gemini"]) {
            if (cfg.providers?.[p]) cfg.providers[p].timeoutMs = 0;
          }
          fs.writeFileSync(dstConfig, JSON.stringify(cfg, null, 2), "utf8");
        } catch {
          fs.copyFileSync(srcConfig, dstConfig);
        }
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    // Inject project instructions + active file context into the task prompt
    let enrichedTask = task;
    // Read project instructions (same candidates as /api/ask)
    const runInstrCandidates = [".openseed/instructions.md", ".openseed/rules.md", ".openseedrules", ".cursorrules", ".windsurfrules", "CLAUDE.md", ".github/copilot-instructions.md"];
    for (const cand of runInstrCandidates) {
      try {
        const ip = path.join(childCwd, cand);
        if (fs.existsSync(ip) && fs.statSync(ip).isFile()) {
          enrichedTask = `[Project Instructions]\n${fs.readFileSync(ip, "utf8").slice(0, 4000)}\n\n${enrichedTask}`;
          break;
        }
      } catch {}
    }
    // Global instructions
    try {
      const gip = path.join(GLOBAL_SETTINGS_DIR, "instructions.md");
      if (fs.existsSync(gip)) {
        const gi = fs.readFileSync(gip, "utf8").slice(0, 2000);
        if (gi.trim()) enrichedTask = `[Global Instructions]\n${gi}\n\n${enrichedTask}`;
      }
    } catch {}
    if (activeFile) {
      let ctx = `\n\n[Context] The user is currently viewing: ${activeFile}`;
      if (selection) ctx += `\n[Selection]:\n\`\`\`\n${selection.slice(0, 2000)}\n\`\`\``;
      if (activeFileContent && activeFileContent.length < 8000) ctx += `\n[Active file content]:\n\`\`\`\n${activeFileContent}\n\`\`\``;
      if (openTabs?.length > 1) ctx += `\n[Open tabs]: ${openTabs.filter(p=>p!==activeFile).join(", ")}`;
      enrichedTask = enrichedTask + ctx;
    }

    const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
    // Pass model selection via env vars so the agent CLI picks them up
    const childEnv = { ...process.env };
    if (reqProvider) childEnv.OPENSEED_PROVIDER = reqProvider;
    if (reqModel) childEnv.OPENSEED_MODEL = reqModel;
    const child = spawn(NODE_BIN, [agentCli, mode || "run", enrichedTask], {
      cwd: childCwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    // Track this child for session liveness
    _activeChildren.set(child.pid, { childCwd, startedAt: Date.now() });

    let lineBuffer = "";

    const sendEvent = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent("status", { status: "started", task, mode: mode || "run" });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      lineBuffer += text;

      // Parse structured event lines
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Try to parse as session event
        const parsed = parseEventLine(trimmed);
        if (parsed) {
          // Filter noisy events: provider.stream (LLM token chunks),
          // provider.retry, tool.stream — these are too frequent for UI cards
          const noisy = ["provider.stream", "provider.retry", "tool.stream"];
          if (noisy.includes(parsed.eventType)) {
            // Send as lightweight "llm" event instead of full event card
            const chunk = parsed.payload?.chunk || parsed.payload?.delta || "";
            if (chunk) {
              sendEvent("llm", { text: typeof chunk === "string" ? chunk : "" });
            }
            continue;
          }
          sendEvent("event", parsed);
        } else {
          sendEvent("stdout", { text: trimmed });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      sendEvent("stderr", { text: chunk.toString() });
    });

    child.on("close", (code) => {
      if (lineBuffer.trim()) {
        sendEvent("stdout", { text: lineBuffer.trim() });
      }
      sendEvent("status", { status: "completed", exitCode: code });
      res.write("data: [DONE]\n\n");
      res.end();
      // Clean up session status for dead process
      cleanupDeadSession(child.pid, childCwd, code);
    });

    child.on("error", (err) => {
      sendEvent("error", { message: err.message });
      res.write("data: [DONE]\n\n");
      res.end();
      cleanupDeadSession(child.pid, childCwd, 1);
    });

    req.on("close", () => {
      child.kill("SIGTERM");
      // Client disconnected — process will be killed, clean up after a moment
      setTimeout(() => cleanupDeadSession(child.pid, childCwd, 130), 1000);
    });

    return;
  }

  // ── Chat conversation memory (per workspace) ──
  if (!global._chatHistory) global._chatHistory = [];

  // ── Question mode: direct LLM call without pipeline ──
  if (url.pathname === "/api/ask" && req.method === "POST") {
    const body = await readBody(req);
    const { question, activeFile, activeFileContent, selection, openTabs, provider: reqProvider, model: reqModel } = safeJsonParse(body) || {};

    // ══════════════════════════════════════════════════════
    // CONTEXT ENGINE — 5 tiers, budget-aware, import-aware
    // Better than Codex/Claude/Cursor: follows imports,
    // searches by question keywords, includes git diff,
    // remembers conversation, smart-chunks large files.
    // ══════════════════════════════════════════════════════
    const fileContents = [];
    let totalCtxLen = 0;
    const CTX_BUDGET = 32000;
    const seen = new Set();

    function safeRead(relPath) {
      try { return require("node:fs").readFileSync(require("node:path").join(CWD, relPath), "utf8"); } catch { return null; }
    }
    function addCtx(label, relPath, content, maxLen) {
      if (seen.has(relPath) || !content || totalCtxLen >= CTX_BUDGET) return false;
      seen.add(relPath);
      // Smart chunking: for large files, extract relevant portion around question keywords
      let c = content;
      if (c.length > maxLen) {
        const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (keywords.length > 0) {
          const lines = c.split("\n");
          const scores = lines.map((line, i) => {
            const ll = line.toLowerCase();
            return { i, score: keywords.reduce((s, k) => s + (ll.includes(k) ? 1 : 0), 0) };
          });
          const best = scores.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
          if (best.length > 0) {
            // Extract window around best matches
            const windows = new Set();
            for (const b of best.slice(0, 5)) {
              for (let j = Math.max(0, b.i - 15); j < Math.min(lines.length, b.i + 15); j++) windows.add(j);
            }
            const sortedIdx = [...windows].sort((a, b) => a - b);
            const chunks = [];
            let prev = -2;
            for (const idx of sortedIdx) {
              if (idx !== prev + 1 && chunks.length > 0) chunks.push("  // ... (truncated) ...");
              chunks.push(`${idx + 1}| ${lines[idx]}`);
              prev = idx;
            }
            c = chunks.join("\n");
          } else {
            c = c.slice(0, maxLen) + "\n// ... (truncated, " + content.length + " chars total) ...";
          }
        } else {
          c = c.slice(0, maxLen) + "\n// ... (truncated, " + content.length + " chars total) ...";
        }
      }
      fileContents.push(`--- ${relPath} (${label}) ---\n${c}`);
      totalCtxLen += c.length;
      return true;
    }

    // ── TIER 1: Active file (highest priority) ──
    if (activeFile) {
      const content = activeFileContent || safeRead(activeFile) || "";
      addCtx("ACTIVE — currently viewing", activeFile, content, 15000);

      // ── TIER 2: Import graph traversal ──
      // Follow imports/requires from active file to include dependencies
      const importPaths = [];
      const importRe = /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
      let im;
      while ((im = importRe.exec(content)) !== null) {
        const raw = im[1] || im[2];
        if (raw.startsWith(".")) {
          const dir = require("node:path").dirname(activeFile);
          let resolved = require("node:path").join(dir, raw);
          // Try common extensions
          for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".json"]) {
            const full = resolved + ext;
            if (require("node:fs").existsSync(require("node:path").join(CWD, full))) {
              importPaths.push(full);
              break;
            }
            // Try index file
            const idx = require("node:path").join(resolved, "index" + ext);
            if (ext && require("node:fs").existsSync(require("node:path").join(CWD, idx))) {
              importPaths.push(idx);
              break;
            }
          }
        }
      }
      for (const imp of importPaths.slice(0, 4)) {
        if (totalCtxLen >= CTX_BUDGET) break;
        const c = safeRead(imp);
        if (c) addCtx("imported by active file", imp, c, 6000);
      }
    }

    // ── TIER 3: Selection context ──
    // (handled in system prompt, not as file content)

    // ── TIER 4: Open tabs ──
    const tabsToRead = (openTabs || []).filter(p => p !== activeFile).slice(0, 6);
    for (const f of tabsToRead) {
      if (totalCtxLen >= CTX_BUDGET) break;
      const c = safeRead(f);
      if (c) addCtx("open tab", f, c, 6000);
    }

    // ── TIER 5: Question-aware file search ──
    // Extract potential file names, function names, class names from question
    const repoFiles = [];
    try {
      const walk = (dir, depth = 0) => {
        if (depth > 3) return;
        const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if ([".git", "node_modules", "dist", ".agent", "coverage", ".next", ".cache"].includes(e.name)) continue;
          const full = require("node:path").join(dir, e.name);
          const rel = require("node:path").relative(CWD, full);
          if (e.isDirectory()) walk(full, depth + 1);
          else repoFiles.push(rel);
        }
      };
      walk(CWD);
    } catch {}

    // Search for files mentioned in the question
    const qLower = question.toLowerCase();
    const mentionedFiles = repoFiles.filter(f => {
      const name = f.split("/").pop().toLowerCase();
      return qLower.includes(name.replace(/\.[^.]+$/, "")) && name.length > 3;
    });
    for (const f of mentionedFiles.slice(0, 3)) {
      if (totalCtxLen >= CTX_BUDGET) break;
      const c = safeRead(f);
      if (c) addCtx("mentioned in question", f, c, 4000);
    }

    // ── TIER 5b: @-mention parsing ──
    // Parse @file:path, @symbol:name, @folder:path, @line:N from the question
    const atFileRe = /@file:([^\s]+)/g;
    const atSymRe = /@symbol:([^\s]+)/g;
    const atFolderRe = /@folder:([^\s]+)/g;
    let atm;
    while ((atm = atFileRe.exec(question)) !== null) {
      if (totalCtxLen >= CTX_BUDGET) break;
      const c = safeRead(atm[1]);
      if (c) addCtx("@file mention", atm[1], c, 8000);
    }
    while ((atm = atSymRe.exec(question)) !== null) {
      if (totalCtxLen >= CTX_BUDGET) break;
      const sym = atm[1];
      // Grep for symbol definition across codebase
      try {
        const { execSync } = require("node:child_process");
        const grepResult = execSync(
          `grep -rnl "\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" --include="*.py" --include="*.go" --include="*.rs" . 2>/dev/null | head -5`,
          { cwd: CWD, encoding: "utf8", timeout: 3000 }
        );
        for (const gf of grepResult.trim().split("\n").filter(Boolean)) {
          if (totalCtxLen >= CTX_BUDGET) break;
          const rel = gf.replace(/^\.\//, "");
          const c = safeRead(rel);
          if (c) addCtx(`@symbol:${sym}`, rel, c, 4000);
        }
      } catch {}
    }
    while ((atm = atFolderRe.exec(question)) !== null) {
      if (totalCtxLen >= CTX_BUDGET) break;
      const folder = atm[1];
      const folderFiles = repoFiles.filter(f => f.startsWith(folder + "/") || f.startsWith(folder));
      for (const ff of folderFiles.slice(0, 5)) {
        if (totalCtxLen >= CTX_BUDGET) break;
        const c = safeRead(ff);
        if (c) addCtx(`@folder:${folder}`, ff, c, 3000);
      }
    }

    // ── TIER 5c: Content grep search ──
    // Extract keywords from question and grep for them in the codebase
    // This fills the biggest gap vs Cursor/Windsurf (they have semantic search, we do keyword grep)
    if (totalCtxLen < CTX_BUDGET) {
      const keywords = question.split(/\s+/)
        .filter(w => w.length > 4 && !/^(what|where|when|which|does|this|that|have|from|with|about|should|could|would|their|there|these|those|after|before|between|during|into)$/i.test(w))
        .map(w => w.replace(/[^a-zA-Z0-9_]/g, ""))
        .filter(w => w.length > 4)
        .slice(0, 3);
      if (keywords.length > 0) {
        try {
          const { execSync } = require("node:child_process");
          const pattern = keywords.join("|");
          const grepFiles = execSync(
            `grep -rlE "${pattern}" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" --include="*.json" --include="*.py" --include="*.go" . 2>/dev/null | head -5`,
            { cwd: CWD, encoding: "utf8", timeout: 5000 }
          );
          for (const gf of grepFiles.trim().split("\n").filter(Boolean)) {
            if (totalCtxLen >= CTX_BUDGET) break;
            const rel = gf.replace(/^\.\//, "");
            const c = safeRead(rel);
            if (c) addCtx("content grep match", rel, c, 4000);
          }
        } catch {}
      }
    }

    // ── TIER 5d: Test-file linkage ──
    // If viewing a source file, include its test file (and vice versa)
    if (activeFile && totalCtxLen < CTX_BUDGET) {
      const base = require("node:path").basename(activeFile).replace(/\.[^.]+$/, "");
      const dir = require("node:path").dirname(activeFile);
      const isTest = /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(activeFile);
      if (isTest) {
        // Viewing test → find source
        const srcName = base.replace(/\.(test|spec)$/, "");
        const candidates = [`${dir}/${srcName}.ts`, `${dir}/${srcName}.tsx`, `${dir}/${srcName}.js`];
        for (const cand of candidates) {
          const c = safeRead(cand);
          if (c) { addCtx("source for test", cand, c, 6000); break; }
        }
      } else {
        // Viewing source → find test
        const testPatterns = [
          `${dir}/${base}.test.ts`, `${dir}/${base}.spec.ts`,
          `${dir}/${base}.test.js`, `${dir}/${base}.spec.js`,
          `${dir}/__tests__/${base}.ts`, `${dir}/__tests__/${base}.js`,
          `test/${base}.test.ts`, `tests/${base}.test.ts`,
        ];
        for (const tp of testPatterns) {
          const c = safeRead(tp);
          if (c) { addCtx("test file for source", tp, c, 4000); break; }
        }
      }
    }

    // ── TIER 6: Git diff (recent changes awareness) ──
    try {
      const { execSync } = require("node:child_process");
      const diff = execSync("git diff --stat HEAD~3..HEAD 2>/dev/null || true", { cwd: CWD, encoding: "utf8", timeout: 3000 });
      if (diff.trim()) {
        fileContents.push(`--- git diff --stat (last 3 commits) ---\n${diff.slice(0, 2000)}`);
        totalCtxLen += Math.min(diff.length, 2000);
      }
      // Include actual diff for active file if modified
      if (activeFile) {
        const fileDiff = execSync(`git diff HEAD -- "${activeFile}" 2>/dev/null || true`, { cwd: CWD, encoding: "utf8", timeout: 3000 });
        if (fileDiff.trim() && fileDiff.length < 3000) {
          fileContents.push(`--- git diff for ${activeFile} (uncommitted changes) ---\n${fileDiff}`);
          totalCtxLen += fileDiff.length;
        }
      }
    } catch {}

    // ── Fallback: if no active file, read key project files ──
    if (!activeFile && fileContents.length === 0) {
      const keyFiles = ["package.json", "README.md", "tsconfig.json", ...repoFiles.filter(f => !f.includes("/")).slice(0, 5)];
      for (const f of keyFiles) {
        if (totalCtxLen >= CTX_BUDGET) break;
        const c = safeRead(f);
        if (c) addCtx("project file", f, c, 3000);
      }
    }

    // ── TIER 0: Project instructions (.openseed, .openseedrules, etc.) ──
    // These are the highest priority — user-defined rules that override everything.
    // Searches: workspace-level then global-level, first found wins per tier.
    let projectInstructions = "";
    const instrCandidates = [
      // Workspace-level (project-specific)
      ".openseed/instructions.md",
      ".openseed/rules.md",
      ".openseedrules",
      ".cursorrules",
      ".windsurfrules",
      "CLAUDE.md",
      ".github/copilot-instructions.md",
    ];
    for (const cand of instrCandidates) {
      try {
        const instrPath = require("node:path").join(CWD, cand);
        if (require("node:fs").existsSync(instrPath)) {
          const stat = require("node:fs").statSync(instrPath);
          if (stat.isFile()) {
            projectInstructions += require("node:fs").readFileSync(instrPath, "utf8").slice(0, 4000) + "\n";
            break; // Use first found workspace-level instruction file
          }
        }
      } catch {}
    }
    // Global-level (user-wide defaults, additive)
    try {
      const globalInstrPath = require("node:path").join(GLOBAL_SETTINGS_DIR, "instructions.md");
      if (require("node:fs").existsSync(globalInstrPath)) {
        const globalInstr = require("node:fs").readFileSync(globalInstrPath, "utf8").slice(0, 2000);
        if (globalInstr.trim()) projectInstructions = globalInstr + "\n" + projectInstructions;
      }
    } catch {}

    // ── Build system prompt ──
    const contextLines = [`Working directory: ${CWD}`];
    if (activeFile) contextLines.push(`Active file: ${activeFile}`);
    if (selection) contextLines.push(`User's selected code:\n\`\`\`\n${selection.slice(0, 2000)}\n\`\`\``);
    if (openTabs?.length) contextLines.push(`Open tabs: ${openTabs.join(", ")}`);
    contextLines.push(`Project structure (${repoFiles.length} files): ${repoFiles.slice(0, 50).join(", ")}`);

    // Conversation history (last 6 messages for continuity)
    if (global._chatHistory.length > 0) {
      contextLines.push("\nRecent conversation:");
      for (const msg of global._chatHistory.slice(-6)) {
        contextLines.push(`${msg.role}: ${msg.text.slice(0, 500)}`);
      }
    }

    // Read recent session info
    try {
      const sessDir = require("node:path").join(CWD, ".agent", "sessions");
      const sessions = require("node:fs").readdirSync(sessDir).filter(f => f.endsWith(".json")).sort().slice(-3);
      for (const s of sessions) {
        const data = JSON.parse(require("node:fs").readFileSync(require("node:path").join(sessDir, s), "utf8"));
        contextLines.push(`Recent session: ${data.task || "unknown"} → ${data.status || "unknown"}`);
      }
    } catch {}

    const systemPrompt = `You are Open Seed, an intelligent coding assistant embedded in an IDE. You understand the user's intent by analyzing what they're currently looking at.
${projectInstructions ? `\nPROJECT INSTRUCTIONS (follow these rules strictly):\n${projectInstructions}\n` : ""}
CONTEXT PRIORITY:
1. Active file — the file currently open in the editor. This is your primary reference.
2. Imported files — dependencies of the active file, included for deeper understanding.
3. Selected code — if the user highlighted code, focus your answer on that specific code.
4. Open tabs — other files the user has been working on recently.
5. Mentioned files — files whose names appear in the user's question.
6. Git changes — recent modifications for awareness of what's in flux.
7. Project structure — for broader navigation questions.

RULES:
- If the question relates to the active file or selection, answer about THAT specifically.
- If the question is about a different part of the project, use the broader context.
- Reference exact file paths and line numbers when possible.
- Be concise. No filler. Code-first answers.
- If you need more context to answer well, say which file you'd need to see.

${contextLines.join("\n")}`;

    // Save to conversation memory
    global._chatHistory.push({ role: "user", text: question, ts: Date.now() });
    // Trim old history (keep last 20)
    if (global._chatHistory.length > 20) global._chatHistory = global._chatHistory.slice(-20);

    // Simple approach: use the provider directly via a tiny inline script
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const sendEvent = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    sendEvent("status", { status: "started", mode: "question" });

    const userPrompt = question + "\n\nFile contents:\n" + fileContents.join("\n\n");

    // Use node to call the provider
    const child = spawn(NODE_BIN, ["-e", `
      const { ProviderRegistry } = require("${PROJECT_DIR}/dist/providers/registry.js");
      const { loadConfig } = require("${PROJECT_DIR}/dist/core/config.js");
      (async () => {
        const config = await loadConfig("${CWD.replace(/"/g, '\\"')}");
        const registry = new ProviderRegistry();
        const resp = await registry.invokeWithFailover(config, ${JSON.stringify(reqProvider || "openai")}, {
          role: "researcher",
          category: "research",
          systemPrompt: ${JSON.stringify(systemPrompt)},
          prompt: ${JSON.stringify(userPrompt)},
          responseFormat: "text",
          model: ${JSON.stringify(reqModel || undefined)}
        });
        process.stdout.write(resp.text);
      })().catch(e => { process.stderr.write(e.message); process.exit(1); });
    `], {
      cwd: CWD,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let answer = "";
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      answer += text;
      sendEvent("llm", { text });
    });
    child.stderr.on("data", chunk => {
      sendEvent("stderr", { text: chunk.toString() });
    });
    child.on("close", code => {
      // Save assistant response to conversation memory
      if (answer.trim()) global._chatHistory.push({ role: "assistant", text: answer.slice(0, 1000), ts: Date.now() });
      sendEvent("status", { status: "completed", exitCode: code, answer });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    child.on("error", err => {
      sendEvent("error", { message: err.message });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    req.on("close", () => child.kill("SIGTERM"));
    return;
  }

  // ── AGI Pipeline (server-orchestrated) ──
  if (url.pathname === "/api/agi/run" && req.method === "POST") {
    const body = await readBody(req);
    const { task, targetDir } = safeJsonParse(body) || {};
    if (!task) { res.writeHead(400); res.end("Missing task"); return; }

    // Workspace setup — targetDir can be absolute path or relative to CWD
    let childCwd = CWD;
    let projName = path.basename(CWD);
    if (targetDir) {
      // If absolute path, use directly; otherwise join with CWD
      childCwd = path.isAbsolute(targetDir) ? targetDir : path.join(CWD, targetDir);
      projName = path.basename(childCwd);
      if (!fs.existsSync(childCwd)) fs.mkdirSync(childCwd, { recursive: true });
    }

    // Copy config with unlimited timeouts
    const srcConfig = path.join(CWD, ".agent", "config.json");
    const dstConfigDir = path.join(childCwd, ".agent");
    const dstConfig = path.join(dstConfigDir, "config.json");
    if (fs.existsSync(srcConfig)) {
      if (!fs.existsSync(dstConfigDir)) fs.mkdirSync(dstConfigDir, { recursive: true });
      try {
        const cfg = JSON.parse(fs.readFileSync(srcConfig, "utf8"));
        for (const p of ["openai", "anthropic", "gemini"]) {
          if (cfg.providers?.[p]) cfg.providers[p].timeoutMs = 0;
        }
        fs.writeFileSync(dstConfig, JSON.stringify(cfg, null, 2), "utf8");
      } catch { if (fs.existsSync(srcConfig)) fs.copyFileSync(srcConfig, dstConfig); }
    }

    // Clean leftover .agent/ artifacts from previous AGI runs to prevent confusion
    const prevAgentDir = path.join(childCwd, ".agent");
    if (fs.existsSync(prevAgentDir)) {
      try { fs.rmSync(prevAgentDir, { recursive: true, force: true }); } catch {}
    }

    // Write AGENTS.md — will be rewritten per step to match step type
    const agentsMd = path.join(childCwd, "AGENTS.md");
    function writeStepAgentsMd(stepType) {
      try {
        if (stepType === "analyze" || stepType === "design" || stepType === "debate") {
          fs.writeFileSync(agentsMd, `# AGI Pipeline — Analysis/Design Phase

## CRITICAL RULES
1. You are in an ANALYSIS/DESIGN phase. DO NOT write any files.
2. Your job is to THINK, PLAN, and OUTPUT TEXT — not create files.
3. DO NOT use the write tool. DO NOT use apply_patch. DO NOT use multi_patch.
4. If you feel the urge to create files, STOP. That is for the BUILD phase.
5. Use read, glob, grep, bash (inspection only) to understand the current state.
6. Output your analysis/design as TEXT in your response.
7. Be specific: list every file that needs to be created, with exact purpose.
8. The BUILD step will follow your plan — make it detailed enough to follow.
`, "utf8");
        } else {
          fs.writeFileSync(agentsMd, `# AGI Pipeline — Build/Execute Phase

## CRITICAL RULES
1. You are building a REAL, RUNNABLE APPLICATION — not writing architecture documents.
2. Write actual application source code (HTML, JS, Python, etc.), NOT JSON exports or design docs.
3. Every file you write must contain REAL, EXECUTABLE code — no module.exports of design objects.
4. The end result must be something a user can RUN (e.g. \`npm start\`, \`python app.py\`, open index.html).
5. Write COMPLETE file content — no placeholders, no TODOs, no "..." ellipsis.
6. Check what exists first (glob/ls), then build from there.
7. If the directory is empty: create everything from scratch.
8. If files exist: work with them.
9. Use \`bash\` tool to run npm install, tests, builds — verify your work.
10. Do NOT keep reading the same file over and over. Read once, then act.
`, "utf8");
        }
      } catch {}
    }
    writeStepAgentsMd("build"); // default

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const sendAgi = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
    };

    let aborted = false;
    req.on("close", () => { aborted = true; });

    // Assess complexity
    const words = task.split(/\s+/).length;
    const dirFiles = fs.readdirSync(childCwd).filter(f => !f.startsWith(".") && f !== "node_modules");
    const isFullApp = /full.*app|complete.*project|entire.*system|from.*scratch|만들어|생성|구현|개발해|빌드|게임|앱|사이트|서비스|플랫폼|시스템|웹|서버|클라이언트|온라인|멀티플레이어|shooting|game|server|website|platform/i.test(task);
    const isSimple = !isFullApp && /fix.*bug|rename|add.*comment|update.*version|change.*color|수정|고쳐|바꿔/i.test(task);
    const needsDebate = /architect|design|pattern|approach|strategy|tradeoff|choose|select|compare|migrate|아키텍처|설계/i.test(task);
    let complexity = "moderate";
    if (isSimple && words < 20) complexity = "simple";
    else if (isFullApp || words > 100 || dirFiles.length === 0) complexity = "complex";
    else if (words > 40) complexity = "complex";

    // Generate dynamic plan
    const steps = [];
    let stepNum = 0;
    const mkId = (t) => `step-${++stepNum}-${t}`;

    // Always: analyze
    steps.push({ id: mkId("analyze"), type: "analyze", title: "Analyze & Understand", mode: "run", maxTurns: 30, maxRetries: 1, useStrategyBranching: false });

    // Conditional: debate
    if (needsDebate && complexity !== "simple") {
      steps.push({ id: mkId("debate"), type: "debate", title: "Multi-Agent Design Debate", mode: "team", maxTurns: 50, maxRetries: 0, useStrategyBranching: false });
    }

    // Conditional: design
    if (complexity !== "simple") {
      steps.push({ id: mkId("design"), type: "design", title: "Architecture & Design", mode: "run", maxTurns: 40, maxRetries: 1, useStrategyBranching: false });
    }

    // Always: build — give it LOTS of turns for complex apps
    const buildTurns = complexity === "complex" ? 500 : complexity === "moderate" ? 300 : 150;
    steps.push({ id: mkId("build"), type: "build", title: "Build & Implement", mode: "team", maxTurns: buildTurns, maxRetries: 2, useStrategyBranching: true });

    // Always: verify
    steps.push({ id: mkId("verify"), type: "verify", title: "Verify & Test", mode: "run", maxTurns: 50, maxRetries: 0, useStrategyBranching: false });

    // Fix is dynamically inserted on verify failure

    // Conditional: improve
    if (complexity !== "simple") {
      steps.push({ id: mkId("improve"), type: "improve", title: "Improve & Harden", mode: "team", maxTurns: 80, maxRetries: 1, useStrategyBranching: false });
    }

    // Always: review
    steps.push({ id: mkId("review"), type: "review", title: "Final Review", mode: complexity === "simple" ? "run" : "team", maxTurns: 40, maxRetries: 0, useStrategyBranching: false });

    sendAgi("agi.pipeline.start", { plan: { steps }, complexity, projectDir: projName, totalSteps: steps.length });

    // Build codebase map for context (Aider-style)
    const repoMap = buildRepoMap(childCwd);
    const userProfile = getUserProfile();

    // Track task in user profile
    userProfile.recentTasks = [...(userProfile.recentTasks || []).slice(-20), task];
    updateUserProfile(userProfile);

    // Shared context — passed between steps
    const ctx = {
      task,
      projectDir: projName,
      stepResults: [],
      allFiles: [],
      errorLog: [],
      decisions: [],
      totalTokens: 0,
      repoMap,
      userProfile,
    };

    // Build step prompt with full inter-step memory
    function buildStepPrompt(step) {
      const sections = [];
      sections.push(`# AGI Pipeline — ${step.title}`);
      sections.push(`## Original Task (NEVER FORGET THIS)\n**"${task}"**\nEverything you do must serve this task. If you find yourself writing design documents instead of application code, STOP and refocus on the task.`);

      // [FIX #2, #4] Inter-step memory: ALL prior results with FULL content — no truncation
      if (ctx.stepResults.length > 0) {
        sections.push(`## Prior Step Results (${ctx.stepResults.length} completed)`);
        for (const r of ctx.stepResults) {
          const icon = r.status === "completed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP";
          // Full summary — no truncation
          sections.push(`### [${icon}] ${r.type.toUpperCase()}\n${r.summary || ""}`);
          if (r.changes && r.changes.length) sections.push(`Files changed:\n${r.changes.map(c => `- ${c}`).join("\n")}`);
          if (r.errors && r.errors.length) sections.push(`Errors:\n${r.errors.map(e => `- ${e}`).join("\n")}`);
          // [FIX #6] Include tool results with full output for context
          if (r.toolResults && r.toolResults.length > 0) {
            const toolSummary = r.toolResults.map(t => {
              let s = `- [${t.ok ? "OK" : "FAIL"}] ${t.name}`;
              if (t.output?.path) s += `: ${t.output.path}`;
              if (t.fullStdout) s += `\n  stdout: ${t.fullStdout}`;
              if (t.fullStderr) s += `\n  stderr: ${t.fullStderr}`;
              return s;
            }).join("\n");
            sections.push(`Tool Results:\n${toolSummary}`);
          }
        }
      }

      // [FIX #5] Architecture decisions — full text, no truncation
      if (ctx.decisions.length) sections.push(`## Architecture Decisions\n${ctx.decisions.map((d,i) => `${i+1}. ${d}`).join("\n")}`);
      if (ctx.allFiles.length) sections.push(`## Project Files\n${ctx.allFiles.map(f => `- ${f}`).join("\n")}`);

      const unresolved = ctx.errorLog.filter(e => !e.resolved);
      if (unresolved.length) sections.push(`## Unresolved Errors\n${unresolved.map(e => `- [${e.category}] ${e.error}`).join("\n")}`);

      // Inject structured analysis for downstream steps (design, build, verify)
      if (ctx.analysis && step.type !== "analyze") {
        const a = ctx.analysis;
        const parts = [`## Structured Analysis (from ANALYZE step)`];

        if (a.intent) {
          parts.push(`**Intent**: ${a.intent.type} (${a.intent.confidence} confidence)\n${a.intent.rationale}`);
        }
        if (a.codebaseState) {
          parts.push(`**Codebase State**: ${a.codebaseState}`);
        }
        if (a.techStack) {
          const ts = a.techStack;
          parts.push(`**Tech Stack**:\n- Language: ${ts.language}\n- Runtime: ${ts.runtime}\n- Framework: ${ts.framework}\n- Frontend: ${ts.frontend || "N/A"}\n- Realtime: ${ts.realtime || "N/A"}\n- Database: ${ts.database || "N/A"}\n- Package Manager: ${ts.packageManager}\n- Test Framework: ${ts.testFramework || "N/A"}\n- Justification: ${ts.justification}`);
        }
        if (a.features && a.features.length) {
          parts.push(`**Features** (${a.features.length}):\n${a.features.map(f => `- [${f.priority}] ${f.id}: ${f.name} — ${f.description}`).join("\n")}`);
        }
        if (a.scope) {
          parts.push(`**Scope**:\n- IN: ${(a.scope.in || []).join(", ")}\n- OUT: ${(a.scope.out || []).join(", ")}\n- Assumptions: ${(a.scope.assumptions || []).join(", ")}`);
        }
        if (a.risks && a.risks.length) {
          parts.push(`**Risks**:\n${a.risks.map(r => `- [${r.severity}] ${r.risk} → Mitigation: ${r.mitigation}`).join("\n")}`);
        }
        if (a.acceptanceCriteria && a.acceptanceCriteria.length) {
          parts.push(`**Acceptance Criteria**:\n${a.acceptanceCriteria.map(ac => `- ${ac.id}: ${ac.criterion} → \`${ac.command}\` → Expected: ${ac.expectedResult}`).join("\n")}`);
        }
        if (a.directives) {
          if (a.directives.mustDo?.length) parts.push(`**MUST DO**:\n${a.directives.mustDo.map(d => `- ${d}`).join("\n")}`);
          if (a.directives.mustNotDo?.length) parts.push(`**MUST NOT DO**:\n${a.directives.mustNotDo.map(d => `- ${d}`).join("\n")}`);
        }
        if (a.edgeCases && a.edgeCases.length) {
          parts.push(`**Edge Cases**:\n${a.edgeCases.map(ec => `- ${ec.id} [${ec.severity}] (${ec.feature}): ${ec.scenario} → ${ec.expectedBehavior}`).join("\n")}`);
        }
        if (a.slopGuardrails) {
          const sg = a.slopGuardrails;
          const warnings = [];
          if (sg.scopeInflationRisk !== "low") warnings.push(`Scope inflation: ${sg.scopeInflationRisk}`);
          if (sg.prematureAbstractionRisk !== "low") warnings.push(`Premature abstraction: ${sg.prematureAbstractionRisk}`);
          if (sg.overValidationRisk !== "low") warnings.push(`Over-validation: ${sg.overValidationRisk}`);
          if (sg.docBloatRisk !== "low") warnings.push(`Doc bloat: ${sg.docBloatRisk}`);
          if (warnings.length) parts.push(`**AI-Slop Guardrails** (WATCH OUT):\n${warnings.map(w => `- ⚠ ${w}`).join("\n")}${sg.specificWarnings?.length ? "\n" + sg.specificWarnings.map(w => `- ${w}`).join("\n") : ""}`);
        }
        if (a.gapAnalysis) {
          const ga = a.gapAnalysis;
          if (ga.implicitRequirements?.length) parts.push(`**Implicit Requirements** (discovered by gap analysis):\n${ga.implicitRequirements.map(r => `- ${r}`).join("\n")}`);
          if (ga.featureDependencies?.length) parts.push(`**Feature Dependencies**:\n${ga.featureDependencies.map(d => `- ${d}`).join("\n")}`);
        }
        if (a.decisionDrivers && a.decisionDrivers.length) {
          parts.push(`**Decision Drivers** (FOLLOW THESE):\n${a.decisionDrivers.map(dd => `- ${dd.id}: ${dd.principle} — ${dd.rationale} (tradeoff: ${dd.tradeoff})`).join("\n")}`);
        }
        if (a.complexity) {
          parts.push(`**Complexity**: ${a.complexity.level} — ~${a.complexity.estimatedFiles} files, ~${a.complexity.estimatedLines} lines\n- Critical path: ${a.complexity.criticalPath}`);
        }
        if (a.triage) {
          parts.push(`**Triage**: ${a.triage.level} — ${a.triage.rationale}`);
        }

        sections.push(parts.join("\n\n"));
      }

      // Step-type instructions
      sections.push(`## Your Task: ${step.title}`);
      sections.push(getStepInstructions(step.type));

      // Codebase context (Aider-style repo understanding)
      if (ctx.repoMap && ctx.repoMap.totalFiles > 0) {
        sections.push(`## Codebase Map\n- ${ctx.repoMap.totalFiles} files, ${ctx.repoMap.totalLines} lines\n- Languages: ${Object.entries(ctx.repoMap.languages).map(([l,c]) => `${l}(${c})`).join(", ")}\n- Entry points: ${ctx.repoMap.entryPoints.slice(0, 5).join(", ")}`);
      }

      // User context for personalization
      if (ctx.userProfile && ctx.userProfile.techStack && ctx.userProfile.techStack.length > 0) {
        sections.push(`## User Preferences\nPreferred tech: ${ctx.userProfile.techStack.join(", ")}`);
      }

      // Project state — let LLM see what's actually there
      const currentFiles = fs.readdirSync(childCwd).filter(f => !f.startsWith(".") && f !== "node_modules");
      if (currentFiles.length === 0) {
        sections.push(`## Project State\nThe working directory is EMPTY — no files exist yet.`);
      } else {
        sections.push(`## Project State\nWorking directory contains: ${currentFiles.join(", ")}`);
      }

      // Universal build rules
      if (step.type === "build") {
        const buildRules = [`\n## MANDATORY BUILD RULES
- Write files DIRECTLY in the current working directory — no wrapper folders.
- Write EVERY file with COMPLETE, EXECUTABLE code. No placeholders, no TODOs.
- If package.json doesn't exist, create it first with ALL deps and a "start" script.
- Run \`npm install\` after creating package.json.
- The result MUST be runnable with \`npm start\` or equivalent.
- REMINDER: You are building "${task}" — write the ACTUAL APPLICATION CODE for this, not design documents.`];

        // Inject AI-Slop guardrails from analysis into build step
        if (ctx.analysis?.slopGuardrails) {
          const sg = ctx.analysis.slopGuardrails;
          buildRules.push(`\n## AI-SLOP PREVENTION (from analysis)
DO NOT fall into these traps:`);
          if (sg.scopeInflationRisk !== "low") buildRules.push(`- **SCOPE INFLATION** (${sg.scopeInflationRisk} risk): Build ONLY what was specified. No "while we're at it" additions.`);
          if (sg.prematureAbstractionRisk !== "low") buildRules.push(`- **PREMATURE ABSTRACTION** (${sg.prematureAbstractionRisk} risk): Don't extract utilities/base classes for one-time code. Inline is fine.`);
          if (sg.overValidationRisk !== "low") buildRules.push(`- **OVER-VALIDATION** (${sg.overValidationRisk} risk): Validate at system boundaries only. Trust internal code.`);
          if (sg.docBloatRisk !== "low") buildRules.push(`- **DOC BLOAT** (${sg.docBloatRisk} risk): No JSDoc on every function. Only document non-obvious logic.`);
          if (sg.specificWarnings?.length) {
            for (const w of sg.specificWarnings) buildRules.push(`- ${w}`);
          }
        }

        sections.push(buildRules.join("\n"));
      }

      // Enforce no-write for analysis steps
      if (step.type === "analyze" || step.type === "design" || step.type === "debate") {
        sections.push(`\n## TOOL RESTRICTION
You MUST NOT use the write, apply_patch, or multi_patch tools in this step.
Only use: read, glob, grep, bash (for inspection only), repo_map, lsp_diagnostics, session_history.
If you write any file in this step, it will corrupt the pipeline. Analysis/design output goes in your TEXT response only.`);
      }

      return sections.join("\n\n");
    }

    function getStepInstructions(type) {
      const m = {
        analyze: `## RULES FOR THIS STEP
- You are in ANALYSIS ONLY mode. **DO NOT use the write, apply_patch, or multi_patch tools.**
- If you use any write tool in this step, the pipeline will fail.
- Your ONLY job is to THINK, UNDERSTAND, and OUTPUT structured analysis as TEXT.

## PROCESS (follow this EXACTLY)

### Step 0: COMPLEXITY TRIAGE (do this FIRST)
Before deep analysis, assess complexity to choose the right depth:

| Level | Signals | Action |
|-------|---------|--------|
| **trivial** | Single file, <10 lines, obvious fix (typo, rename, color change) | Minimal JSON: intent + 1 feature + 1 AC. Skip tech stack, risks, pre-mortem. |
| **simple** | 1-2 files, clear scope, <30 min work | Lightweight: intent + features + AC + directives. Skip pre-mortem, edge cases. |
| **moderate** | 3-5 files, multiple components | Full analysis: all steps below. |
| **complex** | 6+ files, architectural impact, multi-system | Full analysis + extra edge cases + detailed pre-mortem. |

Output the triage level in JSON. For trivial/simple tasks, you may skip steps marked (MODERATE+).

### Step 0.5: PRE-COMMITMENT PREDICTION (MODERATE+)
BEFORE you begin deep analysis, predict 3-5 likely challenges for this task.
Write them down NOW, before reading code or exploring. This prevents confirmation bias.

For each prediction:
- **What might go wrong**: anticipated challenge
- **Why you think so**: reasoning from the task description alone
- **How to check**: what to look for during analysis

After completing your analysis, you MUST revisit these predictions in the gapAnalysis.predictionCheck field.
Did your predictions match reality? What surprised you?

### Step 1: INTENT CLASSIFICATION
Classify what the user is asking for.

**Verbalize your reasoning**: "I detect [type] intent because [reason]. My approach: [strategy]."

Intent types:
| Type | Signals | Strategy |
|------|---------|----------|
| **greenfield-build** | Empty workspace + "만들어/create/build" | Full stack selection, architecture design, file manifest |
| **feature-add** | Existing code + "추가/add/implement" | Pattern discovery, integration points, scope boundaries |
| **bug-fix** | Error messages, "수정/fix/broken" | Root cause analysis, minimal change scope |
| **refactoring** | "리팩토링/refactor/improve/clean" | Pre-refactor verification plan, behavior preservation |
| **migration** | "마이그레이션/migrate/upgrade/convert" | Compatibility analysis, rollback strategy |
| **architecture** | "설계/architect/design/pattern" | Strategic analysis, option comparison, trade-offs |
| **research** | "조사/investigate/how does/explain" | Investigation plan, exit criteria, synthesis format |

### Step 2: CODEBASE ASSESSMENT
Use glob, bash ls, read to understand the workspace.

Classify the codebase:
- **Greenfield**: Empty or only config files → best practices, full stack selection
- **Disciplined**: Clear patterns, tests, CI → follow existing patterns strictly
- **Transitional**: Mixed quality, some tests → propose gradual improvements
- **Legacy**: No tests, inconsistent patterns → propose stabilization first

For existing projects, detect:
- Languages & frameworks (from package.json, pyproject.toml, go.mod, etc.)
- Test infrastructure (test framework, coverage, CI)
- Build system (bundler, compiler, scripts)
- Entry points (main files, scripts, routes)
- Patterns worth following (file naming, import style, error handling)

**PRE-EXPLORATION RULE**: For feature-add/bug-fix/refactoring on existing codebases, EXPLORE the relevant code FIRST before proceeding. Understand existing patterns so you don't invent new ones when good ones already exist.

### Step 3: TECH STACK SELECTION (greenfield only)
For greenfield builds, select and JUSTIFY every technology choice:
- **Language**: Why this language for this task?
- **Runtime**: Node.js / Bun / Deno / Python / etc.
- **Framework**: Express / Fastify / Next.js / etc. — why?
- **Frontend**: React / Vue / Vanilla / Canvas / etc. — why?
- **Realtime** (if needed): WebSocket / Socket.IO / SSE — why?
- **Database** (if needed): SQLite / PostgreSQL / Redis / in-memory — why?
- **Package manager**: npm / pnpm / yarn / bun
- **Test framework**: vitest / jest / pytest / none — why?

RULE: Choose the SIMPLEST stack that fulfills requirements. Do NOT over-engineer.
RULE: Prefer battle-tested, well-documented libraries over cutting-edge.

### Step 4: REQUIREMENTS EXTRACTION
Extract ALL requirements from the user's request. Think beyond what's literally stated.

For each feature:
- **ID**: F1, F2, F3...
- **Name**: Short descriptive name
- **Priority**: must-have / nice-to-have
- **Description**: What it does (1-2 sentences)
- **User story**: As a [user], I want [action] so that [benefit]

### Step 5: SCOPE BOUNDARIES
Define what IS and IS NOT in scope. This prevents scope creep.

- **IN scope**: [explicit list of what will be built]
- **OUT of scope**: [explicit list of what will NOT be built]
- **Assumptions**: [things you're assuming to be true]
- **Constraints**: [technical or business limitations]

### Step 6: RISK ANALYSIS & PRE-MORTEM (MODERATE+)
Identify what could go wrong BEFORE it happens.

For each risk:
- **Risk**: What could go wrong?
- **Severity**: high / medium / low
- **Likelihood**: high / medium / low
- **Mitigation**: How to prevent or handle it

Pre-mortem exercise: "Imagine this project failed. Why did it fail?"
List the top 3 failure scenarios and how the plan addresses each.

### Step 7: EDGE CASE IDENTIFICATION (MODERATE+)
Systematically enumerate edge cases for each feature. Think about:
- **Input boundaries**: empty input, max length, special characters, unicode, zero/negative values
- **State transitions**: concurrent access, race conditions, interrupted operations
- **Environment**: offline, slow network, missing dependencies, disk full
- **User behavior**: rapid clicks, back button, refresh during operation, multiple tabs

For each edge case:
- **ID**: EC1, EC2...
- **feature**: Which feature it affects (F1, F2...)
- **scenario**: What happens
- **expectedBehavior**: What SHOULD happen (graceful degradation, error message, etc.)
- **severity**: critical / moderate / minor

### Step 8: ACCEPTANCE CRITERIA
Define executable verification criteria — how do we KNOW it's done?

**ZERO USER INTERVENTION PRINCIPLE**: ALL acceptance criteria MUST be executable by agents, not humans.
- MUST: Write criteria as executable commands (curl, npm test, playwright actions, bash scripts)
- MUST: Include exact expected outputs, not vague descriptions
- MUST NOT: Create criteria requiring "user manually tests..." or "user visually confirms..."

Examples:
- GOOD: "curl http://localhost:3000/api/health → HTTP 200, body contains {\\"status\\":\\"ok\\"}"
- GOOD: "npm test → all tests pass, exit code 0"
- GOOD: "node -e 'fetch(\\"http://localhost:3000\\").then(r=>console.log(r.status))' → prints 200"
- BAD: "The application works correctly"
- BAD: "Users can play the game"
- BAD: "Manually open browser and verify the UI looks good"

### Step 9: DIRECTIVES FOR DOWNSTREAM STEPS
Based on your analysis, provide explicit instructions for the DESIGN and BUILD steps.

- **MUST DO**: [critical requirements that MUST be implemented]
- **MUST NOT DO**: [anti-patterns, scope creep, things to avoid]
- **PATTERNS TO FOLLOW**: [existing codebase patterns to follow, if any]
- **TOOLS TO USE**: [specific tools/commands for verification]

### Step 10: AI-SLOP DETECTION GUARDRAILS
Flag and prevent these common AI-generated code anti-patterns:

| Anti-pattern | Signal | Correct Action |
|-------------|--------|----------------|
| **Scope inflation** | "Also add tests for adjacent modules", "While we're at it..." | Stick to EXACTLY what was requested. Nothing more. |
| **Premature abstraction** | "Extract to utility", "Create a base class for..." | Inline is fine for one-time use. 3 similar lines > 1 premature abstraction. |
| **Over-validation** | "15 error checks for 3 inputs", "validate every edge case" | Validate at boundaries only. Trust internal code. |
| **Documentation bloat** | "Add JSDoc to every function", "Create README with..." | Only document non-obvious logic. No boilerplate docs. |

You MUST include slopGuardrails in your JSON output listing which patterns are most likely for THIS task.

### Step 11: GAP ANALYSIS — "WHAT'S MISSING?"
Before outputting, do a final self-check:

1. Re-read the original task. Does your analysis fully address it?
2. Are there implicit requirements you missed? (error handling, loading states, responsive design, i18n...)
3. Are there dependencies between features that aren't captured?
4. Is there anything the BUILD step would need to ask about? If so, resolve it NOW.
5. Does every feature have at least one acceptance criterion?
6. Does every risk have a mitigation?

List any gaps found and how you resolved them in the "gapAnalysis" JSON field.
Also compare your pre-commitment predictions (Step 0.5) against your actual findings.

### Step 12: DECISION DRIVERS (MODERATE+)
Identify the top 3 decision drivers that should guide the BUILD step.
These are the principles that, if violated, would make the project fail.

For each:
- **ID**: DD1, DD2, DD3
- **principle**: The guiding rule (e.g., "All game state must be server-authoritative")
- **rationale**: Why this matters for THIS specific task
- **tradeoff**: What you're sacrificing by following this principle

### Step 13: SELF-REVIEW (MANDATORY)
Before outputting your final JSON, review it against this checklist:

1. ☐ Does every feature have a user story?
2. ☐ Does every feature have at least one acceptance criterion?
3. ☐ Are ALL acceptance criteria agent-executable commands (no "manually test")?
4. ☐ Does every risk have a mitigation?
5. ☐ Is the tech stack justified for THIS task (not just defaults)?
6. ☐ Are scope.out items explicit enough to prevent scope creep?
7. ☐ Do edge cases cover input boundaries, state transitions, and environment issues?
8. ☐ Are slopGuardrails specific to THIS task (not generic)?
9. ☐ Did you check your pre-commitment predictions against reality?

If ANY check fails, FIX IT before outputting. Do not output incomplete analysis.

### Step 14: COMPLEXITY ESTIMATION
Provide honest estimates:
- **Complexity**: simple / moderate / complex / very-complex
- **Estimated files**: How many files to create/modify
- **Estimated total lines**: Rough line count
- **Estimated build waves**: How many parallel groups of work
- **Critical path**: What must be done sequentially

## OUTPUT FORMAT

You MUST output your analysis as a STRUCTURED JSON block wrapped in \\\`\\\`\\\`json fences.
This JSON will be parsed by the pipeline. Follow this schema EXACTLY:

\\\`\\\`\\\`json
{
  "triage": {
    "level": "trivial | simple | moderate | complex",
    "rationale": "Why this complexity level",
    "skipDesignStep": false,
    "skipDebateStep": false
  },
  "intent": {
    "type": "greenfield-build | feature-add | bug-fix | refactoring | migration | architecture | research",
    "confidence": "high | medium | low",
    "rationale": "Why this classification"
  },
  "codebaseState": "greenfield | disciplined | transitional | legacy",
  "techStack": {
    "language": "TypeScript",
    "runtime": "Node.js",
    "framework": "Express",
    "frontend": "Vanilla HTML5 Canvas",
    "realtime": "Socket.IO",
    "database": "in-memory",
    "packageManager": "npm",
    "testFramework": "vitest",
    "justification": "Why this stack was chosen (1-2 sentences)"
  },
  "features": [
    {
      "id": "F1",
      "name": "Feature name",
      "priority": "must-have | nice-to-have",
      "description": "What it does",
      "userStory": "As a [user], I want [action] so that [benefit]"
    }
  ],
  "scope": {
    "in": ["What IS in scope"],
    "out": ["What is NOT in scope"],
    "assumptions": ["Things assumed to be true"],
    "constraints": ["Technical or business limitations"]
  },
  "risks": [
    {
      "risk": "What could go wrong",
      "severity": "high | medium | low",
      "likelihood": "high | medium | low",
      "mitigation": "How to prevent or handle it"
    }
  ],
  "premortem": [
    {
      "failureScenario": "How it could fail",
      "prevention": "How the plan addresses this"
    }
  ],
  "edgeCases": [
    {
      "id": "EC1",
      "feature": "F1",
      "scenario": "What edge case occurs",
      "expectedBehavior": "What should happen",
      "severity": "critical | moderate | minor"
    }
  ],
  "acceptanceCriteria": [
    {
      "id": "AC1",
      "criterion": "Executable verification step",
      "command": "The exact command to verify (must be agent-executable, no manual testing)",
      "expectedResult": "What success looks like (exact output)"
    }
  ],
  "directives": {
    "mustDo": ["Critical requirements for build step"],
    "mustNotDo": ["Anti-patterns and scope creep to avoid"],
    "patternsToFollow": ["Existing patterns to replicate"],
    "verificationTools": ["Specific tools/commands for checking work"]
  },
  "slopGuardrails": {
    "scopeInflationRisk": "low | medium | high",
    "prematureAbstractionRisk": "low | medium | high",
    "overValidationRisk": "low | medium | high",
    "docBloatRisk": "low | medium | high",
    "specificWarnings": ["Task-specific warnings about likely AI-slop patterns"]
  },
  "gapAnalysis": {
    "implicitRequirements": ["Requirements not stated but necessary"],
    "unresolvedQuestions": [],
    "featureDependencies": ["F2 depends on F1 being complete"],
    "missingCoverage": ["Any features without acceptance criteria or risk mitigation"],
    "predictionCheck": ["Prediction: X → Reality: Y (matched/surprised)"]
  },
  "decisionDrivers": [
    {
      "id": "DD1",
      "principle": "The guiding rule for build step",
      "rationale": "Why this matters for THIS task",
      "tradeoff": "What is sacrificed"
    }
  ],
  "selfReview": {
    "allFeaturesHaveUserStories": true,
    "allFeaturesHaveAC": true,
    "allACsAreExecutable": true,
    "allRisksHaveMitigation": true,
    "techStackJustified": true,
    "scopeOutExplicit": true,
    "issuesFound": ["Any issues found and fixed during self-review"]
  },
  "complexity": {
    "level": "simple | moderate | complex | very-complex",
    "estimatedFiles": 8,
    "estimatedLines": 1500,
    "estimatedBuildWaves": 3,
    "criticalPath": "package.json → server → client → integration"
  }
}
\\\`\\\`\\\`

IMPORTANT:
- The JSON must be valid and parseable
- For existing projects: omit techStack if not changing stack, focus on what needs changing
- For greenfield: techStack is MANDATORY
- features array must have at least 2 entries
- acceptanceCriteria must have at least 3 entries — ALL must be agent-executable commands
- risks must have at least 2 entries
- slopGuardrails is MANDATORY for all tasks
- gapAnalysis is MANDATORY — even if empty, show you checked
- selfReview is MANDATORY — run the checklist, fix issues before outputting
- decisionDrivers must have at least 2 entries for moderate+ tasks
- For trivial/simple triage: edgeCases, premortem, risks, decisionDrivers arrays may be empty
- DO NOT fabricate information — if uncertain, say so in the rationale

After the JSON block, you MUST also write this exact JSON to the file \`.agi/analysis.json\` using the write tool.
This is the ONLY file you are allowed to write. Do NOT write any other files.
The file write ensures the full analysis is preserved even if your text output is truncated.

After writing the file, you may add a brief (2-3 sentence) natural language summary in your text response.`,

        debate: `## Multi-Agent Design Debate

Review the ANALYZE step's structured analysis (intent, techStack, features, risks) from Prior Step Results.

Present 2-3 architecture options with concrete reasoning.
For each option:
- **Architecture**: High-level structure
- **Pros**: Specific technical advantages
- **Cons**: Specific technical disadvantages
- **Risks**: What could go wrong with this approach
- **Complexity**: Estimated effort (simple/moderate/complex)
- **Files**: Estimated file count and key components

After comparing, recommend the BEST approach with specific justification.
If the analysis already chose a tech stack, evaluate whether that choice is optimal or suggest alternatives.

**DO NOT use write tools. Analysis only.**`,

        design: `## RULES FOR THIS STEP
- You are in DESIGN ONLY mode. **DO NOT use the write, apply_patch, or multi_patch tools.**
- If you use any write tool in this step, the pipeline will fail.

## WHAT TO DO
The ANALYZE step has already classified the intent, selected the tech stack, extracted requirements, and identified risks.
Your job is to turn that analysis into a CONCRETE, BUILD-READY implementation plan.

**Read the analysis from Prior Step Results above.** Look for the JSON block — it contains:
- intent, techStack, features, scope, risks, acceptanceCriteria, directives

### 1. FILE MANIFEST (MANDATORY)
List EVERY file to create with its exact purpose. Be exhaustive.
Format: \`path/to/file.ext\` — One-line description of what it contains

### 2. FILE CONTENTS SKELETON
For each file, describe the KEY functions/classes/exports it must contain.
Not full code — but specific enough that a builder can write it without guessing.
Example:
- \`server/index.js\`: createServer(), setupWebSocket(), handleConnection(socket), broadcastGameState()
- \`public/game.js\`: GameLoop class with init(), update(dt), render(ctx), handleInput(event)

### 3. DATA FLOW & COMMUNICATION
- How do components communicate? (HTTP, WebSocket events, shared state, etc.)
- List every event/endpoint with request/response shapes
- Example: \`ws:player.move { playerId, x, y } → broadcast:game.state { players, items }\`

### 4. DATA MODELS
Key data structures with their fields and types.
Example: \`Player { id: string, name: string, x: number, y: number, score: number }\`

### 5. DEPENDENCY LIST
Exact npm packages (or pip packages, etc.) with versions if critical.
Example: \`express@^4.18, socket.io@^4.7, uuid@^9\`

### 6. BUILD ORDER (EXECUTION WAVES)
Group files into parallel execution waves:
- Wave 1 (foundation): package.json, server entry point
- Wave 2 (core, parallel): game logic, client HTML, client JS
- Wave 3 (integration): WebSocket wiring, state sync
- Wave 4 (polish): error handling, edge cases

### 7. RESPECT ANALYSIS DIRECTIVES
The analysis step provided MUST DO and MUST NOT DO directives.
INCORPORATE THEM into your design. Do not contradict the analysis.

Be EXTREMELY specific. The BUILD step will follow this plan literally.
OUTPUT FORMAT: structured text plan. NO files created.`,

        build: `## CRITICAL: YOU ARE THE BUILDER. WRITE ACTUAL CODE.

### WHAT "BUILD" MEANS
- Write REAL, RUNNABLE APPLICATION CODE.
- NOT architecture documents. NOT JSON exports. NOT design objects.
- Every file must contain EXECUTABLE code that does something when run.

### EXAMPLES OF WRONG OUTPUT (DO NOT DO THIS)
\`\`\`js
// WRONG — this is a design document, not application code
module.exports = { project: { name: "...", goal: "..." }, architecture: { ... } };
\`\`\`

### EXAMPLES OF CORRECT OUTPUT
\`\`\`js
// CORRECT — this is a real server
const express = require('express');
const app = express();
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.listen(3000, () => console.log('Server running on port 3000'));
\`\`\`

### PROCESS
1. Read the design plan from the prior step results above.
2. Create package.json FIRST with all dependencies and a working "start" script.
3. Run \`bash: npm install\` to install dependencies.
4. Write EVERY file listed in the design plan with COMPLETE, WORKING code.
5. Each file must be FULL — no placeholders, no TODOs, no "...".
6. After writing all files, run \`bash: npm start\` or equivalent to verify it works.
7. DO NOT STOP until every planned file is written and the app starts.

### EFFICIENCY RULES
- Read each file AT MOST ONCE. Do not re-read files you already know the contents of.
- Write files in dependency order: package.json → server → client → tests.
- If npm install fails, check package.json for typos and fix immediately.`,

        verify: `## VERIFY THAT THE APPLICATION WORKS

### STEP 1: BASIC VERIFICATION
1. Run \`bash: ls -la\` to see all files
2. Run \`bash: cat package.json\` to check scripts
3. Run \`bash: npm install\` (if node project)
4. Run \`bash: npm start &\` or equivalent to start the application
5. If it's a web app, run \`bash: curl http://localhost:PORT\` to check it responds
6. Run \`bash: npm test\` if tests exist
7. Check for common issues: missing files, broken imports, syntax errors

### STEP 2: ACCEPTANCE CRITERIA VERIFICATION
Check the Structured Analysis section above for **Acceptance Criteria**.
For EACH criterion:
1. Run the specified command
2. Check if the expected result matches
3. Report: [PASS] or [FAIL] with details

If no structured analysis exists, use the general checks below.

### STEP 3: CRITICAL CHECK
Ask yourself: "Does this actually implement what was requested in the ORIGINAL TASK?"
- If the task asked for a GAME but only architecture documents exist → FAIL
- If the task asked for a SERVER but no server code exists → FAIL
- If files exist but the app crashes on start → FAIL

### STEP 4: SCOPE COMPLIANCE
Check the Structured Analysis for **Scope** boundaries:
- Is everything in IN scope actually built? If not → report what's missing
- Is anything in OUT scope accidentally built? If so → report scope creep

### STEP 5: EDGE CASE HANDLING
Check the Structured Analysis for **Edge Cases** (if present).
For each critical/moderate edge case:
1. Does the code handle this scenario?
2. If not → report as [EDGE-MISS] with the scenario and what should happen
3. Critical edge cases that are unhandled = FAIL

### STEP 6: AI-SLOP CHECK
Check the Structured Analysis for **AI-Slop Guardrails** (if present).
- Did the build step add unnecessary abstractions? (premature abstraction)
- Did it add features beyond what was requested? (scope inflation)
- Are there excessive validation checks for simple internal operations? (over-validation)
- Are there boilerplate JSDoc/comments on every trivial function? (doc bloat)
If slop detected → report as [SLOP] with specific examples.

Report ALL errors with file paths and line numbers. Do NOT fix anything — just report.`,

        fix: `Fix ALL reported errors from the verify step.
1. Read each broken file
2. Identify the root cause (not just the symptom)
3. Write the COMPLETE corrected file (not just a patch)
4. Run the verification again to confirm the fix works
5. If npm install failed: fix package.json and re-run
6. If the app won't start: check entry point, imports, syntax`,

        improve: `Optimize what exists WITHOUT rewriting from scratch:
- Security: input validation, XSS prevention, SQL injection prevention
- Performance: caching, efficient algorithms, lazy loading
- Missing features: anything from the original task not yet implemented
- Edge cases: error handling, empty states, boundary conditions
- Tests: add basic tests if none exist
DO NOT create architecture documents. Only improve actual code.`,

        review: `## FINAL REVIEW — BE STRICT

### REVIEW PERSPECTIVES (evaluate from ALL three angles):

**1. EXECUTOR PERSPECTIVE**: Can this be run?
- Does \`npm start\` (or equivalent) work?
- Are all imports valid? All dependencies installed?
- No syntax errors, no missing files?

**2. STAKEHOLDER PERSPECTIVE**: Does this solve the stated problem?
- Read the ORIGINAL TASK above carefully.
- If it asked for a "게임" (game), is there actual game code with rendering, game loop, input handling?
- If it asked for a "서버" (server), is there actual server code that listens on a port?
- If it asked for an "앱" (app), is there actual application code?
- Architecture documents, design exports, and JSON configs do NOT count.

**3. SKEPTIC PERSPECTIVE**: What's the strongest argument this will fail?
- What edge cases aren't handled?
- What happens under load / with bad input / when things go wrong?
- Is anything suspiciously missing?

### ACCEPTANCE CRITERIA CHECK
If the Structured Analysis section has **Acceptance Criteria**, verify EACH one:
- [PASS] or [FAIL] with explanation

### SCOPE CHECK
If the Structured Analysis section has **Scope** boundaries:
- Everything IN scope is built? [YES/NO]
- Nothing OUT of scope was added? [YES/NO]

### FEATURE CHECK
If the Structured Analysis section has **Features**, verify each:
- [PASS] or [FAIL] for each feature

### VERDICT
- Output **FAIL** if the app doesn't run, doesn't implement the task, or major features are missing.
- Output **PASS** only if the application genuinely fulfills the original task.
- Include specific reasons for your verdict.
- If FAIL: list exactly what's missing or broken.`,
      };
      return m[type] || "";
    }

    // Execute one step via the engine CLI
    // blockedTools: optional array of tool names to block at engine level
    async function executeStep(prompt, mode, maxTurns, blockedTools) {
      return new Promise((resolve, reject) => {
        if (aborted) { reject(new Error("Aborted")); return; }
        const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");

        // [FIX #7] Pass prompt via temp file instead of CLI arg to avoid OS arg length limits
        const tmpPromptFile = path.join(os.tmpdir(), `agi-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        fs.writeFileSync(tmpPromptFile, prompt, "utf-8");

        // CLI expects: node cli.js run "<task>" — pass placeholder, real prompt via env file
        // Ensure node's directory is in PATH so bash tool can find node/npm/npx
        const nodeBinDir = path.dirname(NODE_BIN);
        const childEnv = { ...process.env, AGI_PROMPT_FILE: tmpPromptFile };
        // [FIX] Block tools at engine level for analysis steps
        if (blockedTools && blockedTools.length > 0) {
          childEnv.AGI_BLOCKED_TOOLS = blockedTools.join(",");
          childEnv.AGI_MAX_ENFORCER_ROUNDS = "2"; // Analysis steps: 2 rounds max
          // Allow writing to .agi/ directory for file-based analysis output (OmO pattern)
          childEnv.AGI_ALLOWED_WRITE_PATHS = ".agi/";
          // Increase output token limit for analysis steps — full JSON needs ~16K tokens
          childEnv.AGI_MAX_OUTPUT_TOKENS = "16384";
        } else {
          delete childEnv.AGI_BLOCKED_TOOLS;
          delete childEnv.AGI_MAX_ENFORCER_ROUNDS;
          delete childEnv.AGI_ALLOWED_WRITE_PATHS;
          delete childEnv.AGI_MAX_OUTPUT_TOKENS;
        }
        if (!childEnv.PATH?.includes(nodeBinDir)) {
          childEnv.PATH = `${nodeBinDir}:${childEnv.PATH || ""}`;
        }
        const child = spawn(NODE_BIN, [agentCli, mode || "run", "__AGI_PROMPT_FILE__"], {
          cwd: childCwd,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "", stderr = "";
        let llmText = ""; // [FIX] Capture LLM text output from provider.stream
        let taskCompletedTexts = []; // [FIX] Capture worker/task completion summaries
        let reviewSummary = ""; // [FIX] Capture review summary
        let changes = [], errors = [], toolResults = [];

        child.stdout.on("data", (chunk) => {
          const text = chunk.toString();
          stdout += text;
          // Parse events and forward ALL to client — full transparency
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = parseEventLine(trimmed);
            if (parsed) {
              // LLM streaming text → forward as llm event
              if (parsed.eventType === "provider.stream") {
                const c = parsed.payload?.chunk || parsed.payload?.delta || "";
                if (c) {
                  const t = typeof c === "string" ? c : "";
                  llmText += t; // [FIX] Accumulate LLM text for summary
                  sendAgi("llm", { text: t });
                }
                continue;
              }
              // Tool streaming output (bash stdout/stderr) → forward for real-time visibility
              if (parsed.eventType === "tool.stream") {
                const streamChunk = parsed.payload?.chunk || "";
                if (streamChunk) sendAgi("stdout", { text: typeof streamChunk === "string" ? streamChunk : "" });
                continue;
              }
              // Provider retry → show as warning
              if (parsed.eventType === "provider.retry") {
                sendAgi("event", parsed);
                continue;
              }
              // Everything else: forward with full payload
              sendAgi("event", parsed);
              // [FIX] Capture task completion summaries (worker results)
              if (parsed.eventType === "task.completed" && parsed.payload?.notification) {
                taskCompletedTexts.push(parsed.payload.notification);
              }
              // [FIX] Capture review summaries
              if ((parsed.eventType === "review.fail" || parsed.eventType === "review.pass") && parsed.payload?.review?.summary) {
                reviewSummary = parsed.payload.review.summary;
              }
              // [FIX #6] Track tool results — capture full output, no truncation
              if (parsed.eventType === "tool.completed") {
                const ok = parsed.payload?.ok !== false;
                const name = parsed.payload?.tool || "unknown";
                const toolOutput = parsed.payload?.output || {};
                toolResults.push({ name, ok, output: toolOutput });
                if (ok && name === "write" && toolOutput.path) {
                  changes.push("created " + toolOutput.path);
                }
                if (ok && name === "apply_patch" && toolOutput.path) {
                  changes.push("modified " + toolOutput.path);
                }
                if (ok && name === "bash" && toolOutput.stdout) {
                  // Capture full bash output for context passing
                  toolResults[toolResults.length - 1].fullStdout = toolOutput.stdout;
                  toolResults[toolResults.length - 1].fullStderr = toolOutput.stderr || "";
                }
              }
            } else {
              sendAgi("stdout", { text: trimmed });
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderr += text;
          // Forward stderr to UI — important for debugging visibility
          sendAgi("stderr", { text });
        });

        child.on("close", (code) => {
          // Cleanup temp prompt file
          try { fs.unlinkSync(tmpPromptFile); } catch {}

          // [FIX] Build meaningful summary from captured events
          // Priority: LLM text > task completion notifications > review summary > raw stdout
          let summary = "";
          if (llmText.trim()) {
            summary = llmText.trim();
          }
          if (taskCompletedTexts.length > 0) {
            summary += (summary ? "\n\n" : "") + taskCompletedTexts.join("\n");
          }
          if (reviewSummary) {
            summary += (summary ? "\n\n" : "") + "Review: " + reviewSummary;
          }
          if (!summary) {
            summary = stdout; // Fallback to raw stdout
          }

          if (code !== 0) errors.push(`Exit code ${code}`);

          // [FIX #3] Smart error detection — only real errors, not mentions of "error" in code/comments
          // Only flag actual runtime errors, not mentions in code context
          const realErrorPatterns = [
            /^(?:Error|TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError):\s/,  // JS error prefix at line start
            /^\s*at\s+\S+\s+\(/,                     // Stack trace line
            /FATAL\s*(?:ERROR|EXCEPTION)/i,           // Fatal markers
            /\bUnhandledPromiseRejection\b/,          // Unhandled promise
            /\bENOENT\b|\bEACCES\b|\bEPERM\b/,       // OS errors
            /\bSegmentation fault\b/i,                // Segfault
            /\bkilled\b.*\bSIGKILL\b/i,              // OOM kill
            /npm ERR!/,                               // npm actual error
            /\bpanic:\s/,                             // Go/Rust panic
            /\bTraceback \(most recent/,              // Python traceback
          ];
          for (const line of stderr.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            for (const p of realErrorPatterns) {
              if (p.test(trimmed)) { errors.push(trimmed); break; }
            }
          }

          // [FIX #1, #10] Return full stdout as summary AND rawOutput — no truncation
          resolve({ summary, changes, toolResults, tokensUsed: 0, errors, rawOutput: stdout });
        });

        child.on("error", (err) => {
          try { fs.unlinkSync(tmpPromptFile); } catch {}
          reject(err);
        });

        // Allow abort
        const checkAbort = setInterval(() => {
          if (aborted) { child.kill("SIGTERM"); clearInterval(checkAbort); }
        }, 1000);
        child.on("close", () => clearInterval(checkAbort));
      });
    }

    // Run the pipeline
    let stepIdx = 0;
    let replanCount = 0;
    const MAX_REPLANS = 10;

    while (stepIdx < steps.length && !aborted) {
      if (replanCount > MAX_REPLANS) {
        sendAgi("agi.pipeline.fail", { error: `Max replans (${MAX_REPLANS}) exceeded` });
        break;
      }

      const step = steps[stepIdx];

      // [FIX] Write step-specific AGENTS.md before each step
      writeStepAgentsMd(step.type);

      // [FIX] Block write tools at engine level for analysis steps
      const isAnalysisStep = ["analyze", "design", "debate"].includes(step.type);
      const blockedTools = isAnalysisStep ? ["write", "apply_patch", "multi_patch"] : [];

      const prompt = buildStepPrompt(step);

      sendAgi("agi.step.start", { stepId: step.id, stepType: step.type, stepTitle: step.title, stepIndex: stepIdx, totalSteps: steps.length, completedSteps: ctx.stepResults.filter(r => r.status === "completed").length });

      let result = null;
      let attempts = 0;
      const maxRetries = step.maxRetries || 0;

      while (attempts <= maxRetries) {
        attempts++;
        const start = Date.now();
        try {
          // [FIX #4] Retry includes full previous output + errors, not just error list
          const retryPrompt = attempts > 1
            ? `${prompt}\n\n[RETRY ${attempts}/${maxRetries+1}] Previous attempt failed. Try a different approach.\n\n## Previous Attempt Errors\n${(result?.errors || []).map(e => `- ${e}`).join("\n") || "unknown"}\n\n## Previous Attempt Output\n${result?.summary || "(no output)"}`
            : prompt;

          const output = await executeStep(retryPrompt, step.mode, step.maxTurns, blockedTools);

          result = {
            stepId: step.id,
            type: step.type,
            status: (output.errors.length === 0 || step.type === "verify") ? "completed" : "failed",
            // [FIX #1, #10] Full summary and rawOutput — no truncation
            summary: output.summary,
            rawOutput: output.rawOutput,
            changes: output.changes,
            toolResults: output.toolResults,
            durationMs: Date.now() - start,
            tokensUsed: output.tokensUsed,
            errors: output.errors,
          };

          if (step.type === "verify") result.status = "completed";
          if (result.status === "completed") break;
        } catch (e) {
          result = {
            stepId: step.id, type: step.type, status: "failed",
            summary: `Step failed: ${e.message}`, changes: [], toolResults: [],
            durationMs: Date.now() - start, tokensUsed: 0, errors: [e.message],
          };
          ctx.errorLog.push({ stepId: step.id, error: e.message, category: "runtime", resolved: false });
        }
      }

      // Record result
      if (result) {
        ctx.stepResults.push(result);
        ctx.totalTokens += result.tokensUsed;
        for (const c of (result.changes || [])) {
          const clean = c.replace(/^(created|modified|updated|deleted)\s+/i, "").trim();
          if (!ctx.allFiles.includes(clean)) ctx.allFiles.push(clean);
        }

        // Mark errors resolved on success
        if (result.status === "completed") {
          for (const e of ctx.errorLog) {
            if (e.stepId === step.id && !e.resolved) { e.resolved = true; e.resolution = "Step completed"; }
          }
        }

        // Parse structured analysis JSON from analyze step
        if (step.type === "analyze" && result.status === "completed") {
          const summary = result.summary || "";
          // Extract JSON block from ```json ... ``` fences
          const jsonMatch = summary.match(/```json\s*\n([\s\S]*?)\n\s*```/);
          if (jsonMatch) {
            try {
              const analysis = JSON.parse(jsonMatch[1]);
              ctx.analysis = analysis;

              // Extract decisions from structured data
              if (analysis.techStack?.justification) {
                ctx.decisions.push(`Tech stack: ${analysis.techStack.justification}`);
              }
              if (analysis.intent?.rationale) {
                ctx.decisions.push(`Intent: ${analysis.intent.type} — ${analysis.intent.rationale}`);
              }
              if (analysis.directives?.mustDo) {
                for (const d of analysis.directives.mustDo) {
                  ctx.decisions.push(`MUST DO: ${d}`);
                }
              }
              if (analysis.directives?.mustNotDo) {
                for (const d of analysis.directives.mustNotDo) {
                  ctx.decisions.push(`MUST NOT DO: ${d}`);
                }
              }

              // Override pipeline complexity from analysis
              if (analysis.complexity?.level) {
                ctx.analysisComplexity = analysis.complexity.level;
              }

              // Triage-based step skipping: remove design/debate for trivial/simple tasks
              if (analysis.triage) {
                const triage = analysis.triage;
                if (triage.skipDesignStep || triage.level === "trivial") {
                  const designIdx = steps.findIndex(s => s.type === "design" && stepIdx < steps.indexOf(s));
                  if (designIdx > -1) {
                    sendAgi("agi.step.skip", { stepType: "design", reason: `Triage: ${triage.level} — ${triage.rationale}` });
                    steps.splice(designIdx, 1);
                  }
                }
                if (triage.skipDebateStep || triage.level === "trivial" || triage.level === "simple") {
                  const debateIdx = steps.findIndex(s => s.type === "debate" && stepIdx < steps.indexOf(s));
                  if (debateIdx > -1) {
                    sendAgi("agi.step.skip", { stepType: "debate", reason: `Triage: ${triage.level} — ${triage.rationale}` });
                    steps.splice(debateIdx, 1);
                  }
                }
              }

              sendAgi("agi.analysis.parsed", {
                triage: analysis.triage,
                intent: analysis.intent,
                codebaseState: analysis.codebaseState,
                techStack: analysis.techStack ? {
                  language: analysis.techStack.language,
                  framework: analysis.techStack.framework,
                  frontend: analysis.techStack.frontend,
                } : null,
                featureCount: analysis.features?.length || 0,
                riskCount: analysis.risks?.length || 0,
                edgeCaseCount: analysis.edgeCases?.length || 0,
                complexity: analysis.complexity,
                slopGuardrails: analysis.slopGuardrails,
                hasGapAnalysis: !!analysis.gapAnalysis,
              });
            } catch (e) {
              // JSON parse failed — fall back to regex extraction
              sendAgi("agi.analysis.parseError", { error: e.message });
            }
          }

          // Fallback 1: File-based analysis output (OmO pattern — most reliable)
          if (!ctx.analysis) {
            try {
              const analysisFile = path.join(childCwd, ".agi", "analysis.json");
              if (fs.existsSync(analysisFile)) {
                const fileContent = fs.readFileSync(analysisFile, "utf8");
                const analysis = JSON.parse(fileContent);
                ctx.analysis = analysis;
                sendAgi("agi.analysis.parsed", {
                  source: "file",
                  triage: analysis.triage,
                  intent: analysis.intent,
                  codebaseState: analysis.codebaseState,
                  featureCount: analysis.features?.length || 0,
                  riskCount: analysis.risks?.length || 0,
                  edgeCaseCount: analysis.edgeCases?.length || 0,
                  complexity: analysis.complexity,
                  slopGuardrails: analysis.slopGuardrails,
                  hasGapAnalysis: !!analysis.gapAnalysis,
                });
                // Extract decisions from file-based analysis
                if (analysis.techStack?.justification) ctx.decisions.push(`Tech stack: ${analysis.techStack.justification}`);
                if (analysis.intent?.rationale) ctx.decisions.push(`Intent: ${analysis.intent.type} — ${analysis.intent.rationale}`);
                if (analysis.directives?.mustDo) for (const d of analysis.directives.mustDo) ctx.decisions.push(`MUST DO: ${d}`);
                if (analysis.directives?.mustNotDo) for (const d of analysis.directives.mustNotDo) ctx.decisions.push(`MUST NOT DO: ${d}`);
                if (analysis.complexity?.level) ctx.analysisComplexity = analysis.complexity.level;
                // Triage-based step skipping
                if (analysis.triage) {
                  const triage = analysis.triage;
                  if (triage.skipDesignStep || triage.level === "trivial") {
                    const idx = steps.findIndex(s => s.type === "design" && stepIdx < steps.indexOf(s));
                    if (idx > -1) { sendAgi("agi.step.skip", { stepType: "design", reason: `Triage: ${triage.level}` }); steps.splice(idx, 1); }
                  }
                  if (triage.skipDebateStep || triage.level === "trivial" || triage.level === "simple") {
                    const idx = steps.findIndex(s => s.type === "debate" && stepIdx < steps.indexOf(s));
                    if (idx > -1) { sendAgi("agi.step.skip", { stepType: "debate", reason: `Triage: ${triage.level}` }); steps.splice(idx, 1); }
                  }
                }
              }
            } catch (e) {
              sendAgi("agi.analysis.fileError", { error: e.message });
            }
          }

          // Fallback 2: regex-based decision extraction if no JSON found
          if (!ctx.analysis) {
            const decisionPatterns = [
              /(?:decision|chose|selected|will use|architecture|approach|strategy|recommendation|concluded|determined|opted for|going with|picked|prefer|using)[:.\-—]\s*([^\n]+)/gi,
              /(?:we (?:will|should|need to|must|decided to|chose to))\s+([^\n]+)/gi,
              /(?:the (?:best|recommended|chosen|selected|optimal) (?:approach|solution|strategy|architecture|pattern|framework|tool|library) (?:is|was|will be))\s+([^\n]+)/gi,
            ];
            for (const pattern of decisionPatterns) {
              const matches = (summary).matchAll(pattern);
              for (const m of matches) {
                const decision = m[0];
                if (!ctx.decisions.includes(decision)) ctx.decisions.push(decision);
              }
            }
          }

          // Schema validation (MetaGPT pattern): check required fields, log warnings
          if (ctx.analysis) {
            const a = ctx.analysis;
            const missing = [];
            if (!a.intent?.type) missing.push("intent.type");
            if (!a.features?.length) missing.push("features (empty)");
            if (!a.acceptanceCriteria?.length) missing.push("acceptanceCriteria (empty)");
            if (!a.directives) missing.push("directives");
            if (!a.complexity?.level) missing.push("complexity.level");
            // Moderate+ tasks require more fields
            const triageLevel = a.triage?.level || "moderate";
            if (triageLevel !== "trivial" && triageLevel !== "simple") {
              if (!a.scope) missing.push("scope");
              if (!a.risks?.length) missing.push("risks (empty)");
              if (!a.slopGuardrails) missing.push("slopGuardrails");
              if (!a.gapAnalysis) missing.push("gapAnalysis");
              if (!a.selfReview) missing.push("selfReview");
              if (!a.decisionDrivers?.length) missing.push("decisionDrivers (empty)");
              if (!a.edgeCases?.length) missing.push("edgeCases (empty)");
            }
            if (missing.length > 0) {
              sendAgi("agi.analysis.validation", { status: "incomplete", missing, triageLevel });
              // Store validation result for potential retry
              ctx.analysisValidation = { missing, triageLevel };
            } else {
              sendAgi("agi.analysis.validation", { status: "complete", triageLevel });
            }
          }
        }

        // Extract decisions from design step too
        if (step.type === "design" && result.status === "completed") {
          const decisionPatterns = [
            /(?:decision|chose|selected|will use|architecture|approach|strategy|recommendation|concluded|determined|opted for|going with|picked|prefer|using)[:.\-—]\s*([^\n]+)/gi,
            /(?:we (?:will|should|need to|must|decided to|chose to))\s+([^\n]+)/gi,
          ];
          for (const pattern of decisionPatterns) {
            const matches = (result.summary || "").matchAll(pattern);
            for (const m of matches) {
              const decision = m[0];
              if (!ctx.decisions.includes(decision)) ctx.decisions.push(decision);
            }
          }
        }

        const evtType = result.status === "completed" ? "agi.step.complete" : "agi.step.fail";
        sendAgi(evtType, {
          stepId: step.id, stepType: step.type, stepTitle: step.title,
          status: result.status,
          // SSE event — send last 4000 chars for UI display; full data is in ctx.stepResults
          summary: (result.summary || "").slice(-4000),
          totalSteps: steps.length,
          completedSteps: ctx.stepResults.filter(r => r.status === "completed").length,
          filesCreated: ctx.allFiles.length,
        });

        // REPLAN: verify failed → insert fix + re-verify
        if (result.type === "verify" && result.errors.length > 0) {
          const nextStep = steps[stepIdx + 1];
          if (!nextStep || nextStep.type !== "fix") {
            const fixId = mkId("fix");
            const reVerifyId = mkId("reverify");
            steps.splice(stepIdx + 1, 0,
              { id: fixId, type: "fix", title: "Fix Errors (auto)", mode: "run", maxTurns: 100, maxRetries: 3, useStrategyBranching: true },
              { id: reVerifyId, type: "verify", title: "Re-verify (auto)", mode: "run", maxTurns: 50, maxRetries: 0, useStrategyBranching: false }
            );
            replanCount++;
            sendAgi("agi.replan", { reason: "Verify found errors — inserting fix + re-verify", replanCount, totalSteps: steps.length, insertedSteps: ["fix", "re-verify"] });
          }
        }

        // REPLAN: fix failed too many times → rebuild with different strategy
        if (result.type === "fix" && result.status === "failed") {
          const fixCount = ctx.stepResults.filter(r => r.type === "fix").length;
          if (fixCount >= 2) {
            const rebuildId = mkId("rebuild");
            steps.splice(stepIdx + 1, 0,
              { id: rebuildId, type: "build", title: "Rebuild (alt strategy)", mode: "team", maxTurns: 200, maxRetries: 1, useStrategyBranching: true }
            );
            replanCount++;
            sendAgi("agi.replan", { reason: `Fix failed ${fixCount} times — trying alternative build`, replanCount, totalSteps: steps.length, insertedSteps: ["rebuild"] });
          }
        }

        // REPLAN: review failed → fix + re-review
        if (result.type === "review" && result.status === "failed") {
          const reviewFails = ctx.stepResults.filter(r => r.type === "review" && r.status === "failed").length;
          if (reviewFails < 3) {
            const fixId = mkId("reviewfix");
            const reReviewId = mkId("rereview");
            steps.splice(stepIdx + 1, 0,
              { id: fixId, type: "fix", title: "Fix Review Issues", mode: "run", maxTurns: 80, maxRetries: 2, useStrategyBranching: false },
              { id: reReviewId, type: "review", title: "Re-review", mode: "run", maxTurns: 40, maxRetries: 0, useStrategyBranching: false }
            );
            replanCount++;
            sendAgi("agi.replan", { reason: "Review failed — inserting fix + re-review", replanCount, totalSteps: steps.length });
          }
        }
      }

      stepIdx++;
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTORESEARCH: Self-optimizing loop after pipeline completes
    // Based on Karpathy's autoresearch methodology:
    //   1. Generate binary evals from the task
    //   2. Score current output
    //   3. If score < 100%, identify weakest step
    //   4. Mutate that step's prompt
    //   5. Re-run from that step
    //   6. Score again — keep mutation if improved, discard if not
    //   7. Repeat until score ceiling or max iterations
    // ═══════════════════════════════════════════════════════════════

    const AUTORESEARCH_MAX_ITERATIONS = 5;
    const AUTORESEARCH_DIR = path.join(childCwd, ".agent", "autoresearch");

    // Generate binary evals from the task automatically
    function generateBinaryEvals(taskText, projectDir) {
      const evals = [];
      const files = (() => { try { return fs.readdirSync(projectDir).filter(f => !f.startsWith(".") && f !== "node_modules"); } catch { return []; } })();
      const allFilesDeep = (() => {
        try {
          const result = [];
          const walk = (dir, prefix) => {
            for (const f of fs.readdirSync(dir)) {
              if (f.startsWith(".") || f === "node_modules") continue;
              const full = path.join(dir, f);
              const rel = prefix ? `${prefix}/${f}` : f;
              const stat = fs.statSync(full);
              if (stat.isFile()) result.push(rel);
              else if (stat.isDirectory() && result.length < 200) walk(full, rel);
            }
          };
          walk(projectDir, "");
          return result;
        } catch { return []; }
      })();

      // EVAL 1: Were actual files created (not just AGENTS.md)?
      const realFiles = files.filter(f => f !== "AGENTS.md" && f !== "package-lock.json");
      evals.push({
        name: "files_created",
        question: "Were real project files created?",
        pass: realFiles.length >= 2,
        details: `${realFiles.length} real files: ${realFiles.join(", ")}`
      });

      // EVAL 2: Does package.json exist with start script?
      const pkgPath = path.join(projectDir, "package.json");
      let hasStartScript = false;
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          hasStartScript = !!(pkg.scripts && pkg.scripts.start);
        } catch {}
      }
      evals.push({
        name: "package_json_start",
        question: "Does package.json exist with a start script?",
        pass: hasStartScript,
        details: hasStartScript ? "start script found" : "missing package.json or start script"
      });

      // EVAL 3: Are files actual code (not architecture documents)?
      let hasRealCode = false;
      const codePatterns = [
        /require\s*\(/,  /import\s+/,  /function\s+\w+/,  /class\s+\w+/,
        /app\.(get|post|listen|use)\s*\(/,  /createElement|render|useState/,
        /canvas|getContext|requestAnimationFrame/,  /socket|WebSocket|io\(/,
        /<html|<body|<canvas|<div/,  /addEventListener/,  /console\.log/,
        /express\(|http\.create|net\.create/,  /def\s+\w+|class\s+\w+:/,
      ];
      for (const f of allFilesDeep.slice(0, 30)) {
        try {
          const content = fs.readFileSync(path.join(projectDir, f), "utf8");
          if (codePatterns.some(p => p.test(content))) { hasRealCode = true; break; }
        } catch {}
      }
      evals.push({
        name: "real_code_exists",
        question: "Do files contain actual executable code (not just design docs)?",
        pass: hasRealCode,
        details: hasRealCode ? "real code found" : "only config/design files detected"
      });

      // EVAL 4: No architecture-document-only output
      let hasArchDocOnly = false;
      const archDocPatterns = [
        /module\.exports\s*=\s*\{[\s\S]*?architecture/,
        /module\.exports\s*=\s*\{[\s\S]*?project\s*:/,
        /exports?\s*=\s*\{[\s\S]*?implementationPlan/,
      ];
      const srcFiles = allFilesDeep.filter(f => /\.(js|ts|mjs)$/.test(f) && !f.includes("test") && !f.includes("node_modules"));
      if (srcFiles.length > 0 && srcFiles.length <= 3) {
        for (const f of srcFiles) {
          try {
            const content = fs.readFileSync(path.join(projectDir, f), "utf8");
            if (archDocPatterns.some(p => p.test(content)) && !codePatterns.slice(4).some(p => p.test(content))) {
              hasArchDocOnly = true;
            }
          } catch {}
        }
      }
      evals.push({
        name: "not_arch_doc_only",
        question: "Is the output NOT just architecture documents?",
        pass: !hasArchDocOnly,
        details: hasArchDocOnly ? "FAIL: output is just architecture export documents" : "output contains real application code"
      });

      // EVAL 5: Task-specific keyword matching
      const taskLower = taskText.toLowerCase();
      const taskKeywords = [];
      if (/게임|game|shooting|슈팅/.test(taskLower)) taskKeywords.push("canvas", "game", "loop", "render", "player");
      if (/서버|server|api|백엔드/.test(taskLower)) taskKeywords.push("listen", "port", "express", "http", "app.get");
      if (/웹|web|사이트|site|html/.test(taskLower)) taskKeywords.push("html", "body", "script", "css");
      if (/채팅|chat|메신저|messenger/.test(taskLower)) taskKeywords.push("socket", "message", "send", "receive");
      if (/온라인|online|멀티|multi/.test(taskLower)) taskKeywords.push("socket", "WebSocket", "io", "connection");

      if (taskKeywords.length > 0) {
        let matchedKeywords = 0;
        const allContent = allFilesDeep.slice(0, 30).map(f => {
          try { return fs.readFileSync(path.join(projectDir, f), "utf8"); } catch { return ""; }
        }).join("\n");
        for (const kw of taskKeywords) {
          if (allContent.toLowerCase().includes(kw.toLowerCase())) matchedKeywords++;
        }
        const keywordPassRate = taskKeywords.length > 0 ? matchedKeywords / taskKeywords.length : 1;
        evals.push({
          name: "task_keywords_match",
          question: `Does the code contain task-relevant keywords? (${taskKeywords.join(", ")})`,
          pass: keywordPassRate >= 0.4,
          details: `${matchedKeywords}/${taskKeywords.length} keywords found (${(keywordPassRate * 100).toFixed(0)}%)`
        });
      }

      // EVAL 6: Multiple source files (not just 1-2 files for a full app)
      if (isFullApp) {
        const srcCount = allFilesDeep.filter(f => /\.(js|ts|html|css|py|jsx|tsx)$/.test(f)).length;
        evals.push({
          name: "sufficient_files",
          question: "Are there enough source files for a full application?",
          pass: srcCount >= 4,
          details: `${srcCount} source files found`
        });
      }

      return evals;
    }

    // Score output against evals
    function scoreEvals(evals) {
      const passed = evals.filter(e => e.pass).length;
      return {
        score: passed,
        maxScore: evals.length,
        passRate: evals.length > 0 ? (passed / evals.length * 100) : 100,
        failures: evals.filter(e => !e.pass),
        passes: evals.filter(e => e.pass),
        evals,
      };
    }

    // Identify which step caused the failures
    function identifyWeakStep(failures, stepResults) {
      // Priority: build > design > analyze
      const failNames = failures.map(f => f.name);

      if (failNames.includes("real_code_exists") || failNames.includes("not_arch_doc_only") || failNames.includes("task_keywords_match") || failNames.includes("sufficient_files")) {
        return "build"; // BUILD didn't produce real code
      }
      if (failNames.includes("package_json_start")) {
        return "build"; // BUILD didn't set up package.json properly
      }
      if (failNames.includes("files_created")) {
        // Check if design was clear enough
        const designResult = stepResults.find(r => r.type === "design");
        if (!designResult || !designResult.summary || designResult.summary.length < 200) {
          return "design"; // Design was too vague
        }
        return "build"; // Design was ok but build didn't execute
      }
      return "build"; // Default: BUILD is most likely the problem
    }

    // Generate a mutated prompt for the weak step
    function generateMutation(weakStep, failures, iteration, previousMutations) {
      const failDescriptions = failures.map(f => `- [FAIL] ${f.question}: ${f.details}`).join("\n");

      const mutationStrategies = [
        // Iteration 1: Be more explicit about what to build
        `\n\n## AUTORESEARCH MUTATION (attempt ${iteration})
The previous attempt FAILED these checks:
${failDescriptions}

YOU MUST FIX THESE FAILURES. Specifically:
- If "real code" failed: You are writing DESIGN DOCUMENTS instead of APPLICATION CODE. Write ACTUAL server/client code.
- If "task keywords" failed: Your code doesn't implement what was asked. Re-read the original task.
- If "architecture doc only" failed: STOP exporting JSON objects. Write executable code with app.listen(), game loops, etc.
- If "files created" failed: You didn't write enough files. Use the write tool for EVERY file.
- If "package.json start" failed: Create package.json with a "start" script that runs the app.`,

        // Iteration 2: Give concrete file list
        `\n\n## AUTORESEARCH MUTATION (attempt ${iteration}) — EXPLICIT FILE LIST
Previous ${iteration - 1} attempts all failed. The output was NOT what was requested.

FAILED CHECKS:
${failDescriptions}

YOU MUST CREATE THESE EXACT FILES (adapt to the task):
1. package.json — with dependencies and "start" script
2. server.js or index.js — main entry point that RUNS something
3. public/index.html — if web app, the HTML page
4. public/game.js or public/app.js — client-side code
5. Any additional files needed for the task

EACH FILE MUST CONTAIN 50+ LINES OF REAL CODE. Not exports, not JSON, not comments.`,

        // Iteration 3: Completely different approach
        `\n\n## AUTORESEARCH MUTATION (attempt ${iteration}) — ALTERNATIVE STRATEGY
${iteration - 1} previous attempts have all failed. CHANGE YOUR APPROACH COMPLETELY.

FAILED CHECKS:
${failDescriptions}

INSTEAD OF YOUR PREVIOUS APPROACH, TRY THIS:
1. Do NOT read any existing files first. Start fresh.
2. Write package.json with express, socket.io, and a "start" script.
3. Write a working Express server (server.js) with static file serving.
4. Write the client HTML with embedded JavaScript.
5. Run npm install && npm start to verify.
6. If the task involves networking: add WebSocket/Socket.IO.
7. If the task involves graphics: add HTML5 Canvas with game loop.`,

        // Iteration 4: Minimal viable product
        `\n\n## AUTORESEARCH MUTATION (attempt ${iteration}) — MINIMUM VIABLE PRODUCT
ALL previous attempts failed. Build the SIMPLEST possible version that passes all checks.

FAILED CHECKS:
${failDescriptions}

BUILD THE ABSOLUTE MINIMUM:
1. ONE server file that serves ONE HTML page
2. The HTML page must do SOMETHING related to the task
3. package.json with "start": "node server.js"
4. npm install must work
5. npm start must work
DO NOT over-architect. Build the smallest thing that works.`,

        // Iteration 5: Last resort — ultra explicit
        `\n\n## AUTORESEARCH MUTATION (attempt ${iteration}) — FINAL ATTEMPT
This is the LAST attempt. Every previous attempt has failed.

FAILED CHECKS:
${failDescriptions}

WRITE EXACTLY THIS STRUCTURE:
- package.json: {"name":"app","scripts":{"start":"node server.js"},"dependencies":{"express":"^4"}}
- server.js: Express server serving public/ folder on port 3000
- public/index.html: Full HTML page with the application
- public/style.css: Styling
- public/app.js: Client-side JavaScript

DO NOT DEVIATE FROM THIS STRUCTURE. Write the files NOW.`,
      ];

      const strategyIdx = Math.min(iteration - 1, mutationStrategies.length - 1);
      return mutationStrategies[strategyIdx];
    }

    // Save autoresearch results
    function saveAutoresearchLog(data) {
      try {
        if (!fs.existsSync(AUTORESEARCH_DIR)) fs.mkdirSync(AUTORESEARCH_DIR, { recursive: true });
        const logPath = path.join(AUTORESEARCH_DIR, "results.json");
        fs.writeFileSync(logPath, JSON.stringify(data, null, 2), "utf8");
      } catch {}
    }

    // ── AUTORESEARCH LOOP ──
    if (!aborted && complexity !== "simple") {
      const pipelineStartTime = Date.now();
      const autoresearchLog = {
        task,
        startedAt: new Date().toISOString(),
        baseline: null,
        experiments: [],
        bestScore: 0,
        status: "running",
      };

      // Score baseline (current pipeline output)
      const baselineEvals = generateBinaryEvals(task, childCwd);
      const baselineScore = scoreEvals(baselineEvals);

      autoresearchLog.baseline = {
        score: baselineScore.score,
        maxScore: baselineScore.maxScore,
        passRate: baselineScore.passRate,
        evals: baselineScore.evals.map(e => ({ name: e.name, pass: e.pass, details: e.details })),
      };
      autoresearchLog.bestScore = baselineScore.passRate;

      sendAgi("agi.autoresearch.start", {
        baselineScore: baselineScore.score,
        maxScore: baselineScore.maxScore,
        passRate: baselineScore.passRate,
        evals: baselineScore.evals.map(e => ({ name: e.name, pass: e.pass, question: e.question, details: e.details })),
      });

      // Only enter autoresearch loop if score < 100%
      if (baselineScore.passRate < 100 && !aborted) {
        let currentScore = baselineScore;
        let iteration = 0;
        const promptMutations = {};
        let consecutivePerfect = 0;

        while (currentScore.passRate < 100 && iteration < AUTORESEARCH_MAX_ITERATIONS && !aborted) {
          iteration++;

          // Identify which step to fix
          const weakStep = identifyWeakStep(currentScore.failures, ctx.stepResults);
          const mutation = generateMutation(weakStep, currentScore.failures, iteration, promptMutations);
          promptMutations[weakStep] = mutation;

          sendAgi("agi.autoresearch.iteration", {
            iteration,
            maxIterations: AUTORESEARCH_MAX_ITERATIONS,
            weakStep,
            failureCount: currentScore.failures.length,
            failures: currentScore.failures.map(f => f.name),
            mutation: `Attempt ${iteration}: targeting ${weakStep} step`,
          });

          // Re-run the weak step with mutated prompt
          const mutatedStep = steps.find(s => s.type === weakStep) || steps.find(s => s.type === "build");
          if (!mutatedStep) break;

          const mutatedPrompt = buildStepPrompt(mutatedStep) + mutation;

          try {
            const output = await executeStep(mutatedPrompt, mutatedStep.mode, mutatedStep.maxTurns);

            // Wait for writes to be applied, then re-score
            const newEvals = generateBinaryEvals(task, childCwd);
            const newScore = scoreEvals(newEvals);

            const experiment = {
              iteration,
              weakStep,
              score: newScore.score,
              maxScore: newScore.maxScore,
              passRate: newScore.passRate,
              previousPassRate: currentScore.passRate,
              status: newScore.passRate > currentScore.passRate ? "keep" : "discard",
              evals: newScore.evals.map(e => ({ name: e.name, pass: e.pass, details: e.details })),
            };
            autoresearchLog.experiments.push(experiment);

            sendAgi("agi.autoresearch.result", {
              iteration,
              score: newScore.score,
              maxScore: newScore.maxScore,
              passRate: newScore.passRate,
              previousPassRate: currentScore.passRate,
              status: experiment.status,
              improved: newScore.passRate > currentScore.passRate,
              evals: newScore.evals.map(e => ({ name: e.name, pass: e.pass, details: e.details })),
            });

            if (newScore.passRate > currentScore.passRate) {
              // KEEP — score improved
              currentScore = newScore;
              autoresearchLog.bestScore = newScore.passRate;

              // Update step result in ctx
              const existingIdx = ctx.stepResults.findIndex(r => r.type === weakStep);
              if (existingIdx >= 0) {
                ctx.stepResults[existingIdx] = {
                  ...ctx.stepResults[existingIdx],
                  summary: output.summary,
                  changes: [...(ctx.stepResults[existingIdx].changes || []), ...(output.changes || [])],
                  status: "completed",
                  errors: output.errors,
                };
              }

              if (newScore.passRate >= 100) {
                consecutivePerfect++;
                if (consecutivePerfect >= 1) break; // Perfect score — done
              }
            } else {
              // DISCARD — no improvement, will try different mutation next iteration
            }
          } catch (e) {
            autoresearchLog.experiments.push({
              iteration, weakStep, score: 0, maxScore: currentScore.maxScore,
              passRate: currentScore.passRate, status: "error", error: e.message,
            });
            sendAgi("agi.autoresearch.error", { iteration, error: e.message });
          }
        }

        autoresearchLog.status = currentScore.passRate >= 100 ? "optimized" : "max_iterations";
        autoresearchLog.finalScore = currentScore.passRate;
        autoresearchLog.totalIterations = iteration;

        sendAgi("agi.autoresearch.complete", {
          baselinePassRate: baselineScore.passRate,
          finalPassRate: currentScore.passRate,
          improvement: currentScore.passRate - baselineScore.passRate,
          iterations: iteration,
          status: autoresearchLog.status,
        });
      } else {
        autoresearchLog.status = "perfect_baseline";
        sendAgi("agi.autoresearch.complete", {
          baselinePassRate: baselineScore.passRate,
          finalPassRate: baselineScore.passRate,
          improvement: 0,
          iterations: 0,
          status: "perfect_baseline",
        });
      }

      saveAutoresearchLog(autoresearchLog);
    }

    // ═══ Pipeline complete ═══
    const completed = ctx.stepResults.filter(r => r.status === "completed").length;
    const failed = ctx.stepResults.filter(r => r.status === "failed").length;
    const success = !aborted && failed === 0;

    sendAgi("agi.pipeline.complete", {
      success,
      totalSteps: steps.length,
      completedSteps: completed,
      failedSteps: failed,
      filesCreated: ctx.allFiles.length,
      totalTokens: ctx.totalTokens,
      projectDir: projName,
      replanCount,
      durationMs: Date.now() - Date.now(), // will be calculated client-side
      summary: `${completed}/${ctx.stepResults.length} steps completed, ${ctx.allFiles.length} files created`,
    });

    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // ── Git Status API ──
  if (url.pathname === "/api/git/status" && req.method === "GET") {
    try {
      const { execSync } = require("node:child_process");
      const raw = execSync("git status --porcelain -u", { cwd: CWD, encoding: "utf-8", timeout: 5000 });
      const status = {};
      for (const line of raw.split("\n").filter(Boolean)) {
        const code = line.slice(0, 2);
        let file = line.slice(3);
        let s = "untracked";
        if (code === "UU" || code === "AA" || code === "DD" || code === "AU" || code === "UA") s = "conflict";
        else if (code.includes("M")) s = "modified";
        else if (code.includes("A")) s = "added";
        else if (code.includes("D")) s = "deleted";
        else if (code.includes("R")) { s = "renamed"; const parts = file.split(" -> "); if (parts.length === 2) file = parts[1]; }
        else if (code.includes("?")) s = "untracked";
        status[file] = s;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }
    return;
  }

  // ── Browse: list folders anywhere on disk ──
  if (url.pathname === "/api/browse" && req.method === "GET") {
    const dir = url.searchParams.get("path") || os.homedir();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: path.join(dir, e.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ current: dir, parent: path.dirname(dir), dirs }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ current: dir, parent: path.dirname(dir), dirs: [], error: e.message }));
    }
    return;
  }

  // ── Guard: file/git/run APIs require a workspace ──
  const _fileApis = ["/api/files", "/api/file", "/api/file/raw", "/api/file/rename", "/api/mkdir", "/api/git/status", "/api/run", "/api/run/stream", "/api/agi/run", "/api/config", "/api/settings", "/api/sessions", "/api/terminal", "/api/status", "/api/auto-agi/run"];
  if (!CWD && _fileApis.some(p => url.pathname === p || url.pathname.startsWith(p + "/"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no_workspace", message: "No workspace open. Open a folder first." }));
    return;
  }

  // ── File viewer ──
  if (url.pathname === "/api/files" && req.method === "GET") {
    const files = [];
    try {
      const walk = (dir, depth = 0) => {
        if (depth > 3) return;
        const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if ([".git", "node_modules", "dist", ".agent", "coverage"].includes(e.name)) continue;
          const full = require("node:path").join(dir, e.name);
          const rel = require("node:path").relative(CWD, full);
          const stat = require("node:fs").statSync(full, { throwIfNoEntry: false });
          const mtime = stat ? stat.mtimeMs : 0;
          if (e.isDirectory()) { files.push({ path: rel, type: "dir", mtime }); walk(full, depth + 1); }
          else files.push({ path: rel, type: "file", mtime });
        }
      };
      walk(CWD);
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  // ── File Read ──
  if (url.pathname === "/api/file" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) { res.writeHead(400); res.end("Missing path"); return; }
    const abs = require("node:path").resolve(CWD, filePath);
    if (!safePath(filePath)) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
      const content = require("node:fs").readFileSync(abs, "utf8");
      const stat = require("node:fs").statSync(abs);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: filePath, content, size: stat.size, modified: stat.mtime.toISOString() }));
    } catch (e) {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // ── Raw File (binary — images, videos, PDFs served with correct MIME) ──
  // Supports HTTP Range requests for video/audio streaming
  if (url.pathname === "/api/file/raw" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    if (!filePath) { res.writeHead(400); res.end("Missing path"); return; }
    const abs = require("node:path").resolve(CWD, filePath);
    const checked = safePath(filePath);
    if (!checked) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
      const stat = require("node:fs").statSync(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end("Not a file"); return; }
      const ext = require("node:path").extname(abs).toLowerCase();
      const mimeTypes = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".bmp": "image/bmp", ".avif": "image/avif",
        ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
        ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".m4v": "video/mp4",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
        ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
        ".pdf": "application/pdf",
        ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
        ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
      };
      const contentType = mimeTypes[ext] || "application/octet-stream";
      const fileSize = stat.size;

      // HTTP Range support (required for video/audio seeking)
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const stream = require("node:fs").createReadStream(abs, { start, end });
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": contentType,
        });
        stream.pipe(res);
      } else {
        // Small files (<10MB): read into memory. Large files: stream.
        if (fileSize < 10 * 1024 * 1024) {
          const content = require("node:fs").readFileSync(abs);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": fileSize,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=60"
          });
          res.end(content);
        } else {
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": fileSize,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=60"
          });
          require("node:fs").createReadStream(abs).pipe(res);
        }
      }
    } catch (e) {
      res.writeHead(404); res.end("Not found: " + e.message);
    }
    return;
  }

  // ── File Write / Create ──
  if (url.pathname === "/api/file" && req.method === "PUT") {
    const body = await readBody(req);
    const { path: filePath, content } = safeJsonParse(body) || {};
    if (!filePath) { res.writeHead(400); res.end("Missing path"); return; }
    const abs = require("node:path").resolve(CWD, filePath);
    if (!safePath(filePath)) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
      const dir = require("node:path").dirname(abs);
      if (!require("node:fs").existsSync(dir)) {
        require("node:fs").mkdirSync(dir, { recursive: true });
      }
      // Support base64 binary uploads (prefixed with __BASE64__)
      if (typeof content === "string" && content.startsWith("__BASE64__")) {
        const buf = Buffer.from(content.slice(10), "base64");
        require("node:fs").writeFileSync(abs, buf);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: filePath, bytes: buf.length, binary: true }));
      } else {
        require("node:fs").writeFileSync(abs, content || "", "utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: filePath, bytes: Buffer.byteLength(content || "", "utf8") }));
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── File Delete ──
  if (url.pathname === "/api/file" && req.method === "DELETE") {
    const body = await readBody(req);
    const { path: filePath } = safeJsonParse(body) || {};
    if (!filePath) { res.writeHead(400); res.end("Missing path"); return; }
    const abs = require("node:path").resolve(CWD, filePath);
    if (!safePath(filePath)) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
      const stat = require("node:fs").statSync(abs);
      if (stat.isDirectory()) {
        require("node:fs").rmSync(abs, { recursive: true, force: true });
      } else {
        require("node:fs").unlinkSync(abs);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deleted: filePath }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── File Rename / Move ──
  if (url.pathname === "/api/file/rename" && req.method === "POST") {
    const body = await readBody(req);
    const { from, to } = safeJsonParse(body) || {};
    if (!from || !to) { res.writeHead(400); res.end("Missing from/to"); return; }
    const absFrom = require("node:path").resolve(CWD, from);
    const absTo = require("node:path").resolve(CWD, to);
    if (!safePath(from) || !safePath(to)) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
      const dir = require("node:path").dirname(absTo);
      if (!require("node:fs").existsSync(dir)) {
        require("node:fs").mkdirSync(dir, { recursive: true });
      }
      require("node:fs").renameSync(absFrom, absTo);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, from, to }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Create Directory ──
  if (url.pathname === "/api/mkdir" && req.method === "POST") {
    const body = await readBody(req);
    const { path: dirPath } = safeJsonParse(body) || {};
    if (!dirPath) { res.writeHead(400); res.end("Missing path"); return; }
    const abs = require("node:path").resolve(CWD, dirPath);
    if (!safePath(dirPath)) { res.writeHead(403); res.end("Forbidden"); return; }
    try {
      require("node:fs").mkdirSync(abs, { recursive: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: dirPath }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Config API (GET) ──
  if (url.pathname === "/api/config" && req.method === "GET") {
    try {
      const configPath = path.join(CWD, ".agent", "config.json");
      const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      // Mask API keys for security
      const safe = JSON.parse(JSON.stringify(config));
      for (const p of ["openai", "anthropic", "gemini"]) {
        if (safe.providers?.[p]?.apiKeyEnv) {
          const key = process.env[safe.providers[p].apiKeyEnv];
          safe.providers[p].apiKeySet = !!key;
          safe.providers[p].apiKeyPreview = key ? key.slice(0, 8) + "..." : "(not set)";
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(safe));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Sessions API (GET) ──
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    try {
      const sessDir = path.join(CWD, ".agent", "sessions");
      const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter(f => f.endsWith(".json") && !f.includes(".tmp")).sort().reverse().slice(0, 50) : [];
      const sessions = [];
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf8"));
          let status = data.status || "unknown";
          let phase = data.phase || "";

          // ── Liveness check: validate "running" sessions ──
          if (status === "running") {
            let processAlive = false;
            if (data.pid) {
              try { process.kill(data.pid, 0); processAlive = true; } catch { processAlive = false; }
            }
            if (!processAlive) {
              // Process is dead — check if it's stale via updatedAt
              const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
              const staleSec = (Date.now() - updatedAt) / 1000;
              if (staleSec > 30 || !data.pid) {
                // Dead process or no PID recorded → mark stale and persist fix
                status = "stale";
                phase = "";
                try {
                  data.status = "stale";
                  data.phase = "";
                  data.updatedAt = new Date().toISOString();
                  fs.writeFileSync(path.join(sessDir, f), JSON.stringify(data, null, 2), "utf8");
                } catch { /* best-effort persist */ }
              }
            }
          }

          sessions.push({
            id: data.id || f.replace(".json", ""),
            task: data.task || "",
            status,
            createdAt: data.createdAt || "",
            updatedAt: data.updatedAt || "",
            phase,
            pid: data.pid || null
          });
        } catch { /* skip corrupt */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    }
    return;
  }

  // ── Session status SSE stream (real-time push) ──
  if (url.pathname === "/api/sessions/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    _sessionSSEClients.add(res);
    // Send initial active children count
    res.write(`data: ${JSON.stringify({ type: "session.connected", activeChildren: _activeChildren.size })}\n\n`);
    req.on("close", () => { _sessionSSEClients.delete(res); });
    return;
  }

  // ── Non-streaming endpoints ──
  if (url.pathname === "/api/run" && req.method === "POST") {
    const body = await readBody(req);
    const { task, mode } = safeJsonParse(body) || {};
    const result = await runAgent(mode || "run", task);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === "/api/doctor" && (req.method === "POST" || req.method === "GET")) {
    try {
      const checks = [];
      // Config check
      const configPath = path.join(CWD, ".agent", "config.json");
      checks.push({ name: "config", status: fs.existsSync(configPath) ? "ok" : "warn", message: fs.existsSync(configPath) ? "Config found" : "No config — using defaults" });
      // Provider checks
      for (const [name, envKey] of [["openai", "OPENAI_API_KEY"], ["anthropic", "ANTHROPIC_API_KEY"]]) {
        checks.push({ name, status: process.env[envKey] ? "ok" : "warn", message: process.env[envKey] ? `${envKey} set` : `${envKey} not set` });
      }
      // OAuth checks
      const codexAuth = path.join(require("os").homedir(), ".codex", "auth.json");
      checks.push({ name: "codex-oauth", status: fs.existsSync(codexAuth) ? "ok" : "warn", message: fs.existsSync(codexAuth) ? "Codex OAuth found" : "No Codex OAuth" });
      // Node
      checks.push({ name: "node", status: "ok", message: `Node.js ${process.version}` });
      // Git
      try { const { execSync } = require("child_process"); checks.push({ name: "git", status: "ok", message: execSync("git --version", { encoding: "utf-8", timeout: 3000 }).trim() }); } catch { checks.push({ name: "git", status: "error", message: "git not found" }); }
      // Build
      checks.push({ name: "build", status: fs.existsSync(path.join(CWD, "dist", "cli.js")) ? "ok" : "warn", message: fs.existsSync(path.join(CWD, "dist", "cli.js")) ? "Build exists" : "Run npm run build" });
      // Workspace
      const entries = fs.readdirSync(CWD).length;
      checks.push({ name: "workspace", status: "ok", message: `${entries} entries` });

      const errors = checks.filter(c => c.status === "error").length;
      const warnings = checks.filter(c => c.status === "warn").length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healthy: errors === 0, checks, summary: `${checks.length} checks: ${checks.length - errors - warnings} ok, ${warnings} warn, ${errors} error` }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healthy: false, checks: [], error: e.message }));
    }
    return;
  }

  if (url.pathname === "/api/check-comments" && req.method === "POST") {
    const result = await runAgent("check-comments");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Auth Status API ──
  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    const result = await runAgent("doctor");
    const stdout = result.stdout || "";

    // Parse doctor output for provider status
    const providers = {};
    for (const id of ["openai", "anthropic", "gemini"]) {
      const match = stdout.match(new RegExp(`provider:${id}\\s+(.+?)(?:\\n|$)`, "i"));
      const line = match ? match[1] : "";
      const ready = line.includes("ready") || line.includes("oauth via");
      const source = line.includes("keychain") ? "keychain" : line.includes("codex") || line.includes("auth.json") ? "~/.codex/auth.json" : line.includes("env") ? "env" : "";
      const mode = line.includes("oauth") ? "oauth" : line.includes("api_key") ? "api_key" : "";
      providers[id] = { ready, source, mode, detail: line.trim() };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ providers, raw: stdout }));
    return;
  }

  // ── Auth Test API ──
  if (url.pathname === "/api/auth/test" && req.method === "POST") {
    const body = await readBody(req);
    const { provider } = safeJsonParse(body) || {};
    if (!provider) { res.writeHead(400); res.end("Missing provider"); return; }

    const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
    const child = spawn(NODE_BIN, [agentCli, "soak", "--providers", provider, "--rounds", "1"], {
      cwd: CWD,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.stderr.on("data", c => stderr += c.toString());

    child.on("close", code => {
      const ok = code === 0 || stdout.includes("pass") || stdout.includes("success");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, provider, exitCode: code, detail: (stdout + stderr).slice(0, 500) }));
    });
    child.on("error", err => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, provider, error: err.message }));
    });

    // Timeout
    setTimeout(() => { try { child.kill(); } catch {} }, 25000);
    return;
  }

  // ── OAuth Login API — opens system terminal + polls for credentials ──
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    const { provider } = safeJsonParse(body) || {};
    if (!provider) { res.writeHead(400); res.end("Missing provider"); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
    const homedir = require("os").homedir();
    const { execSync: execSyncAuth, spawnSync: spawnSyncAuth } = require("node:child_process");

    // ── Resolve CLI paths (don't assume it's in PATH) ──
    function findCli(name) {
      const candidates = [
        name, // PATH
        path.join(homedir, ".local", "bin", name),
        path.join(homedir, ".npm", "bin", name),
        `/usr/local/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
      ];
      // For claude: also check the bundled install
      if (name === "claude") {
        candidates.push(path.join(homedir, ".claude", "local", "node_modules", ".bin", "claude"));
        candidates.push(path.join(homedir, ".claude", "local", "claude"));
      }
      if (name === "codex") {
        candidates.push(path.join(homedir, ".codex", "node_modules", ".bin", "codex"));
      }
      for (const c of candidates) {
        try {
          const resolved = execSyncAuth(`which ${c} 2>/dev/null || echo ""`, { encoding: "utf-8" }).trim();
          if (resolved) return resolved;
        } catch {}
        // Direct check
        try { if (fs.existsSync(c) && fs.statSync(c).mode & 0o111) return c; } catch {}
      }
      return null;
    }

    // ── Provider-specific setup ──
    let credFiles = [];  // Check multiple credential locations
    let shellCmd, installHint, cliPath;

    if (provider === "openai") {
      cliPath = findCli("codex");
      credFiles = [
        path.join(homedir, ".codex", "auth.json"),
      ];
      shellCmd = cliPath ? `${cliPath} auth login` : "npx -y @openai/codex auth login";
      installHint = "npm install -g @openai/codex";
      send({ status: "starting", message: "OpenAI OAuth 로그인을 시작합니다..." });
    } else if (provider === "anthropic") {
      cliPath = findCli("claude");
      credFiles = [
        path.join(homedir, ".claude", ".credentials.json"),  // plaintext
        path.join(homedir, ".claude", "credentials.json"),    // alt location
      ];
      shellCmd = cliPath ? `${cliPath} auth login` : "npx -y @anthropic-ai/claude-code auth login";
      installHint = "npm install -g @anthropic-ai/claude-code";
      send({ status: "starting", message: "Anthropic OAuth 로그인을 시작합니다..." });
    } else if (provider === "gemini") {
      cliPath = findCli("gcloud");
      credFiles = [
        path.join(homedir, ".config", "gcloud", "application_default_credentials.json"),
      ];
      shellCmd = cliPath ? `${cliPath} auth application-default login` : "gcloud auth application-default login";
      installHint = "brew install google-cloud-sdk";
      send({ status: "starting", message: "Google OAuth 로그인을 시작합니다..." });
    } else {
      send({ status: "error", message: `Unknown provider: ${provider}` });
      res.end();
      return;
    }

    // ── Record credential state BEFORE login ──
    const credStatesBefore = {};
    for (const cf of credFiles) {
      try { credStatesBefore[cf] = { mtime: fs.statSync(cf).mtimeMs, size: fs.statSync(cf).size }; }
      catch { credStatesBefore[cf] = null; }
    }

    // For Anthropic on macOS: also check keychain state before
    let keychainBefore = null;
    if (provider === "anthropic" && process.platform === "darwin") {
      try {
        const user = process.env.USER || require("os").userInfo().username;
        const result = spawnSyncAuth("security", ["find-generic-password", "-a", user, "-s", "Claude Code-credentials", "-w"], { encoding: "utf-8" });
        if (result.status === 0 && result.stdout.trim()) {
          keychainBefore = result.stdout.trim().slice(0, 20); // first 20 chars as fingerprint
        }
      } catch {}
    }

    // ── Launch auth command in visible terminal ──
    let launched = false;
    send({ status: "progress", message: `CLI: ${shellCmd}` });

    try {
      if (process.platform === "darwin") {
        // macOS: open Terminal.app with the command
        const escaped = shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        spawn("osascript", [
          "-e", `tell application "Terminal"`,
          "-e", `  activate`,
          "-e", `  do script "${escaped}"`,
          "-e", `end tell`
        ], { detached: true, stdio: "ignore" }).unref();
        launched = true;
        send({ status: "progress", message: "✓ Terminal.app이 열렸습니다. 브라우저에서 로그인하세요." });
      } else if (process.platform === "linux") {
        for (const [cmd, args] of [
          ["gnome-terminal", ["--", "bash", "-c", shellCmd + "; echo 'Done. Press Enter.'; read"]],
          ["xterm", ["-e", shellCmd]],
          ["konsole", ["-e", "bash", "-c", shellCmd]],
        ]) {
          try {
            spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
            launched = true;
            send({ status: "progress", message: `✓ ${cmd}이 열렸습니다. 브라우저에서 로그인하세요.` });
            break;
          } catch { continue; }
        }
      }

      if (!launched) {
        // Fallback: try direct spawn with shell
        spawn("bash", ["-c", shellCmd], { shell: true, detached: true, stdio: "ignore", env: { ...process.env, BROWSER: "open" } }).unref();
        launched = true;
        send({ status: "progress", message: "프로세스가 시작되었습니다." });
      }
    } catch (err) {
      send({ status: "progress", message: `터미널 실행 실패: ${err.message}` });
    }

    if (!launched) {
      send({ status: "progress", message: "터미널을 직접 열고 아래 명령어를 실행하세요:" });
      send({ status: "progress", message: `$ ${shellCmd}` });
      send({ status: "progress", message: `(설치: ${installHint})` });
    }

    send({ status: "progress", message: "로그인 완료 대기 중..." });

    // ── Poll for credential changes (file + keychain) ──
    let attempts = 0;
    const maxAttempts = 90; // 3 min
    const pollInterval = setInterval(async () => {
      attempts++;

      // Check credential files
      for (const cf of credFiles) {
        try {
          const stat = fs.statSync(cf);
          const before = credStatesBefore[cf];
          const changed = !before
            ? true  // newly created
            : (stat.mtimeMs > before.mtime || stat.size !== before.size);
          if (changed) {
            clearInterval(pollInterval);
            send({ status: "success", message: `✓ ${provider} OAuth 연결 완료! (${path.basename(cf)})` });
            res.end();
            return;
          }
        } catch { /* file not yet created */ }
      }

      // For Anthropic: also check macOS keychain
      if (provider === "anthropic" && process.platform === "darwin") {
        try {
          const user = process.env.USER || require("os").userInfo().username;
          const result = spawnSyncAuth("security", ["find-generic-password", "-a", user, "-s", "Claude Code-credentials", "-w"], { encoding: "utf-8", timeout: 3000 });
          if (result.status === 0 && result.stdout.trim()) {
            const keychainNow = result.stdout.trim().slice(0, 20);
            if (keychainNow !== keychainBefore) {
              clearInterval(pollInterval);
              send({ status: "success", message: `✓ Anthropic OAuth 연결 완료! (macOS Keychain)` });
              res.end();
              return;
            }
          }
        } catch {}
      }

      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        send({ status: "error", message: "시간 초과 (3분). 로그인 후 'Check All' 버튼을 눌러주세요." });
        res.end();
      }

      if (attempts % 10 === 0) {
        send({ status: "progress", message: `대기 중... (${attempts * 2}초)` });
      }
    }, 2000);

    req.on("close", () => { clearInterval(pollInterval); });
    return;
  }

  // ── API Key Save API — saves API key to .env ──
  if (url.pathname === "/api/auth/apikey" && req.method === "POST") {
    const body = await readBody(req);
    const { provider, apiKey } = safeJsonParse(body) || {};
    if (!provider || !apiKey) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Missing provider or apiKey" })); return; }

    const envMap = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GEMINI_API_KEY"
    };
    const envVar = envMap[provider];
    if (!envVar) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Unknown provider" })); return; }

    try {
      // Write to .agent/.env for project-local key storage
      const envDir = path.join(CWD, ".agent");
      if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });

      const envPath = path.join(envDir, ".env");
      let content = "";
      try { content = fs.readFileSync(envPath, "utf8"); } catch {}

      // Replace existing or append
      const regex = new RegExp(`^${envVar}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${envVar}=${apiKey}`);
      } else {
        content = content.trimEnd() + (content ? "\n" : "") + `${envVar}=${apiKey}\n`;
      }

      fs.writeFileSync(envPath, content, "utf8");

      // Also set in current process env for immediate use
      process.env[envVar] = apiKey;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, envVar, stored: envPath }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Auth Disconnect API — removes saved credentials ──
  if (url.pathname === "/api/auth/disconnect" && req.method === "POST") {
    const body = await readBody(req);
    const { provider } = safeJsonParse(body) || {};
    if (!provider) { res.writeHead(400); res.end("Missing provider"); return; }

    const envMap = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
    const envVar = envMap[provider];

    try {
      // Remove from .agent/.env
      const envPath = path.join(CWD, ".agent", ".env");
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, "utf8");
        content = content.replace(new RegExp(`^${envVar}=.*\\n?`, "m"), "");
        fs.writeFileSync(envPath, content, "utf8");
      }

      // Remove from process env
      delete process.env[envVar];

      // For OAuth: try to remove auth files
      if (provider === "openai") {
        const codexAuth = path.join(require("os").homedir(), ".codex", "auth.json");
        if (fs.existsSync(codexAuth)) fs.unlinkSync(codexAuth);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: `${provider} 연결이 해제되었습니다.` }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── Terminal API (persistent shell session) ──
  if (url.pathname === "/api/terminal" && req.method === "POST") {
    const body = await readBody(req);
    const { command } = safeJsonParse(body) || {};
    if (!command) { res.writeHead(400); res.end("Missing command"); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    let closed = false;
    const send = (type, text) => {
      if (!closed) res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
    };

    // Handle cd internally by tracking cwd
    if (!global._termCwd) global._termCwd = CWD;

    const cdMatch = command.match(/^\s*cd\s+(.+)\s*$/);
    if (cdMatch) {
      const target = cdMatch[1].replace(/^~/, require("os").homedir());
      const resolved = require("path").resolve(global._termCwd, target);
      try {
        if (require("fs").statSync(resolved).isDirectory()) {
          global._termCwd = resolved;
          send("stdout", resolved + "\n");
          send("exit", "0");
        } else {
          send("stderr", "cd: not a directory: " + target + "\n");
          send("exit", "1");
        }
      } catch {
        send("stderr", "cd: no such directory: " + target + "\n");
        send("exit", "1");
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Handle pwd
    if (command.trim() === "pwd") {
      send("stdout", global._termCwd + "\n");
      send("exit", "0");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const shell = process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = spawn(shell, shellArgs, {
      cwd: global._termCwd,
      env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1", HOME: require("os").homedir() },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", chunk => send("stdout", chunk.toString()));
    child.stderr.on("data", chunk => send("stderr", chunk.toString()));
    child.on("close", code => {
      send("exit", String(code ?? 0));
      res.write("data: [DONE]\n\n");
      closed = true;
      res.end();
    });
    child.on("error", err => {
      send("error", err.message);
      res.write("data: [DONE]\n\n");
      closed = true;
      res.end();
    });

    req.on("close", () => { closed = true; try { child.kill("SIGTERM"); } catch {} });
    // No timeout — long-running sessions are expected
    return;
  }

  // ── Settings API ──
  if (url.pathname === "/api/settings" && req.method === "GET") {
    const configPath = path.join(CWD, ".agent", "config.json");
    try {
      const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(content);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === "/api/settings" && req.method === "PUT") {
    const body = await readBody(req);
    const parsed = safeJsonParse(body);
    if (!parsed) { res.writeHead(400); res.end("Invalid JSON"); return; }
    const configPath = path.join(CWD, ".agent", "config.json");
    try {
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const result = await runAgent("status");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // ── Workspace API ──
  if (url.pathname === "/api/workspace" && req.method === "GET") {
    let hist = {};
    try { hist = JSON.parse(fs.readFileSync(WORKSPACE_HISTORY_PATH, "utf8")); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      current: CWD,
      name: CWD ? path.basename(CWD) : null,
      recent: (hist.recent || []).filter(d => fs.existsSync(d)).slice(0, 10),
    }));
    return;
  }

  // Open folder — via native dialog (macOS osascript)
  if (url.pathname === "/api/workspace/open" && req.method === "POST") {
    const body = await readBody(req);
    const { dir } = safeJsonParse(body) || {};

    if (dir) {
      // Direct open — user provided a path
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Directory not found: " + dir }));
        return;
      }
      CWD = dir;
      saveWorkspaceHistory(dir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, dir: CWD, name: path.basename(CWD) }));
      return;
    }

    // No dir provided — show native folder picker
    try {
      const { execSync } = require("node:child_process");
      const script = `osascript -e 'POSIX path of (choose folder with prompt "Open Seed — 프로젝트 폴더 선택")'`;
      const chosen = execSync(script, { encoding: "utf-8", timeout: 60000 }).trim();
      // osascript returns path with trailing /
      const cleanPath = chosen.endsWith("/") ? chosen.slice(0, -1) : chosen;

      if (cleanPath && fs.existsSync(cleanPath)) {
        CWD = cleanPath;
        saveWorkspaceHistory(cleanPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, dir: CWD, name: path.basename(CWD) }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, cancelled: true }));
      }
    } catch (e) {
      // User cancelled or error
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, cancelled: true, error: e.message }));
    }
    return;
  }

  // List directories for folder browsing
  if (url.pathname === "/api/workspace/browse" && req.method === "GET") {
    const dir = url.searchParams.get("dir") || require("os").homedir();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ dir, entries, parent: path.dirname(dir) }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ dir, entries: [], error: e.message }));
    }
    return;
  }

  // ── Codebase Map API ──
  if (url.pathname === "/api/repomap" && req.method === "GET") {
    const targetDir = url.searchParams.get("dir") || CWD;
    const abs = path.resolve(CWD, targetDir);
    try {
      const map = buildRepoMap(abs);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(map));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── User Profile API ──
  if (url.pathname === "/api/profile" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getUserProfile()));
    return;
  }
  if (url.pathname === "/api/profile" && req.method === "PUT") {
    const body = await readBody(req);
    const update = safeJsonParse(body) || {};
    const profile = updateUserProfile(update);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(profile));
    return;
  }

  // ── Autonomous AGI Task Queue API ──
  if (url.pathname === "/api/auto-agi/queue" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getTaskQueue()));
    return;
  }
  if (url.pathname === "/api/auto-agi/queue" && req.method === "POST") {
    const body = await readBody(req);
    const { task, priority, category } = safeJsonParse(body) || {};
    if (!task) { res.writeHead(400); res.end("Missing task"); return; }
    const q = getTaskQueue();
    const newTask = {
      id: "task-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      task,
      priority: priority || "normal",
      category: category || "general",
      status: "queued",
      createdAt: new Date().toISOString(),
      result: null,
    };
    q.tasks.push(newTask);
    // Sort by priority
    const pOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    q.tasks.sort((a, b) => (pOrder[a.priority] || 2) - (pOrder[b.priority] || 2));
    saveTaskQueue(q);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(newTask));
    return;
  }
  if (url.pathname === "/api/auto-agi/queue" && req.method === "DELETE") {
    const body = await readBody(req);
    const { taskId } = safeJsonParse(body) || {};
    const q = getTaskQueue();
    q.tasks = q.tasks.filter(t => t.id !== taskId);
    saveTaskQueue(q);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Autonomous AGI Run (processes queue autonomously via SSE) ──
  if (url.pathname === "/api/auto-agi/run" && req.method === "POST") {
    const body = await readBody(req);
    const { mode } = safeJsonParse(body) || {}; // mode: "queue" | "observe" | "proactive"

    if (autoAgiRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Autonomous AGI already running" }));
      return;
    }

    autoAgiRunning = true;
    autoAgiAbort = false;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    const sendAuto = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
    };

    req.on("close", () => { autoAgiAbort = true; });

    // Load user profile for context
    const profile = getUserProfile();
    profile.totalSessions = (profile.totalSessions || 0) + 1;
    updateUserProfile(profile);

    // Build codebase understanding
    sendAuto("auto.status", { message: "Building codebase map...", phase: "init" });
    const repoMap = buildRepoMap(CWD);
    sendAuto("auto.repomap", { files: repoMap.totalFiles, languages: repoMap.languages, entryPoints: repoMap.entryPoints });

    if (mode === "proactive") {
      // Proactive mode: analyze codebase and generate tasks automatically
      sendAuto("auto.status", { message: "Analyzing codebase for improvements...", phase: "analyze" });

      const analysisPrompt = `You are an autonomous AGI analyzing a codebase. Generate a prioritized list of tasks.

CODEBASE:
- Files: ${repoMap.totalFiles} total, ${repoMap.totalLines} lines
- Languages: ${Object.entries(repoMap.languages).map(([l,c]) => `${l}: ${c}`).join(", ")}
- Entry points: ${repoMap.entryPoints.join(", ")}
- Configs: ${repoMap.configs.join(", ")}

USER PROFILE:
- Sessions: ${profile.totalSessions}
- Recent tasks: ${(profile.recentTasks || []).slice(-5).join("; ")}
- Tech preferences: ${JSON.stringify(profile.preferences || {})}

Analyze and output a JSON array of tasks. Each task: {"task": "description", "priority": "critical|high|normal|low", "category": "bug|feature|refactor|test|docs|security|performance"}
Focus on: bugs, missing tests, security issues, performance improvements, code quality.
Output ONLY the JSON array, nothing else.`;

      try {
        const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
        const analysisResult = await new Promise((resolve, reject) => {
          const child = spawn(NODE_BIN, [agentCli, "run", analysisPrompt], {
            cwd: CWD, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"]
          });
          let out = "";
          child.stdout.on("data", c => { out += c.toString(); });
          child.on("close", () => resolve(out));
          child.on("error", reject);
          setTimeout(() => { try { child.kill(); } catch {} }, 120000);
        });

        // Try to extract JSON array from output
        const jsonMatch = analysisResult.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          const tasks = JSON.parse(jsonMatch[0]);
          const q = getTaskQueue();
          for (const t of tasks) {
            q.tasks.push({
              id: "auto-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              task: t.task,
              priority: t.priority || "normal",
              category: t.category || "general",
              status: "queued",
              createdAt: new Date().toISOString(),
              source: "proactive",
              result: null,
            });
          }
          saveTaskQueue(q);
          sendAuto("auto.tasks-generated", { count: tasks.length, tasks: tasks.slice(0, 10) });
        }
      } catch (e) {
        sendAuto("auto.error", { message: "Analysis failed: " + e.message });
      }
    }

    // Process task queue
    const q = getTaskQueue();
    const pendingTasks = q.tasks.filter(t => t.status === "queued");

    if (pendingTasks.length === 0) {
      sendAuto("auto.status", { message: "No tasks in queue", phase: "idle" });
      sendAuto("auto.complete", { processed: 0 });
      res.write("data: [DONE]\n\n");
      res.end();
      autoAgiRunning = false;
      return;
    }

    sendAuto("auto.status", { message: `Processing ${pendingTasks.length} tasks...`, phase: "execute" });
    let processed = 0;
    let succeeded = 0;

    for (const task of pendingTasks) {
      if (autoAgiAbort) break;

      task.status = "running";
      task.startedAt = new Date().toISOString();
      q.active = task.id;
      saveTaskQueue(q);

      sendAuto("auto.task-start", { taskId: task.id, task: task.task, priority: task.priority, category: task.category, index: processed, total: pendingTasks.length });

      // Build context-aware prompt with user profile + codebase knowledge
      const taskPrompt = buildAutoAgiPrompt(task, profile, repoMap);

      try {
        const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
        const taskMode = task.category === "refactor" || task.category === "feature" ? "team" : "run";

        const result = await new Promise((resolve, reject) => {
          if (autoAgiAbort) { reject(new Error("Aborted")); return; }
          const child = spawn(NODE_BIN, [agentCli, taskMode, taskPrompt], {
            cwd: CWD, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"]
          });
          let stdout = "", stderr = "";
          child.stdout.on("data", c => {
            const text = c.toString();
            stdout += text;
            // Forward events to client
            for (const line of text.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const parsed = parseEventLine(trimmed);
              if (parsed) {
                if (parsed.eventType === "tool.completed") {
                  sendAuto("auto.event", { taskId: task.id, ...parsed });
                } else if (parsed.eventType === "provider.stream") {
                  const chunk = parsed.payload?.chunk || parsed.payload?.delta || "";
                  if (chunk) sendAuto("auto.llm", { taskId: task.id, text: typeof chunk === "string" ? chunk : "" });
                }
              }
            }
          });
          child.stderr.on("data", c => { stderr += c.toString(); });
          child.on("close", code => resolve({ stdout, stderr, code }));
          child.on("error", reject);

          // Abort check
          const iv = setInterval(() => { if (autoAgiAbort) { child.kill("SIGTERM"); clearInterval(iv); } }, 2000);
          child.on("close", () => clearInterval(iv));
        });

        task.status = result.code === 0 ? "completed" : "failed";
        task.completedAt = new Date().toISOString();
        task.result = { exitCode: result.code, summary: result.stdout.slice(-2000) };
        if (task.status === "completed") succeeded++;

        sendAuto("auto.task-complete", { taskId: task.id, status: task.status, index: processed, total: pendingTasks.length });

        // Learn from this task
        profile.recentTasks = [...(profile.recentTasks || []).slice(-20), task.task];
        updateUserProfile(profile);

      } catch (e) {
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.result = { error: e.message };
        sendAuto("auto.task-error", { taskId: task.id, error: e.message });
      }

      // Move to completed
      q.tasks = q.tasks.filter(t => t.id !== task.id);
      q.completed.push(task);
      q.active = null;
      saveTaskQueue(q);
      processed++;
    }

    sendAuto("auto.complete", { processed, succeeded, failed: processed - succeeded });
    res.write("data: [DONE]\n\n");
    res.end();
    autoAgiRunning = false;
    return;
  }

  // ── Autonomous AGI Stop ──
  if (url.pathname === "/api/auto-agi/stop" && req.method === "POST") {
    autoAgiAbort = true;
    autoAgiRunning = false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stopped: true }));
    return;
  }

  // ── Autonomous AGI Status ──
  if (url.pathname === "/api/auto-agi/status" && req.method === "GET") {
    const q = getTaskQueue();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      running: autoAgiRunning,
      queueLength: q.tasks.length,
      completedCount: q.completed.length,
      activeTask: q.active,
    }));
    return;
  }

  // ── Static files ──
  const staticPath = path.resolve(APP_DIR, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (!staticPath.startsWith(APP_DIR) || !fs.existsSync(staticPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(staticPath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2"
  }[ext] || "application/octet-stream";

  const content = fs.readFileSync(staticPath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);

  } catch (err) {
    console.error("Server error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Internal server error" }));
    }
  }
});

function runAgent(...args) {
  return new Promise((resolve) => {
    const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
    const child = spawn(NODE_BIN, [agentCli, ...args], {
      cwd: CWD,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: -1, stdout: "", stderr: err.message }));
  });
}

function buildAutoAgiPrompt(task, profile, repoMap) {
  const sections = [];
  sections.push(`# Autonomous AGI Task`);
  sections.push(`## Task\n${task.task}`);
  sections.push(`## Priority: ${task.priority} | Category: ${task.category}`);

  // Codebase context
  sections.push(`## Codebase Context`);
  sections.push(`- ${repoMap.totalFiles} files, ${repoMap.totalLines} lines`);
  sections.push(`- Languages: ${Object.entries(repoMap.languages).map(([l,c]) => `${l}(${c})`).join(", ")}`);
  sections.push(`- Entry points: ${repoMap.entryPoints.slice(0, 10).join(", ")}`);
  sections.push(`- Config files: ${repoMap.configs.slice(0, 10).join(", ")}`);

  // User context
  if (profile.preferences && Object.keys(profile.preferences).length > 0) {
    sections.push(`## User Preferences\n${JSON.stringify(profile.preferences)}`);
  }
  if (profile.techStack && profile.techStack.length > 0) {
    sections.push(`## Preferred Tech: ${profile.techStack.join(", ")}`);
  }

  // Instructions
  sections.push(`## Instructions`);
  sections.push(`- Work autonomously. Complete the task fully.`);
  sections.push(`- Write ALL code with COMPLETE content. No placeholders.`);
  sections.push(`- Run tests/verification after changes.`);
  sections.push(`- Follow existing code patterns and conventions.`);
  sections.push(`- If this is a bug fix, identify root cause first.`);
  sections.push(`- If this is a feature, design before implementing.`);

  return sections.join("\n\n");
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
  });
}

function parseEventLine(line) {
  // Parse timestamp-prefixed event lines: "HH:MM:SS event_type payload"
  const match = line.match(/^(\d{2}:\d{2}:\d{2})\s+(\S+)\s*(.*)?$/);
  if (!match) return null;

  const [, time, eventType, payload] = match;
  const result = { time, eventType };

  if (payload) {
    // Try JSON parse
    try {
      result.payload = JSON.parse(payload);
    } catch {
      result.payload = payload;
    }
  }

  return result;
}

// Disable default timeouts — AGI pipeline steps can run 30+ minutes
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║  agent40 app                     ║`);
  console.log(`  ║  http://localhost:${PORT}            ║`);
  console.log(`  ║  cwd: ${(CWD || "(no workspace)").slice(-28).padEnd(28)}║`);
  console.log(`  ╚══════════════════════════════════╝\n`);

  // Only auto-open browser if NOT launched from desktop app
  if (!process.env.OPENSEED_DESKTOP) {
    const openCmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    spawn(openCmd, [`http://localhost:${PORT}`], { stdio: "ignore", detached: true }).unref();
  }
});
