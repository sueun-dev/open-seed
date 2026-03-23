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
const os = require("node:os");
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
      const STOPWORDS = new Set(["what","where","when","which","does","this","that","have","from","with","about","should","could","would","their","there","these","those","after","before","between","during","into"]);
      const keywords = question.split(" ").filter(Boolean)
        .map(w => { let clean = ""; for (const ch of w) { const c = ch.charCodeAt(0); if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) clean += ch; } return clean; })
        .filter(w => w.length > 4 && !STOPWORDS.has(w.toLowerCase()))
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
      const fileLower = activeFile.toLowerCase();
      const isTest = fileLower.includes(".test.") || fileLower.includes(".spec.");
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
    const { task: rawTask, targetDir, provider } = safeJsonParse(body) || {};
    if (!rawTask) { res.writeHead(400); res.end("Missing task"); return; }
    // task will be cleaned of [Previous Run: ...] tags after previous-run detection
    let task = rawTask;

    // Workspace setup — targetDir can be absolute path or relative to CWD
    if (!CWD) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No workspace open. Open a folder first." }));
      return;
    }
    let childCwd = CWD;
    let projName = path.basename(CWD);
    if (targetDir) {
      // If absolute path, use directly; otherwise join with CWD
      childCwd = path.isAbsolute(targetDir) ? targetDir : path.join(CWD, targetDir);
      projName = path.basename(childCwd);
      if (!fs.existsSync(childCwd)) {
        try {
          fs.mkdirSync(childCwd, { recursive: true });
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          const hint = path.isAbsolute(targetDir)
            ? `Target folder "${targetDir}" could not be created. If you meant a workspace subfolder, use "${targetDir.replace(/^\/+/, "")}" instead of an absolute path.`
            : `Target folder "${targetDir}" could not be created inside the workspace.`;
          res.end(JSON.stringify({ error: `${hint} ${error.message}` }));
          return;
        }
      }
    }
    // No targetDir → childCwd stays as CWD (workspace root). This is intentional:
    // the user chose not to set a target, so build in-place. Previous Run detection
    // works because the same folder is reused.

    // ═══ Previous Run Detection (before SSE starts) ═══
    const prevAgentDir = path.join(childCwd, ".agent");
    const prevRunSummaryPath = path.join(prevAgentDir, "run-summary.json");
    let previousRunSummary = null;
    const taskLower = task.toLowerCase();
    const userChoseContinue = taskLower.includes("[previous run: continue]");
    const userChoseFresh = taskLower.includes("[previous run: fresh]");
    const userAlreadyChose = userChoseContinue || userChoseFresh;

    if (fs.existsSync(prevRunSummaryPath)) {
      try { previousRunSummary = JSON.parse(fs.readFileSync(prevRunSummaryPath, "utf8")); } catch {}
    }

    // If previous run exists and user hasn't chosen yet → ask via SSE and return
    if (previousRunSummary && !userAlreadyChose) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      const sendEvt = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
      const prevTask = previousRunSummary.task || "(unknown)";
      const prevFiles = previousRunSummary.filesCreated || 0;
      const prevSteps = previousRunSummary.completedSteps || 0;
      const prevTotal = previousRunSummary.totalSteps || 0;
      const prevSuccess = previousRunSummary.success;
      const prevDate = previousRunSummary.completedAt ? new Date(previousRunSummary.completedAt).toLocaleString() : "unknown";
      const isKo = Array.from(task || "").some(ch => ch.charCodeAt(0) >= 0xAC00 && ch.charCodeAt(0) <= 0xD7A3);
      sendEvt("agi.previous_run.detected", {
        previousTask: prevTask, filesCreated: prevFiles, stepsCompleted: `${prevSteps}/${prevTotal}`,
        success: prevSuccess, completedAt: prevDate,
        decisions: (previousRunSummary.decisions || []).slice(0, 5),
        debateConclusion: previousRunSummary.debateConclusion || "",
        message: isKo
          ? `이전 실행 결과가 있습니다 (${prevDate}). 이어서 할까요, 새로 시작할까요?`
          : `A previous run exists (${prevDate}). Continue from it or start fresh?`,
        options: [
          { id: "continue", label: isKo ? "이어서 하기" : "Continue",
            detail: isKo ? `이전 분석/결정을 유지하고 그 위에 작업합니다 (${prevFiles}개 파일 보존)` : `Keep previous analysis/decisions and build on top (${prevFiles} files preserved)`,
            promptFragment: "[Previous Run: continue]" },
          { id: "fresh", label: isKo ? "새로 시작" : "Start Fresh",
            detail: isKo ? "이전 결과를 모두 삭제하고 처음부터 다시 시작합니다" : "Delete previous results and start from scratch",
            promptFragment: "[Previous Run: fresh]" }
        ]
      });
      sendEvt("agi.pipeline.awaiting_input", { stepId: "pre-pipeline", stepType: "previous_run_check", nextStep: "analyze", reason: "previous_run_detected" });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // ═══ Preflight Self-Healing System (AI-Driven) ═══
    // 1. Run deterministic checks (is git installed? is node 18+? etc.)
    // 2. If ANY check fails → ask AI to diagnose and fix it
    // 3. AI runs bash commands, reads error output, tries solutions
    // 4. If AI can't fix → AI explains to user what to do
    // NO hardcoded remedies. AI decides everything.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    const sendPreflight = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
    };
    sendPreflight("agi.preflight.start", { message: "Running pre-flight checks..." });

    const cp = require("child_process");
    const selectedProvider = provider || "openai";

    const envInfo = {
      platform: process.platform, arch: process.arch, nodeVersion: process.version,
      shell: process.env.SHELL || "unknown", home: os.homedir(), cwd: childCwd,
      user: os.userInfo().username, pathDirs: (process.env.PATH || "").split(":").slice(0, 10),
    };

    // ── Reusable check functions (used for initial check AND re-verification) ──
    const checkFns = {
      "git": () => {
        const out = cp.execSync("git --version 2>&1", { encoding: "utf8", timeout: 5000 }).trim();
        if (!out.includes("git version")) throw new Error("git not found");
      },
      "node": () => {
        const major = parseInt(process.version.replace("v", "").split(".")[0], 10);
        if (major < 18) throw new Error(`Node.js ${process.version} too old (need 18+)`);
      },
      "npm": () => {
        cp.execSync("npm --version", { stdio: "ignore", timeout: 5000 });
      },
      "provider-auth": () => {
        const { getProviderAuthStatus } = require(path.join(PROJECT_DIR, "dist", "providers", "auth.js"));
        let testConfig;
        try { testConfig = JSON.parse(fs.readFileSync(path.join(CWD, ".agent", "config.json"), "utf8")); } catch {
          testConfig = { providers: {
            anthropic: { enabled: selectedProvider === "anthropic" || selectedProvider === "both", authMode: "oauth", defaultModel: "claude-opus-4-6" },
            openai: { enabled: selectedProvider === "openai" || selectedProvider === "both", authMode: "oauth", defaultModel: "gpt-5.4" }
          }};
        }
        const toCheck = selectedProvider === "both" ? ["anthropic", "openai"] : [selectedProvider];
        for (const pid of toCheck) {
          const status = getProviderAuthStatus(pid, testConfig.providers?.[pid]);
          if (!status.ready) throw new Error(`${pid}: ${status.summary}`);
        }
      },
      "write-access": () => {
        const testFile = path.join(childCwd, ".agi-preflight-test");
        fs.writeFileSync(testFile, "test", "utf8");
        fs.unlinkSync(testFile);
      },
      "disk-space": () => {
        const dfOut = cp.execSync(`df -k "${childCwd}" 2>&1 | tail -1`, { encoding: "utf8", timeout: 5000 });
        const parts = dfOut.trim().split(" ").filter(Boolean);
        const availKB = parseInt(parts[3], 10);
        if (Number.isFinite(availKB) && availKB < 500000) throw new Error(`Only ${Math.round(availKB / 1024)}MB free (need 500MB+)`);
      },
    };

    // ── Run all checks ──
    const preflightChecks = [];
    for (const [name, fn] of Object.entries(checkFns)) {
      try {
        fn();
        preflightChecks.push({ name, status: "ok", error: null });
        sendPreflight("agi.preflight.check", { name, status: "ok" });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        preflightChecks.push({ name, status: "failed", error });
        sendPreflight("agi.preflight.check", { name, status: "failed", error });
      }
    }

    const failures = preflightChecks.filter(c => c.status === "failed");

    if (failures.length > 0) {
      sendPreflight("agi.preflight.healing", {
        message: `${failures.length} issue(s) found — AI is diagnosing and attempting to fix...`,
        failures: failures.map(f => ({ name: f.name, error: f.error }))
      });

      // ── Find a working provider for the healing LLM call ──
      let healingProvider = null;
      const providerAuthFailed = failures.some(f => f.name === "provider-auth");
      if (!providerAuthFailed) {
        healingProvider = selectedProvider === "both" ? "anthropic" : selectedProvider;
      } else {
        // Selected provider's auth is broken — try the other one
        for (const alt of ["anthropic", "openai"]) {
          if (alt === selectedProvider) continue;
          try {
            const { getProviderAuthStatus } = require(path.join(PROJECT_DIR, "dist", "providers", "auth.js"));
            const defaultCfg = { enabled: true, authMode: "oauth", defaultModel: alt === "anthropic" ? "claude-opus-4-6" : "gpt-5.4" };
            if (getProviderAuthStatus(alt, defaultCfg).ready) { healingProvider = alt; break; }
          } catch {}
        }
      }

      let healed = false;

      if (healingProvider) {
        try {
          const { ProviderRegistry } = require(path.join(PROJECT_DIR, "dist", "providers", "registry.js"));
          const { loadConfig } = require(path.join(PROJECT_DIR, "dist", "core", "config.js"));
          const healConfig = await loadConfig(CWD);
          const healRegistry = new ProviderRegistry();

          const failureReport = failures.map(f => `- ${f.name}: ${f.error}`).join("\n");
          const healPrompt = `You are a system diagnostician for an AGI coding engine.

## Environment
- Platform: ${envInfo.platform} (${envInfo.arch})
- Node: ${envInfo.nodeVersion}
- Shell: ${envInfo.shell}
- User: ${envInfo.user}
- Home: ${envInfo.home}
- Working directory: ${envInfo.cwd}
- PATH: ${envInfo.pathDirs.join(":")}
- Selected AI provider: ${selectedProvider}

## Failed Pre-flight Checks
${failureReport}

## Your Job
For EACH failure, output bash commands to fix it. If you CANNOT fix it via bash (e.g., OAuth requires interactive login), explain clearly in userGuidance.

Rules:
- SAFE commands only. NEVER use: rm -rf /, rm -rf ~, dd, mkfs, format, or any destructive command
- Do NOT delete user data or project files
- Prefer package managers (brew on macOS, apt on Linux)
- No sudo unless absolutely required
- Match the user's language for userGuidance (Korean if task is Korean)

User's task: "${task.slice(0, 100)}"

Output ONLY valid JSON:
{
  "fixes": [
    { "name": "check-name", "commands": ["safe bash command"], "explanation": "what this does" }
  ],
  "userGuidance": "For issues that need manual action. Empty string if all auto-fixed."
}`;

          const healResponse = await healRegistry.invokeWithFailover(healConfig, healingProvider, {
            role: "planner", category: "planning",
            systemPrompt: "You are a system diagnostician. Output valid JSON only.",
            prompt: healPrompt, responseFormat: "json"
          }, {
            onTextDelta: async (chunk) => {
              if (typeof chunk === "string" && chunk.trim()) sendPreflight("agi.preflight.healing.stream", { text: chunk });
            }
          });

          // Parse AI response
          let healPlan = null;
          try {
            const raw = healResponse.text.trim();
            const start = raw.indexOf("{");
            const end = raw.lastIndexOf("}");
            if (start !== -1 && end > start) healPlan = JSON.parse(raw.slice(start, end + 1));
          } catch {}

          if (healPlan?.fixes && Array.isArray(healPlan.fixes)) {
            // ── Dangerous command blocklist — AI should never run these ──
            const dangerousPatterns = ["rm -rf /", "rm -rf ~", "mkfs", "dd if=", "format c:", "> /dev/sd", "chmod 777 /", ":(){ :|:& };:"];

            for (const fix of healPlan.fixes) {
              if (!fix.commands || !Array.isArray(fix.commands)) continue;
              sendPreflight("agi.preflight.healing.attempt", { name: fix.name, explanation: fix.explanation || "", commands: fix.commands });
              for (const cmd of fix.commands) {
                if (typeof cmd !== "string" || !cmd.trim()) continue;
                // Block dangerous commands
                const cmdLower = cmd.toLowerCase();
                if (dangerousPatterns.some(d => cmdLower.includes(d))) {
                  sendPreflight("agi.preflight.healing.result", { command: cmd, success: false, error: "BLOCKED — dangerous command" });
                  continue;
                }
                try {
                  const output = cp.execSync(cmd, { encoding: "utf8", timeout: 120000, cwd: childCwd, stdio: ["ignore", "pipe", "pipe"] });
                  sendPreflight("agi.preflight.healing.result", { command: cmd, success: true, output: (output || "").slice(0, 500) });
                } catch (cmdErr) {
                  const stderr = cmdErr.stderr ? cmdErr.stderr.toString().slice(0, 500) : cmdErr.message;
                  sendPreflight("agi.preflight.healing.result", { command: cmd, success: false, error: stderr });
                }
              }
            }

            // ── Re-verify using the SAME check functions (DRY) ──
            const stillFailing = [];
            for (const f of failures) {
              const checkFn = checkFns[f.name];
              if (!checkFn) { stillFailing.push(f); continue; }
              try {
                checkFn();
                sendPreflight("agi.preflight.check", { name: f.name, status: "fixed" });
              } catch {
                stillFailing.push(f);
              }
            }

            if (stillFailing.length === 0) {
              healed = true;
              sendPreflight("agi.preflight.healed", { message: `AI fixed ${failures.length} issue(s). Continuing pipeline.` });
            } else {
              sendPreflight("agi.preflight.failed", {
                message: healPlan.userGuidance || `${stillFailing.length} issue(s) could not be auto-fixed.`,
                failures: stillFailing.map(f => ({ name: f.name, error: f.error }))
              });
            }
          } else {
            sendPreflight("agi.preflight.failed", {
              message: healPlan?.userGuidance || `AI could not generate a fix plan for: ${failures.map(f => f.name).join(", ")}`,
              failures: failures.map(f => ({ name: f.name, error: f.error }))
            });
          }
        } catch (healErr) {
          sendPreflight("agi.preflight.failed", {
            message: `AI healing failed: ${healErr.message || healErr}. Manual intervention needed.`,
            failures: failures.map(f => ({ name: f.name, error: f.error }))
          });
        }
      } else {
        sendPreflight("agi.preflight.failed", {
          message: "No AI provider available to diagnose issues. Please fix manually and retry.",
          failures: failures.map(f => ({ name: f.name, error: f.error }))
        });
      }

      if (!healed) {
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
    } else {
      sendPreflight("agi.preflight.passed", {
        message: `All ${preflightChecks.length} checks passed`,
        checks: preflightChecks.map(r => r.name)
      });
    }

    // ── Git init (now safe — we know git is installed) ──
    if (!fs.existsSync(path.join(childCwd, ".git"))) {
      cp.execSync("git init", { cwd: childCwd, stdio: "ignore" });
      cp.execSync("git commit --allow-empty -m 'init'", { cwd: childCwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "AGI", GIT_AUTHOR_EMAIL: "agi@local", GIT_COMMITTER_NAME: "AGI", GIT_COMMITTER_EMAIL: "agi@local" } });
    }

    // Strip the [Previous Run: ...] tag from task for downstream use
    // Strip [Previous Run: continue] or [Previous Run: fresh] tags from task
    for (const tag of ["[Previous Run: continue]", "[Previous Run: fresh]", "[previous run: continue]", "[previous run: fresh]"]) {
      while (task.toLowerCase().includes(tag.toLowerCase())) {
        const idx = task.toLowerCase().indexOf(tag.toLowerCase());
        task = (task.slice(0, idx) + task.slice(idx + tag.length)).trim();
      }
    }

    // Load previous artifacts if user chose "continue"
    let previousContext = null;
    if (userChoseContinue && previousRunSummary) {
      previousContext = {
        task: previousRunSummary.task,
        analyzeArtifact: previousRunSummary.analyzeArtifact || null,
        debateArtifact: previousRunSummary.debateArtifact || null,
        designArtifact: previousRunSummary.designArtifact || null,
        decisions: previousRunSummary.decisions || [],
        filesCreated: previousRunSummary.allFiles || [],
        debateConclusion: previousRunSummary.debateConclusion || "",
        completedAt: previousRunSummary.completedAt
      };
    }

    // Clean .agent/ — always clean sessions/traces, but archive run-summary
    if (fs.existsSync(prevAgentDir)) {
      // Archive previous run-summary into runs/ before cleaning
      if (previousRunSummary) {
        const runsDir = path.join(prevAgentDir, "runs");
        if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
        const archiveId = previousRunSummary.runId || `run-${Date.now()}`;
        try {
          fs.writeFileSync(path.join(runsDir, `${archiveId}.json`), JSON.stringify(previousRunSummary, null, 2), "utf8");
        } catch {}
      }
      // Clean sessions, traces, config (but keep runs/ archive)
      const keepDirs = new Set(["runs"]);
      try {
        for (const entry of fs.readdirSync(prevAgentDir)) {
          if (keepDirs.has(entry)) continue;
          const entryPath = path.join(prevAgentDir, entry);
          try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch {}
        }
      } catch {}
    }

    // Build config — start from source config or create default
    const srcConfig = path.join(CWD, ".agent", "config.json");
    const dstConfigDir = path.join(childCwd, ".agent");
    const dstConfig = path.join(dstConfigDir, "config.json");
    if (!fs.existsSync(dstConfigDir)) fs.mkdirSync(dstConfigDir, { recursive: true });

    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(srcConfig, "utf8")); } catch {
      // No source config — build minimal default
      cfg = {
        providers: {
          anthropic: { enabled: true, authMode: "oauth", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN", defaultModel: "claude-opus-4-6", timeoutMs: 0, maxRetries: 3 },
          openai: { enabled: true, authMode: "oauth", oauthTokenEnv: "OPENAI_OAUTH_TOKEN", defaultModel: "gpt-5.4", timeoutMs: 0, maxRetries: 3 },
          gemini: { enabled: false, authMode: "api_key", defaultModel: "gemini-2.5-pro", timeoutMs: 0, maxRetries: 3 }
        },
        routing: { categories: { planning: "openai", research: "openai", execution: "openai", frontend: "openai", review: "openai" } }
      };
    }

    // Set unlimited timeouts
    for (const p of ["openai", "anthropic", "gemini"]) {
      if (cfg.providers?.[p]) cfg.providers[p].timeoutMs = 0;
    }

    // Apply provider selection from UI (selectedProvider already set in preflight)
    if (selectedProvider === "anthropic") {
      if (cfg.providers?.anthropic) { cfg.providers.anthropic.enabled = true; cfg.providers.anthropic.authMode = "oauth"; }
      if (cfg.providers?.openai) cfg.providers.openai.enabled = false;
      if (cfg.routing?.categories) {
        for (const cat of Object.keys(cfg.routing.categories)) cfg.routing.categories[cat] = "anthropic";
      }
    } else if (selectedProvider === "openai") {
      if (cfg.providers?.openai) cfg.providers.openai.enabled = true;
      if (cfg.providers?.anthropic) cfg.providers.anthropic.enabled = false;
      if (cfg.routing?.categories) {
        for (const cat of Object.keys(cfg.routing.categories)) cfg.routing.categories[cat] = "openai";
      }
    } else if (selectedProvider === "both") {
      if (cfg.providers?.openai) cfg.providers.openai.enabled = true;
      if (cfg.providers?.anthropic) { cfg.providers.anthropic.enabled = true; cfg.providers.anthropic.authMode = "oauth"; }
    }

    fs.writeFileSync(dstConfig, JSON.stringify(cfg, null, 2), "utf8");

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
9. Use \`bash\` only for setup/runtime actions needed to complete the build (for example \`npm install\`). Final verification belongs to the VERIFY phase.
10. Do NOT keep reading the same file over and over. Read once, then act.
`, "utf8");
        }
      } catch {}
    }
    writeStepAgentsMd("build"); // default

    // SSE headers already sent by preflight system above — no need to re-send
    const traceRunId = `agi-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const traceDir = path.join(childCwd, ".agent", "traces");
    const tracePath = path.join(traceDir, `${traceRunId}.md`);

    function ensureTraceDir() {
      if (!fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true });
    }

    function asTraceString(value) {
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }

    function markdownFence(language, value) {
      return `\`\`\`${language}\n${asTraceString(value)}\n\`\`\``;
    }

    function appendTrace(section, title, body) {
      try {
        ensureTraceDir();
        fs.appendFileSync(tracePath, `\n## ${section}\n### ${title}\n${body}\n`, "utf8");
      } catch {}
    }

    function traceJson(section, title, value) {
      appendTrace(section, title, markdownFence("json", value));
    }

    function traceText(section, title, value, language = "text") {
      appendTrace(section, title, markdownFence(language, value));
    }

    try {
      ensureTraceDir();
      fs.writeFileSync(
        tracePath,
        `# AGI Run Trace\n\n- Started At: ${new Date().toISOString()}\n- Task: ${task}\n- Working Directory: ${childCwd}\n- Project Dir Label: ${projName}\n`,
        "utf8"
      );
    } catch {}

    const sendAgi = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
      try {
        if (type === "llm") return;
        if (type === "stdout" || type === "stderr") {
          traceText("Streams", `${type} @ ${new Date().toISOString()}`, String(data?.text || ""));
          return;
        }
        traceJson("Events", `${type} @ ${new Date().toISOString()}`, data);
      } catch {}
    };

    let aborted = false;
    req.on("close", () => { aborted = true; });
    traceJson("Run Setup", "request", { task, targetDir: targetDir || null, childCwd, projName });
    sendAgi("agi.trace.ready", { tracePath });

    // Initial complexity — set to "complex" as safe default.
    // The AI ANALYZE step will determine real complexity and we adjust BUILD turns dynamically.
    const dirFiles = fs.readdirSync(childCwd).filter(f => !f.startsWith(".") && f !== "node_modules");
    let complexity = dirFiles.length === 0 ? "complex" : "moderate";

    // Generate dynamic plan
    const steps = [];
    let stepNum = 0;
    const mkId = (t) => `step-${++stepNum}-${t}`;

    // Always: analyze
    steps.push({ id: mkId("analyze"), type: "analyze", title: "Analyze & Understand", mode: "run", maxTurns: 30, maxRetries: 1, useStrategyBranching: false });

    // Always: debate
    steps.push({ id: mkId("debate"), type: "debate", title: "Multi-Agent Design Debate", mode: "team", maxTurns: 50, maxRetries: 0, useStrategyBranching: false });

    // Always: design
    steps.push({ id: mkId("design"), type: "design", title: "Architecture & Design", mode: "run", maxTurns: 40, maxRetries: 1, useStrategyBranching: false });

    // Always: build — give it LOTS of turns for complex apps
    const buildTurns = complexity === "complex" ? 500 : complexity === "moderate" ? 300 : 150;
    steps.push({ id: mkId("build"), type: "build", title: "Build & Implement", mode: "team", maxTurns: buildTurns, maxRetries: 2, useStrategyBranching: true });

    // Always: verify
    steps.push({ id: mkId("verify"), type: "verify", title: "Verify & Test", mode: "run", maxTurns: 50, maxRetries: 0, useStrategyBranching: false });

    // Always: fix
    steps.push({ id: mkId("fix"), type: "fix", title: "Fix Errors", mode: "run", maxTurns: 100, maxRetries: 3, useStrategyBranching: true });

    traceJson("Pipeline", "generatedPlan", { complexity, steps });
    sendAgi("agi.pipeline.start", { plan: { steps }, complexity, projectDir: projName, totalSteps: steps.length });

    // Build codebase map for context (Aider-style)
    const repoMap = buildRepoMap(childCwd);
    const userProfile = getUserProfile();
    traceJson("Pipeline", "repoMap", repoMap);

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
      analyzeArtifact: null,
      debateArtifact: null,
      designArtifact: null,
      repoMap,
      userProfile,
      previousContext, // loaded from run-summary.json if user chose "continue"
    };

    // If continuing from previous run, seed context with previous artifacts and decisions
    if (previousContext) {
      ctx.decisions = [...(previousContext.decisions || [])];
      ctx.allFiles = [...(previousContext.filesCreated || [])];
      sendAgi("agi.debug", {
        message: "Continuing from previous run — loaded artifacts and decisions",
        previousTask: previousContext.task,
        decisionsLoaded: ctx.decisions.length,
        filesKnown: ctx.allFiles.length,
        hasAnalyze: !!previousContext.analyzeArtifact,
        hasDebate: !!previousContext.debateArtifact,
        hasDesign: !!previousContext.designArtifact,
      });
    }

    let clarificationRequest = null;
    let verifyFixCycles = 0;
    const MAX_VERIFY_FIX_CYCLES = 3;

    function taskUsesKorean(text) {
      return Array.from(text || "").some(ch => ch.charCodeAt(0) >= 0xAC00 && ch.charCodeAt(0) <= 0xD7A3);
    }

    function slugId(value, fallback) {
      const raw = String(value || fallback || "option").toLowerCase();
      let slug = "";
      for (const ch of raw) {
        const code = ch.charCodeAt(0);
        const isAlphaNum = (code >= 0x61 && code <= 0x7A) || (code >= 0x30 && code <= 0x39);
        const isKorean = code >= 0xAC00 && code <= 0xD7A3;
        if (isAlphaNum || isKorean) slug += ch;
        else if (slug.length > 0 && slug[slug.length - 1] !== "-") slug += "-";
      }
      // Trim leading/trailing dashes
      while (slug.startsWith("-")) slug = slug.slice(1);
      while (slug.endsWith("-")) slug = slug.slice(0, -1);
      return slug || fallback || "option";
    }

    // buildFallbackClarificationRequest removed — AI generates clarification groups directly.
    // No hardcoded game/generic option templates. AI decides everything.
    function buildFallbackClarificationRequest(_taskText, _analysis) {
      // No hardcoded groups. Return empty — AI ANALYZE generates groups directly.
      return { required: false, reason: "", message: "", summary: "", groups: [] };
    }

    // AI generates clarification groups directly. No fallback templates.
    // Trust AI's structured output completely.
    function normalizeClarificationRequest(_taskText, analysis) {
      if (!analysis || typeof analysis !== "object") return null;
      const raw = analysis.clarificationRequest && typeof analysis.clarificationRequest === "object"
        ? analysis.clarificationRequest
        : null;
      if (!raw || raw.required !== true) return null;
      const groups = Array.isArray(raw.groups) ? raw.groups.filter(g => g && typeof g === "object" && Array.isArray(g.options) && g.options.length > 0) : [];
      if (groups.length === 0) return null;
      const result = {
        required: true,
        reason: String(raw.reason || ""),
        message: String(raw.message || ""),
        summary: String(raw.summary || ""),
        groups
      };
      traceJson("Functions", "normalizeClarificationRequest()", result);
      return result;
    }

    function extractStructuredJson(text) {
      const source = String(text || "").trim();
      if (!source) return null;

      const candidates = [source];
      const fenced = source.match(/```json\s*([\s\S]*?)\s*```/i);
      if (fenced?.[1]) candidates.push(fenced[1].trim());
      const firstBrace = source.indexOf("{");
      const lastBrace = source.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        candidates.push(source.slice(firstBrace, lastBrace + 1).trim());
      }

      for (const candidate of candidates) {
        try { return JSON.parse(candidate); } catch {}
      }
      return null;
    }

    function normalizeText(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    function normalizeEnum(value, allowed, fallback = "") {
      const normalized = normalizeText(value);
      return allowed.includes(normalized) ? normalized : fallback;
    }

    function normalizeStringArray(values) {
      return Array.isArray(values)
        ? values.map((value) => normalizeText(value)).filter(Boolean)
        : [];
    }

    function normalizeObjectArray(values, mapper) {
      return Array.isArray(values)
        ? values.map((value, index) => mapper(value, index)).filter(Boolean)
        : [];
    }

    function normalizeAnalyzeArtifact(taskText, analysis) {
      const clarification = normalizeClarificationRequest(taskText, analysis) || {
        required: false,
        reason: "",
        message: "",
        summary: "",
        groups: []
      };

      const techStack = analysis?.techStack && typeof analysis.techStack === "object"
        ? {
          language: normalizeText(analysis.techStack.language),
          runtime: normalizeText(analysis.techStack.runtime),
          framework: normalizeText(analysis.techStack.framework),
          frontend: normalizeText(analysis.techStack.frontend),
          realtime: normalizeText(analysis.techStack.realtime),
          database: normalizeText(analysis.techStack.database),
          packageManager: normalizeText(analysis.techStack.packageManager),
          testFramework: normalizeText(analysis.techStack.testFramework),
          justification: normalizeText(analysis.techStack.justification)
        }
        : undefined;

      const artifact = {
        triage: {
          level: normalizeEnum(analysis?.triage?.level, ["trivial", "simple", "moderate", "complex"], "moderate"),
          rationale: normalizeText(analysis?.triage?.rationale)
        },
        intent: {
          type: normalizeText(analysis?.intent?.type),
          confidence: normalizeEnum(analysis?.intent?.confidence, ["high", "medium", "low"], "medium"),
          rationale: normalizeText(analysis?.intent?.rationale)
        },
        codebaseState: normalizeEnum(analysis?.codebaseState, ["greenfield", "disciplined", "transitional", "legacy"], "greenfield"),
        techStack,
        features: normalizeObjectArray(analysis?.features, (feature, index) => {
          if (!feature || typeof feature !== "object") return null;
          return {
            id: normalizeText(feature.id) || `F${index + 1}`,
            name: normalizeText(feature.name),
            priority: normalizeEnum(feature.priority, ["must-have", "nice-to-have"], "must-have"),
            description: normalizeText(feature.description),
            userStory: normalizeText(feature.userStory)
          };
        }),
        scope: {
          in: normalizeStringArray(analysis?.scope?.in),
          out: normalizeStringArray(analysis?.scope?.out),
          assumptions: normalizeStringArray(analysis?.scope?.assumptions),
          constraints: normalizeStringArray(analysis?.scope?.constraints)
        },
        risks: normalizeObjectArray(analysis?.risks, (risk) => {
          if (!risk || typeof risk !== "object") return null;
          return {
            risk: normalizeText(risk.risk),
            severity: normalizeEnum(risk.severity, ["high", "medium", "low"], "medium"),
            likelihood: normalizeEnum(risk.likelihood, ["high", "medium", "low"], "medium"),
            mitigation: normalizeText(risk.mitigation)
          };
        }),
        premortem: normalizeObjectArray(analysis?.premortem, (item) => {
          if (!item || typeof item !== "object") return null;
          return {
            failureScenario: normalizeText(item.failureScenario),
            prevention: normalizeText(item.prevention)
          };
        }),
        edgeCases: normalizeObjectArray(analysis?.edgeCases, (edgeCase, index) => {
          if (!edgeCase || typeof edgeCase !== "object") return null;
          return {
            id: normalizeText(edgeCase.id) || `EC${index + 1}`,
            feature: normalizeText(edgeCase.feature),
            scenario: normalizeText(edgeCase.scenario),
            expectedBehavior: normalizeText(edgeCase.expectedBehavior),
            severity: normalizeEnum(edgeCase.severity, ["critical", "moderate", "minor"], "moderate")
          };
        }),
        acceptanceCriteria: normalizeObjectArray(analysis?.acceptanceCriteria, (criterion, index) => {
          if (!criterion || typeof criterion !== "object") return null;
          return {
            id: normalizeText(criterion.id) || `AC${index + 1}`,
            criterion: normalizeText(criterion.criterion),
            command: normalizeText(criterion.command),
            expectedResult: normalizeText(criterion.expectedResult)
          };
        }),
        directives: {
          mustDo: normalizeStringArray(analysis?.directives?.mustDo),
          mustNotDo: normalizeStringArray(analysis?.directives?.mustNotDo),
          patternsToFollow: normalizeStringArray(analysis?.directives?.patternsToFollow),
          verificationTools: normalizeStringArray(analysis?.directives?.verificationTools)
        },
        slopGuardrails: {
          scopeInflationRisk: normalizeEnum(analysis?.slopGuardrails?.scopeInflationRisk, ["low", "medium", "high"], "medium"),
          prematureAbstractionRisk: normalizeEnum(analysis?.slopGuardrails?.prematureAbstractionRisk, ["low", "medium", "high"], "medium"),
          overValidationRisk: normalizeEnum(analysis?.slopGuardrails?.overValidationRisk, ["low", "medium", "high"], "medium"),
          docBloatRisk: normalizeEnum(analysis?.slopGuardrails?.docBloatRisk, ["low", "medium", "high"], "medium"),
          specificWarnings: normalizeStringArray(analysis?.slopGuardrails?.specificWarnings)
        },
        gapAnalysis: {
          implicitRequirements: normalizeStringArray(analysis?.gapAnalysis?.implicitRequirements),
          unresolvedQuestions: normalizeStringArray(analysis?.gapAnalysis?.unresolvedQuestions),
          featureDependencies: normalizeStringArray(analysis?.gapAnalysis?.featureDependencies),
          missingCoverage: normalizeStringArray(analysis?.gapAnalysis?.missingCoverage),
          predictionCheck: normalizeStringArray(analysis?.gapAnalysis?.predictionCheck)
        },
        clarificationRequest: clarification,
        decisionDrivers: normalizeObjectArray(analysis?.decisionDrivers, (driver, index) => {
          if (!driver || typeof driver !== "object") return null;
          return {
            id: normalizeText(driver.id) || `DD${index + 1}`,
            principle: normalizeText(driver.principle),
            rationale: normalizeText(driver.rationale),
            tradeoff: normalizeText(driver.tradeoff)
          };
        }),
        selfReview: {
          allFeaturesHaveUserStories: analysis?.selfReview?.allFeaturesHaveUserStories === true,
          allFeaturesHaveAC: analysis?.selfReview?.allFeaturesHaveAC === true,
          allACsAreExecutable: analysis?.selfReview?.allACsAreExecutable === true,
          allRisksHaveMitigation: analysis?.selfReview?.allRisksHaveMitigation === true,
          techStackJustified: analysis?.selfReview?.techStackJustified === true,
          scopeOutExplicit: analysis?.selfReview?.scopeOutExplicit === true,
          issuesFound: normalizeStringArray(analysis?.selfReview?.issuesFound)
        },
        complexity: {
          level: normalizeEnum(analysis?.complexity?.level, ["simple", "moderate", "complex", "very-complex"], "complex"),
          estimatedFiles: Number.isFinite(Number(analysis?.complexity?.estimatedFiles)) ? Number(analysis.complexity.estimatedFiles) : 0,
          estimatedLines: Number.isFinite(Number(analysis?.complexity?.estimatedLines)) ? Number(analysis.complexity.estimatedLines) : 0,
          estimatedBuildWaves: Number.isFinite(Number(analysis?.complexity?.estimatedBuildWaves)) ? Number(analysis.complexity.estimatedBuildWaves) : 0,
          criticalPath: normalizeText(analysis?.complexity?.criticalPath)
        }
      };

      if (artifact.techStack && Object.values(artifact.techStack).every((value) => !value)) {
        delete artifact.techStack;
      }

      traceJson("Functions", "normalizeAnalyzeArtifact()", artifact);
      return artifact;
    }

    function summarizeAnalyzeArtifact(artifact) {
      const parts = [];
      if (artifact.intent?.type) parts.push(`intent=${artifact.intent.type}`);
      if (artifact.codebaseState) parts.push(`codebase=${artifact.codebaseState}`);
      if (artifact.features?.length) parts.push(`features=${artifact.features.length}`);
      if (artifact.acceptanceCriteria?.length) parts.push(`acceptance=${artifact.acceptanceCriteria.length}`);
      parts.push(artifact.clarificationRequest?.required ? "clarification required" : "ready for downstream planning");
      return `AnalyzeArtifact generated: ${parts.join(", ")}.`;
    }

    function renderAnalyzeArtifact(artifact) {
      const parts = [
        "## Analyze Artifact",
        "Use this normalized artifact as the authoritative ANALYZE output. Ignore raw transcripts and tool chatter."
      ];

      if (artifact.intent?.type) {
        parts.push(`**Intent**: ${artifact.intent.type} (${artifact.intent.confidence} confidence)
${artifact.intent.rationale || ""}`.trim());
      }
      if (artifact.triage?.level) {
        parts.push(`**Triage**: ${artifact.triage.level}${artifact.triage.rationale ? ` — ${artifact.triage.rationale}` : ""}`);
      }
      if (artifact.codebaseState) {
        parts.push(`**Codebase State**: ${artifact.codebaseState}`);
      }
      if (artifact.techStack) {
        const tech = artifact.techStack;
        parts.push(`**Tech Stack**:
- Language: ${tech.language || "N/A"}
- Runtime: ${tech.runtime || "N/A"}
- Framework: ${tech.framework || "N/A"}
- Frontend: ${tech.frontend || "N/A"}
- Realtime: ${tech.realtime || "N/A"}
- Database: ${tech.database || "N/A"}
- Package Manager: ${tech.packageManager || "N/A"}
- Test Framework: ${tech.testFramework || "N/A"}${tech.justification ? `
- Justification: ${tech.justification}` : ""}`);
      }
      if (artifact.features?.length) {
        parts.push(`**Features**:
${artifact.features.map((feature) => `- [${feature.priority}] ${feature.id}: ${feature.name} — ${feature.description}`).join("\n")}`);
      }
      if (artifact.scope) {
        parts.push(`**Scope**:
- IN: ${(artifact.scope.in || []).join(", ") || "N/A"}
- OUT: ${(artifact.scope.out || []).join(", ") || "N/A"}
- Assumptions: ${(artifact.scope.assumptions || []).join(", ") || "N/A"}
- Constraints: ${(artifact.scope.constraints || []).join(", ") || "N/A"}`);
      }
      if (artifact.risks?.length) {
        parts.push(`**Risks**:
${artifact.risks.map((risk) => `- [${risk.severity}/${risk.likelihood}] ${risk.risk} → ${risk.mitigation}`).join("\n")}`);
      }
      if (artifact.edgeCases?.length) {
        parts.push(`**Edge Cases**:
${artifact.edgeCases.map((edgeCase) => `- ${edgeCase.id} [${edgeCase.severity}] (${edgeCase.feature}): ${edgeCase.scenario} → ${edgeCase.expectedBehavior}`).join("\n")}`);
      }
      if (artifact.acceptanceCriteria?.length) {
        parts.push(`**Acceptance Criteria**:
${artifact.acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.criterion} → \`${criterion.command}\` → ${criterion.expectedResult}`).join("\n")}`);
      }
      if (artifact.directives?.mustDo?.length) {
        parts.push(`**Must Do**:
${artifact.directives.mustDo.map((item) => `- ${item}`).join("\n")}`);
      }
      if (artifact.directives?.mustNotDo?.length) {
        parts.push(`**Must Not Do**:
${artifact.directives.mustNotDo.map((item) => `- ${item}`).join("\n")}`);
      }
      if (artifact.gapAnalysis?.implicitRequirements?.length) {
        parts.push(`**Implicit Requirements**:
${artifact.gapAnalysis.implicitRequirements.map((item) => `- ${item}`).join("\n")}`);
      }
      if (artifact.gapAnalysis?.featureDependencies?.length) {
        parts.push(`**Feature Dependencies**:
${artifact.gapAnalysis.featureDependencies.map((item) => `- ${item}`).join("\n")}`);
      }
      if (artifact.decisionDrivers?.length) {
        parts.push(`**Decision Drivers**:
${artifact.decisionDrivers.map((driver) => `- ${driver.id}: ${driver.principle} — ${driver.rationale} (tradeoff: ${driver.tradeoff})`).join("\n")}`);
      }
      if (artifact.clarificationRequest?.required) {
        parts.push(`**Clarification Required**:
- Reason: ${artifact.clarificationRequest.reason}
- Message: ${artifact.clarificationRequest.message}`);
      }
      if (artifact.complexity?.level) {
        parts.push(`**Complexity**: ${artifact.complexity.level} — ~${artifact.complexity.estimatedFiles} files, ~${artifact.complexity.estimatedLines} lines, ~${artifact.complexity.estimatedBuildWaves} waves
- Critical path: ${artifact.complexity.criticalPath || "N/A"}`);
      }
      parts.push("Structured Data:\n```json\n" + JSON.stringify(artifact, null, 2) + "\n```");

      return parts.join("\n\n");
    }

    function summarizeDebateArtifact(artifact) {
      const parts = [];
      if (artifact.readiness) parts.push(`readiness=${artifact.readiness}`);
      if (artifact.designFocus?.length) parts.push(`focus=${artifact.designFocus.length}`);
      if (artifact.risks?.length) parts.push(`risks=${artifact.risks.length}`);
      if (artifact.openQuestions?.length) parts.push(`questions=${artifact.openQuestions.length}`);
      return `DebateArtifact generated: ${parts.join(", ") || "normalized"}.`;
    }

    function normalizeDebateArtifact(taskText, debate, analyzeArtifact) {
      const summary = normalizeText(debate?.summary) || normalizeText(debate?.recommendedApproach) || normalizeText(taskText);
      const recommendedApproach = normalizeText(debate?.recommendedApproach) || summary;
      const designFocus = normalizeStringArray(debate?.designFocus);
      const risks = normalizeStringArray(debate?.risks);
      const openQuestions = normalizeStringArray(debate?.openQuestions);
      const readiness = normalizeEnum(
        debate?.readiness,
        ["blocked", "provisional", "ready"],
        analyzeArtifact?.clarificationRequest?.required ? "blocked" : (risks.length > 0 ? "provisional" : "ready")
      );

      const artifact = {
        summary,
        recommendedApproach,
        decisionDrivers: normalizeStringArray(debate?.decisionDrivers),
        alternativesConsidered: normalizeStringArray(debate?.alternativesConsidered),
        tradeoffs: normalizeStringArray(debate?.tradeoffs),
        risks,
        openQuestions,
        implementationPrinciples: normalizeStringArray(debate?.implementationPrinciples),
        verificationStrategy: normalizeStringArray(debate?.verificationStrategy),
        designFocus,
        readiness
      };
      traceJson("Functions", "normalizeDebateArtifact()", artifact);
      return artifact;
    }

    function renderDebateArtifact(artifact) {
      const parts = [
        "## Debate Artifact",
        "Use this normalized artifact as the authoritative DEBATE output. Ignore raw debate transcripts and tool chatter.",
        `Summary: ${artifact.summary}`,
        `Recommended Approach: ${artifact.recommendedApproach}`,
        `Readiness: ${artifact.readiness}`
      ];

      const pushList = (title, values) => {
        if (!Array.isArray(values) || values.length === 0) return;
        parts.push(`${title}:
${values.map((value) => `- ${value}`).join("\n")}`);
      };

      pushList("Decision Drivers", artifact.decisionDrivers);
      pushList("Alternatives Considered", artifact.alternativesConsidered);
      pushList("Tradeoffs", artifact.tradeoffs);
      pushList("Risks", artifact.risks);
      pushList("Open Questions", artifact.openQuestions);
      pushList("Implementation Principles", artifact.implementationPrinciples);
      pushList("Verification Strategy", artifact.verificationStrategy);
      pushList("Design Focus", artifact.designFocus);
      parts.push("Structured Data:\n```json\n" + JSON.stringify(artifact, null, 2) + "\n```");

      return parts.join("\n\n");
    }

    function applyDebateArtifact(artifact) {
      ctx.debateArtifact = artifact;
      if (artifact.recommendedApproach) pushDecision(`Debate recommendation: ${artifact.recommendedApproach}`);
      for (const item of artifact.implementationPrinciples || []) pushDecision(`Implementation principle: ${item}`);
      for (const item of artifact.tradeoffs || []) pushDecision(`Tradeoff: ${item}`);

      // DEBATE refines ANALYZE — update ctx.analyzeArtifact with DEBATE conclusions
      // so downstream steps (DESIGN, BUILD) see the corrected analysis
      if (ctx.analyzeArtifact) {
        if (artifact.summary) ctx.analyzeArtifact.summary = artifact.summary;
        if (artifact.recommendedApproach) ctx.analyzeArtifact.recommendedApproach = artifact.recommendedApproach;
        // DEBATE's design focus replaces ANALYZE's implicit requirements
        if (artifact.designFocus?.length) ctx.analyzeArtifact.implicitRequirements = artifact.designFocus;
        // DEBATE's implementation principles replace ANALYZE's tech options
        if (artifact.implementationPrinciples?.length) ctx.analyzeArtifact.techOptions = artifact.implementationPrinciples;
        // Replace ANALYZE's entire techStack with DEBATE's conclusions
        // DEBATE is the final authority on tech decisions
        ctx.analyzeArtifact.techStack = {
          justification: artifact.recommendedApproach || artifact.summary || ""
        };
        // Update intent
        if (artifact.summary) {
          if (ctx.analyzeArtifact.intent && typeof ctx.analyzeArtifact.intent === "object") {
            ctx.analyzeArtifact.intent.rationale = artifact.summary;
          }
        }
        sendAgi("agi.debug", { message: "ANALYZE artifact updated with DEBATE conclusions", techStack: ctx.analyzeArtifact.techStack });
      }

      traceJson("Functions", "applyDebateArtifact()", artifact);
    }

    function asStringArray(value) {
      if (Array.isArray(value)) return normalizeStringArray(value);
      if (typeof value === "string") {
        return value
          .split(/\n|[;•]/)
          .map((item) => normalizeText(item.replace(/^[-*]\s*/, "")))
          .filter(Boolean);
      }
      return [];
    }

    // AI assigns layer, owner, and wave in design artifact.
    // These are minimal fallbacks that return neutral defaults — never override AI.
    function inferDesignLayer(_filePath) { return "shared"; }
    function designOwnerForLayer(_layer) { return "executor"; }
    function designWaveForLayer(_layer) { return 1; }


    function buildDefaultDesignManifest() {
      // No hardcoded file structure. AI decides everything.
      // Returns empty — the AI planner's output is the source of truth.
      return [];
    }

    function normalizeDesignFileManifest(value, fallbackManifest) {
      if (!Array.isArray(value) || value.length === 0) return fallbackManifest;
      const manifest = value.map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const filePath = normalizeText(entry.path);
        if (!filePath) return null;
        const layer = normalizeEnum(entry.layer, ["scaffold", "config", "shared", "frontend", "backend", "database", "realtime", "testing", "docs"], inferDesignLayer(filePath));
        return {
          path: filePath,
          purpose: normalizeText(entry.purpose || entry.description) || "Implementation file",
          layer,
          owner: normalizeText(entry.owner) || designOwnerForLayer(layer),
          wave: Number.isFinite(Number(entry.wave)) && Number(entry.wave) > 0 ? Number(entry.wave) : designWaveForLayer(layer),
          dependsOn: asStringArray(entry.dependsOn),
        };
      }).filter(Boolean);
      return manifest.length > 0 ? manifest.filter((entry, index, arr) => arr.findIndex((candidate) => candidate.path === entry.path) === index) : fallbackManifest;
    }

    function deriveDesignWorkstreams(fileManifest, source) {
      if (Array.isArray(source?.workstreams) && source.workstreams.length > 0) {
        const workstreams = source.workstreams.map((entry, index) => {
          if (!entry || typeof entry !== "object") return null;
          const title = normalizeText(entry.title) || "Workstream " + (index + 1);
          const id = normalizeText(entry.id) || slugId(title, "ws-" + (index + 1));
          return {
            id,
            title,
            owner: normalizeText(entry.owner) || "executor",
            wave: Number.isFinite(Number(entry.wave)) && Number(entry.wave) > 0 ? Number(entry.wave) : 1,
            focus: normalizeText(entry.focus || entry.summary) || "Implementation workstream",
            files: asStringArray(entry.files),
            deliverables: asStringArray(entry.deliverables),
            dependsOn: asStringArray(entry.dependsOn),
            testTargets: asStringArray(entry.testTargets),
          };
        }).filter(Boolean);
        if (workstreams.length > 0) return workstreams;
      }

      const order = ["scaffold", "config", "shared", "frontend", "backend", "database", "realtime", "testing", "docs"];
      const focusByLayer = {
        scaffold: "Create the runnable project foundation, scripts, and package metadata.",
        config: "Lock down compiler, test, and lint configuration before implementation expands.",
        shared: "Define shared state, domain types, and cross-cutting primitives.",
        frontend: "Implement the user-facing runtime, UI flow, and interaction layer.",
        backend: "Implement server-side handlers, business rules, and service orchestration.",
        database: "Implement schema, storage contracts, and persistence boundaries.",
        realtime: "Implement synchronization channels and client/server event contracts.",
        testing: "Implement automated tests that prove the critical flows and guard regressions.",
        docs: "Document setup, scripts, and operational assumptions for the generated app.",
      };
      const dependsOnByLayer = {
        scaffold: [],
        config: ["ws-scaffold"],
        shared: ["ws-scaffold", "ws-config"],
        frontend: ["ws-scaffold", "ws-config", "ws-shared"],
        backend: ["ws-scaffold", "ws-config", "ws-shared"],
        database: ["ws-scaffold", "ws-config", "ws-backend"],
        realtime: ["ws-frontend", "ws-backend"],
        testing: ["ws-frontend", "ws-backend", "ws-database", "ws-realtime"],
        docs: ["ws-scaffold"],
      };
      const titleByLayer = {
        scaffold: "Project Scaffold",
        config: "Tooling & Config",
        shared: "Shared Domain Core",
        frontend: "Frontend Surface",
        backend: "Backend Services",
        database: "Database & Persistence",
        realtime: "Realtime Integration",
        testing: "Testing & Verification",
        docs: "Project Documentation",
      };

      return order
        .filter((layer) => fileManifest.some((file) => file.layer === layer))
        .map((layer) => {
          const files = fileManifest.filter((file) => file.layer === layer);
          return {
            id: "ws-" + layer,
            title: titleByLayer[layer],
            owner: designOwnerForLayer(layer),
            wave: Math.min(...files.map((file) => Number(file.wave) || designWaveForLayer(layer))),
            focus: focusByLayer[layer],
            files: files.map((file) => file.path),
            deliverables: files.map((file) => file.path + ": " + file.purpose),
            dependsOn: dependsOnByLayer[layer].filter((dependencyId) => fileManifest.some((file) => ("ws-" + file.layer) === dependencyId)),
            testTargets: layer === "testing" ? files.map((file) => file.path) : [],
          };
        });
    }

    function deriveDesignBuildWaves(workstreams, source) {
      if (Array.isArray(source?.buildWaves) && source.buildWaves.length > 0) {
        const waves = source.buildWaves.map((entry, index) => {
          if (!entry || typeof entry !== "object") return null;
          const workstreamIds = asStringArray(entry.workstreamIds);
          if (workstreamIds.length === 0) return null;
          return {
            wave: Number.isFinite(Number(entry.wave)) && Number(entry.wave) > 0 ? Number(entry.wave) : index + 1,
            title: normalizeText(entry.title) || "Build Wave " + (index + 1),
            objective: normalizeText(entry.objective || entry.summary) || "Deliver the assigned workstreams.",
            workstreamIds,
          };
        }).filter(Boolean).sort((left, right) => left.wave - right.wave);
        if (waves.length > 0) return waves;
      }

      const grouped = new Map();
      for (const workstream of workstreams) {
        const key = Number(workstream.wave) || 1;
        const current = grouped.get(key) || [];
        current.push(workstream);
        grouped.set(key, current);
      }

      return Array.from(grouped.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([wave, entries]) => ({
          wave,
          title: entries.map((entry) => entry.title).join(" + "),
          objective: entries.map((entry) => entry.focus).join(" "),
          workstreamIds: entries.map((entry) => entry.id),
        }));
    }

    function summarizeDesignArtifact(artifact) {
      const parts = [];
      if (artifact.readiness) parts.push("readiness=" + artifact.readiness);
      if (artifact.fileManifest?.length) parts.push("files=" + artifact.fileManifest.length);
      if (artifact.workstreams?.length) parts.push("workstreams=" + artifact.workstreams.length);
      if (artifact.buildWaves?.length) parts.push("waves=" + artifact.buildWaves.length);
      if (artifact.testPlan?.length) parts.push("tests=" + artifact.testPlan.length);
      return "DesignArtifact generated: " + (parts.join(", ") || "normalized") + ".";
    }

    function normalizeDesignArtifact(taskText, design, analyzeArtifact, debateArtifact) {
      const source = design && typeof design === "object" ? design : { summary: String(design || taskText) };
      const preserveSource = Array.isArray(source.fileManifest) && Array.isArray(source.workstreams) && Array.isArray(source.buildWaves);
      const fallbackManifest = buildDefaultDesignManifest();
      const fileManifest = normalizeDesignFileManifest(source.fileManifest, fallbackManifest);
      const workstreams = deriveDesignWorkstreams(fileManifest, source);
      const buildWaves = deriveDesignBuildWaves(workstreams, source);
      const directoryStructure = (preserveSource
        ? asStringArray(source.directoryStructure).map((entry) => entry.replace(/\/+$/g, ""))
        : Array.from(new Set([
          ...asStringArray(source.directoryStructure),
          ...fileManifest.map((file) => {
            const parts = file.path.split("/");
            return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
          })
        ].filter(Boolean)))).filter((entry) => entry !== ".");
      const architecture = (preserveSource
        ? asStringArray(source.architecture)
        : Array.from(new Set([
          ...asStringArray(source.architecture),
          ...asStringArray(debateArtifact?.designFocus),
          ...asStringArray(debateArtifact?.implementationPrinciples),
          normalizeText(analyzeArtifact?.techStack?.justification),
        ].filter(Boolean)))).slice(0, 12);
      const dependencyNotes = (preserveSource
        ? asStringArray(source.dependencyNotes)
        : Array.from(new Set([
          ...asStringArray(source.dependencyNotes),
          normalizeText(analyzeArtifact?.techStack?.justification),
          ...asStringArray(analyzeArtifact?.directives?.verificationTools),
        ].filter(Boolean)))).slice(0, 12);
      const contracts = (preserveSource
        ? asStringArray(source.contracts)
        : Array.from(new Set([
          ...asStringArray(source.contracts),
          fileManifest.some((file) => file.layer === "frontend") && fileManifest.some((file) => file.layer === "backend") ? "Client/server contract must stay aligned with the file manifest and typed request boundaries." : "",
          fileManifest.some((file) => file.layer === "database") ? "Persistence contract must match schema and service assumptions before integration work starts." : "",
          fileManifest.some((file) => file.layer === "realtime") ? "Realtime event payloads must remain deterministic across server and client handlers." : "",
        ].filter(Boolean)))).slice(0, 10);
      const testPlan = (preserveSource
        ? asStringArray(source.testPlan)
        : Array.from(new Set([
          ...asStringArray(source.testPlan),
          ...fileManifest.filter((file) => file.layer === "testing").map((file) => file.path + ": " + file.purpose),
          ...asStringArray(debateArtifact?.verificationStrategy),
          ...normalizeObjectArray(analyzeArtifact?.acceptanceCriteria, (criterion) => criterion?.command ? criterion.command + " -> " + normalizeText(criterion.expectedResult) : null),
        ].filter(Boolean)))).slice(0, 16);
      const acceptanceChecks = (preserveSource
        ? asStringArray(source.acceptanceChecks)
        : Array.from(new Set([
          ...asStringArray(source.acceptanceChecks),
          ...normalizeObjectArray(analyzeArtifact?.acceptanceCriteria, (criterion) => criterion?.command || null),
          "npm test",
          "npm run build",
          fileManifest.some((file) => file.path === "package.json") ? "npm start" : "",
        ].filter(Boolean)))).slice(0, 12);
      const executionNotes = (preserveSource
        ? asStringArray(source.executionNotes)
        : Array.from(new Set([
          ...asStringArray(source.executionNotes),
          ...asStringArray(analyzeArtifact?.directives?.mustDo),
          ...asStringArray(debateArtifact?.tradeoffs),
        ].filter(Boolean)))).slice(0, 16);
      const summary = normalizeText(source.summary) || normalizeText(debateArtifact?.summary) || normalizeText(analyzeArtifact?.intent?.type) || normalizeText(taskText);
      const readiness = normalizeEnum(source.readiness, ["blocked", "provisional", "ready"], analyzeArtifact?.clarificationRequest?.required ? "blocked" : ((debateArtifact?.risks?.length || 0) > 0 ? "provisional" : "ready"));

      const artifact = {
        summary,
        architecture,
        directoryStructure,
        fileManifest,
        workstreams,
        buildWaves,
        dependencyNotes,
        contracts,
        testPlan,
        acceptanceChecks,
        executionNotes,
        readiness,
      };
      traceJson("Functions", "normalizeDesignArtifact()", artifact);
      return artifact;
    }

    function renderDesignArtifact(artifact) {
      const parts = [
        "## Design Artifact",
        "Use this normalized artifact as the authoritative DESIGN output. Ignore raw design transcripts and tool chatter.",
        "Summary: " + artifact.summary,
        "Readiness: " + artifact.readiness,
      ];

      const pushList = (title, values) => {
        if (!Array.isArray(values) || values.length === 0) return;
        parts.push(title + ":\n" + values.map((value) => "- " + value).join("\n"));
      };

      pushList("Architecture", artifact.architecture);
      if (Array.isArray(artifact.directoryStructure) && artifact.directoryStructure.length > 0) {
        parts.push("Directory Structure:\n" + artifact.directoryStructure.map((value) => "- " + value + "/").join("\n"));
      }
      if (Array.isArray(artifact.fileManifest) && artifact.fileManifest.length > 0) {
        parts.push("File Manifest:\n" + artifact.fileManifest.map((file) => "- " + file.path + " [wave " + file.wave + " / " + file.owner + "] — " + file.purpose).join("\n"));
      }
      if (Array.isArray(artifact.workstreams) && artifact.workstreams.length > 0) {
        parts.push("Workstreams:\n" + artifact.workstreams.map((workstream) => "- " + workstream.id + " [wave " + workstream.wave + " / " + workstream.owner + "] " + workstream.title + " — " + workstream.focus).join("\n"));
      }
      if (Array.isArray(artifact.buildWaves) && artifact.buildWaves.length > 0) {
        parts.push("Build Waves:\n" + artifact.buildWaves.map((wave) => "- Wave " + wave.wave + ": " + wave.title + " — " + wave.objective).join("\n"));
      }
      pushList("Dependency Notes", artifact.dependencyNotes);
      pushList("Contracts", artifact.contracts);
      pushList("Test Plan", artifact.testPlan);
      pushList("Acceptance Checks", artifact.acceptanceChecks);
      pushList("Execution Notes", artifact.executionNotes);
      parts.push("Structured Data:\n```json\n" + JSON.stringify(artifact, null, 2) + "\n```");

      return parts.join("\n\n");
    }

    function applyDesignArtifact(artifact) {
      ctx.designArtifact = artifact;
      for (const item of artifact.architecture || []) pushDecision("Design architecture: " + item);
      for (const item of artifact.contracts || []) pushDecision("Design contract: " + item);
      for (const item of artifact.executionNotes || []) pushDecision("Design note: " + item);
      traceJson("Functions", "applyDesignArtifact()", artifact);
    }

    function buildWaveDescription(wave, workstreams, artifact) {
      const files = Array.from(new Set(workstreams.flatMap((workstream) => workstream.files || [])));
      const deliverables = Array.from(new Set(workstreams.flatMap((workstream) => workstream.deliverables || [])));
      const testTargets = Array.from(new Set(workstreams.flatMap((workstream) => workstream.testTargets || [])));
      const lines = [
        "Implement build wave " + wave.wave + ": " + wave.title + ".",
        "Objective: " + wave.objective,
      ];
      if (workstreams.length > 0) lines.push("Workstreams:\n" + workstreams.map((workstream) => "- " + workstream.id + " [" + workstream.owner + "] " + workstream.title + " — " + workstream.focus).join("\n"));
      if (files.length > 0) lines.push("Files to create or complete:\n" + files.map((filePath) => "- " + filePath).join("\n"));
      if (deliverables.length > 0) lines.push("Deliverables:\n" + deliverables.map((item) => "- " + item).join("\n"));
      if (testTargets.length > 0) lines.push("Tests to author or update in this wave:\n" + testTargets.map((target) => "- " + target).join("\n"));
      if (artifact.acceptanceChecks?.length > 0) lines.push("Acceptance checks to keep in view:\n" + artifact.acceptanceChecks.map((check) => "- " + check).join("\n"));
      return lines.join("\n\n");
    }

    function expandBuildStepsFromDesignArtifact(artifact, afterIndex) {
      if (artifact?.readiness === "blocked") {
        traceJson("Functions", "expandBuildStepsFromDesignArtifact()", { expanded: false, reason: "design_blocked" });
        return false;
      }
      const buildIdx = steps.findIndex((candidate, index) => index > afterIndex && candidate.type === "build" && !String(candidate.title || "").startsWith("Build Wave "));
      if (buildIdx === -1) {
        traceJson("Functions", "expandBuildStepsFromDesignArtifact()", { expanded: false, reason: "build_step_not_found" });
        return false;
      }
      const buildStep = steps[buildIdx];
      const workstreamById = new Map((artifact.workstreams || []).map((workstream) => [workstream.id, workstream]));
      const waves = Array.isArray(artifact.buildWaves) && artifact.buildWaves.length > 0
        ? artifact.buildWaves
        : [{ wave: 1, title: buildStep.title, objective: buildStep.description || buildStep.title, workstreamIds: (artifact.workstreams || []).map((workstream) => workstream.id) }];
      const expanded = waves.map((wave) => {
        const waveWorkstreams = (wave.workstreamIds || []).map((id) => workstreamById.get(id)).filter(Boolean);
        const fileCount = waveWorkstreams.reduce((total, workstream) => total + ((workstream.files || []).length), 0);
        const maxTurns = Math.min(buildStep.maxTurns || 300, Math.max(80, 40 + fileCount * 5));
        return {
          id: buildStep.id + "-wave-" + wave.wave,
          type: "build",
          title: "Build Wave " + wave.wave + ": " + wave.title,
          description: buildWaveDescription(wave, waveWorkstreams, artifact),
          mode: buildStep.mode,
          maxTurns,
          maxRetries: buildStep.maxRetries,
          useStrategyBranching: buildStep.useStrategyBranching,
        };
      });
      steps.splice(buildIdx, 1, ...expanded);
      traceJson("Functions", "expandBuildStepsFromDesignArtifact()", {
        expanded: expanded.length > 0,
        buildIdx,
        expandedSteps: expanded
      });
      return expanded.length > 0;
    }


    function validateAnalyzeArtifact(artifact) {
      const missing = [];
      if (!artifact.intent?.type) missing.push("intent.type");
      if (!artifact.features?.length) missing.push("features (empty)");
      if (!artifact.acceptanceCriteria?.length) missing.push("acceptanceCriteria (empty)");
      if (!artifact.directives) missing.push("directives");
      if (!artifact.complexity?.level) missing.push("complexity.level");
      if (typeof artifact.clarificationRequest !== "object") missing.push("clarificationRequest");
      const triageLevel = artifact.triage?.level || "moderate";
      if (triageLevel !== "trivial" && triageLevel !== "simple") {
        if (!artifact.scope) missing.push("scope");
        if (!artifact.risks?.length) missing.push("risks (empty)");
        if (!artifact.slopGuardrails) missing.push("slopGuardrails");
        if (!artifact.gapAnalysis) missing.push("gapAnalysis");
        if (!artifact.selfReview) missing.push("selfReview");
        if (!artifact.decisionDrivers?.length) missing.push("decisionDrivers (empty)");
        if (!artifact.edgeCases?.length) missing.push("edgeCases (empty)");
      }
      return { missing, triageLevel };
    }

    function pushDecision(decision) {
      const normalized = normalizeText(decision);
      if (normalized && !ctx.decisions.includes(normalized)) {
        ctx.decisions.push(normalized);
      }
    }

    function applyAnalyzeArtifact(artifact) {
      ctx.analyzeArtifact = artifact;
      ctx.analysis = artifact;

      if (artifact.techStack?.justification) pushDecision(`Tech stack: ${artifact.techStack.justification}`);
      if (artifact.intent?.rationale) pushDecision(`Intent: ${artifact.intent.type} — ${artifact.intent.rationale}`);
      for (const item of artifact.directives?.mustDo || []) pushDecision(`MUST DO: ${item}`);
      for (const item of artifact.directives?.mustNotDo || []) pushDecision(`MUST NOT DO: ${item}`);
      if (artifact.complexity?.level) ctx.analysisComplexity = artifact.complexity.level;

      sendAgi("agi.analysis.parsed", {
        source: "artifact",
        triage: artifact.triage,
        intent: artifact.intent,
        codebaseState: artifact.codebaseState,
        techStack: artifact.techStack ? {
          language: artifact.techStack.language,
          framework: artifact.techStack.framework,
          frontend: artifact.techStack.frontend,
        } : null,
        featureCount: artifact.features?.length || 0,
        riskCount: artifact.risks?.length || 0,
        edgeCaseCount: artifact.edgeCases?.length || 0,
        complexity: artifact.complexity,
        slopGuardrails: artifact.slopGuardrails,
        hasGapAnalysis: !!artifact.gapAnalysis,
      });

      const validation = validateAnalyzeArtifact(artifact);
      if (validation.missing.length > 0) {
        sendAgi("agi.analysis.validation", { status: "incomplete", missing: validation.missing, triageLevel: validation.triageLevel });
        ctx.analysisValidation = validation;
      } else {
        sendAgi("agi.analysis.validation", { status: "complete", triageLevel: validation.triageLevel });
        ctx.analysisValidation = null;
      }

      // If user already answered clarification, don't ask again
      const alreadyClarified = task.toLowerCase().includes("[clarification selections]");
      clarificationRequest = (!alreadyClarified && artifact.clarificationRequest?.required) ? artifact.clarificationRequest : null;

      // If no clarificationRequest from engine artifact, search session files
      if (!clarificationRequest && !alreadyClarified) {
        const sessionsDir = path.join(childCwd, ".agent", "sessions");
        try {
          if (fs.existsSync(sessionsDir)) {
            const sessionFiles = fs.readdirSync(sessionsDir)
              .filter(f => f.endsWith(".json") && !f.endsWith(".jsonl"))
              .sort((a, b) => {
                try { return fs.statSync(path.join(sessionsDir, b)).mtimeMs - fs.statSync(path.join(sessionsDir, a)).mtimeMs; } catch { return 0; }
              });
            for (const sf of sessionFiles) {
              try {
                const sessionData = JSON.parse(fs.readFileSync(path.join(sessionsDir, sf), "utf8"));
                const plannerTask = sessionData.tasks?.find(t => t.role === "planner" && t.status === "completed");
                const rawCR = plannerTask?.output?.clarificationRequest;
                if (rawCR && typeof rawCR === "object" && rawCR.required === true && Array.isArray(rawCR.groups) && rawCR.groups.length > 0) {
                  clarificationRequest = rawCR;
                  artifact.clarificationRequest = rawCR;
                  sendAgi("agi.debug", { message: `Loaded clarificationRequest from session: ${sf}` });
                  break;
                }
              } catch {}
            }
          }
        } catch {}
      }

      // Trust AI's structured output only. No regex keyword scanning of summary text.
      // If AI didn't set clarificationRequest.required: true explicitly, we don't clarify.

      sendAgi("agi.debug", {
        message: "applyAnalyzeArtifact — clarification decision",
        clarificationRequest_set: !!clarificationRequest,
        clarificationRequired: artifact.clarificationRequired,
        hasClarificationRequestObject: !!artifact.clarificationRequest?.required,
      });
      traceJson("Functions", "applyAnalyzeArtifact()", artifact);
    }

    // Build step prompt with full inter-step memory
    function buildStepPrompt(step) {
      const sections = [];
      sections.push(`# AGI Pipeline — ${step.title}`);
      sections.push(`## Original Task (NEVER FORGET THIS)\n**"${task}"**\nEverything you do must serve this task. If you find yourself writing design documents instead of application code, STOP and refocus on the task.`);

      // Inject previous run context if continuing from a prior execution
      if (ctx.previousContext && step.type === "analyze") {
        const prev = ctx.previousContext;
        const prevParts = [`## Previous Run Context (IMPORTANT — READ THIS FIRST)`,
          `This folder was previously used for an AGI run. The user chose to CONTINUE from that run.`,
          `**Previous Task**: "${prev.task}"`,
          `**Completed At**: ${prev.completedAt || "unknown"}`,
        ];
        if (prev.debateConclusion) {
          prevParts.push(`**Previous DEBATE Conclusion**: ${prev.debateConclusion}`);
        }
        if (prev.decisions?.length > 0) {
          prevParts.push(`**Previous Decisions**:\n${prev.decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`);
        }
        if (prev.filesCreated?.length > 0) {
          prevParts.push(`**Files from previous run** (${prev.filesCreated.length}):\n${prev.filesCreated.map(f => `- ${f}`).join("\n")}`);
        }
        if (prev.analyzeArtifact) {
          prevParts.push(`**Previous Analysis (summary)**:\n- Intent: ${prev.analyzeArtifact.intent?.type || "unknown"}\n- Codebase: ${prev.analyzeArtifact.codebaseState || "unknown"}\n- Features: ${(prev.analyzeArtifact.features || []).map(f => f.name).join(", ") || "none"}`);
          if (prev.analyzeArtifact.techStack?.justification) {
            prevParts.push(`- Tech stack justification: ${prev.analyzeArtifact.techStack.justification}`);
          }
        }
        prevParts.push(`\n**Instructions**: Use the previous run's decisions as a STARTING POINT. You may refine or override them if the new task requires it, but do not ignore them. The existing files in the workspace are from the previous run — build ON TOP of them unless the new task explicitly contradicts previous decisions.`);
        sections.push(prevParts.join("\n"));
      }

      const analysisArtifact = step.type !== "analyze"
        ? (ctx.analyzeArtifact || (ctx.analysis ? normalizeAnalyzeArtifact(task, ctx.analysis) : null))
        : null;
      const debateArtifact = step.type !== "analyze" && step.type !== "debate"
        ? ctx.debateArtifact
        : null;
      const designArtifact = step.type !== "analyze" && step.type !== "debate" && step.type !== "design"
        ? ctx.designArtifact
        : null;

      // [FIX #2, #4] Inter-step memory: ALL prior results with FULL content — no truncation
      if (ctx.stepResults.length > 0) {
        sections.push(`## Prior Step Results (${ctx.stepResults.length} completed)`);
        for (const r of ctx.stepResults) {
          const icon = r.status === "completed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP";
          if (r.type === "analyze" && analysisArtifact && step.type !== "analyze") {
            sections.push(`### [${icon}] ANALYZE
AnalyzeArtifact generated. The normalized artifact below is the authoritative ANALYZE output.`);
            continue;
          }
          if (r.type === "debate" && debateArtifact && step.type !== "debate") {
            sections.push(`### [${icon}] DEBATE
DebateArtifact generated. The normalized artifact below is the authoritative DEBATE output.`);
            continue;
          }
          if (r.type === "design" && designArtifact && step.type !== "design") {
            sections.push(`### [${icon}] DESIGN
DesignArtifact generated. The normalized artifact below is the authoritative DESIGN output.`);
            continue;
          }
          sections.push(`### [${icon}] ${r.type.toUpperCase()}
${r.summary || ""}`);
          if (r.changes && r.changes.length) sections.push(`Files changed:
${r.changes.map(c => `- ${c}`).join("\n")}`);
          if (r.errors && r.errors.length) sections.push(`Errors:
${r.errors.map(e => `- ${e}`).join("\n")}`);
          if (r.toolResults && r.toolResults.length > 0) {
            const toolSummary = r.toolResults.map(t => {
              let s = `- [${t.ok ? "OK" : "FAIL"}] ${t.name}`;
              if (t.output?.path) s += `: ${t.output.path}`;
              if (t.fullStdout) s += `
  stdout: ${t.fullStdout}`;
              if (t.fullStderr) s += `
  stderr: ${t.fullStderr}`;
              return s;
            }).join("\n");
            sections.push(`Tool Results:
${toolSummary}`);
          }
        }
      }

      // [FIX #5] Architecture decisions — full text, no truncation
      if (ctx.decisions.length) sections.push(`## Architecture Decisions\n${ctx.decisions.map((d,i) => `${i+1}. ${d}`).join("\n")}`);
      if (ctx.allFiles.length) sections.push(`## Project Files\n${ctx.allFiles.map(f => `- ${f}`).join("\n")}`);

      const unresolved = ctx.errorLog.filter(e => !e.resolved);
      if (unresolved.length) sections.push(`## Unresolved Errors\n${unresolved.map(e => `- [${e.category}] ${e.error}`).join("\n")}`);

      // After DEBATE completes, ANALYZE artifact is updated with DEBATE conclusions.
      // For DESIGN/BUILD steps, only show ANALYZE if DEBATE hasn't happened yet.
      // If DEBATE exists, ANALYZE is already incorporated into it — no need to show both.
      if (analysisArtifact && !debateArtifact) {
        sections.push(renderAnalyzeArtifact(analysisArtifact));
      }
      if (debateArtifact) {
        sections.push(renderDebateArtifact(debateArtifact));
      }
      if (designArtifact) {
        sections.push(renderDesignArtifact(designArtifact));
      }

      // Step-type instructions
      sections.push(`## Your Task: ${step.title}`);
      if (step.description) sections.push(step.description);
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

      const promptText = sections.join("\n\n");
      traceText("Prompts", `${step.type}:${step.title}`, promptText, "markdown");
      return promptText;
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

### Step 11.5: USER CLARIFICATION OPTIONS (CRITICAL — DO NOT SKIP)
You MUST decide whether to ask the user for clarification before proceeding.

**Set \`clarificationRequest.required\` to TRUE when ANY of these apply:**
- The task is vague or under-specified (e.g., "게임 개발해줘", "build me an app", "make a website")
- You had to make major assumptions about genre, style, features, or architecture
- Multiple reasonable interpretations exist and the user hasn't indicated which one
- The project scope is broad enough that different users would expect very different outcomes
- You filled in more than 2 significant product decisions yourself (game type, visual style, core mechanic, etc.)

**Set \`clarificationRequest.required\` to FALSE only when:**
- The user gave a specific, detailed request (e.g., "Build a Snake game with HTML5 Canvas, dark theme, 640x640 grid")
- There is essentially one reasonable interpretation of the task
- Your assumptions are all minor and unlikely to disappoint the user

When in doubt, SET IT TO TRUE. It is far better to ask one quick question than to build the wrong thing.

Rules for the clarification UI:
- Match the user's language (Korean task → Korean options)
- Ask for concrete product-shaping choices, not open-ended essays
- Prefer button-friendly options
- Give MANY useful options: at least 5 groups, each with 3-5 options, when clarification is required
- Put the recommended default first or mark it as recommended
- If clarification is NOT needed, set \`clarificationRequest.required\` to false and \`groups\` to []

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
    "rationale": "Why this complexity level"
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
  "clarificationRequest": {
    "required": false,
    "reason": "Why the user should clarify before debate/build continue",
    "message": "Short message asking the user to choose a direction",
    "summary": "Short note about how this will shape the next stages",
    "groups": [
      {
        "id": "platform",
        "label": "Platform",
        "selectionMode": "single | multi",
        "recommendedOptionId": "browser-2d",
        "options": [
          {
            "id": "browser-2d",
            "label": "Browser 2D",
            "detail": "Why this is a good default",
            "promptFragment": "Use a browser-based 2D game approach.",
            "recommended": true
          }
        ]
      }
    ]
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
- clarificationRequest is MANDATORY — use \`required: false\` with empty groups when no clarification is needed
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

**Your final recommendation must be internally consistent.** If you recommend "no ES modules", do not also recommend an option titled "ES Modules Multi-File". Pick ONE approach and commit to it. The DESIGN and BUILD steps will follow your recommendation literally.

**DO NOT use write tools. Analysis only.**`,

        design: `## RULES FOR THIS STEP
- You are in DESIGN ONLY mode. **DO NOT use the write, apply_patch, or multi_patch tools.**
- If you use any write tool in this step, the pipeline will fail.

## WHAT TO DO
Your job is to turn the DEBATE artifact into a CONCRETE, BUILD-READY implementation plan.

The DEBATE artifact is your ONLY upstream authority. It contains the final decisions on:
- Tech stack and architecture
- File structure and count
- Dependencies (or lack thereof)
- Implementation approach

The design response must be detailed enough to normalize into a DesignArtifact with fileManifest, workstreams, buildWaves, testPlan, and acceptanceChecks.

**Read the DEBATE artifact from Prior Step Results above and follow it exactly.**

### 1. FILE MANIFEST (MANDATORY)
List EVERY file to create. For EACH file you MUST specify ALL of these:
- **path**: exact file path (e.g. \`src/server.js\`)
- **purpose**: one-line description
- **layer**: one of: scaffold, config, shared, frontend, backend, database, realtime, testing, docs
- **owner**: the role that should write this file (executor, frontend-engineer, backend-engineer, db-engineer, test-engineer, build-doctor, docs-writer)
- **wave**: build order number (1 = first, 2 = after wave 1, etc.)

Example:
\`\`\`
{ "path": "package.json", "purpose": "Project dependencies and scripts", "layer": "scaffold", "owner": "executor", "wave": 1 }
{ "path": "src/server.js", "purpose": "Express server with WebSocket", "layer": "backend", "owner": "backend-engineer", "wave": 2 }
\`\`\`
YOU decide the layer, owner, and wave for each file based on the project context. Do NOT leave these empty.

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

### 6.5. TEST PLAN (MANDATORY)
List the exact tests to create under tests/ and what each one proves.
Every critical feature path must map to at least one automated test file.

### 7. RESPECT ANALYSIS DIRECTIVES
The analysis step provided MUST DO and MUST NOT DO directives.
INCORPORATE THEM into your design. Do not contradict the analysis.

Be EXTREMELY specific. The BUILD step will follow this plan literally.
OUTPUT FORMAT: structured text plan. NO files created.`,

        build: `## CRITICAL: YOU ARE THE BUILDER. WRITE ACTUAL CODE.

### WORKING DIRECTORY
Your working directory is: \`${childCwd}\`
**NEVER use /home/user, /home/user/repo, or any other path.** All file operations and bash commands run in the working directory above. Use relative paths for write tool, and if you need absolute paths in bash, use the path above.

### DELEGATION RULES
Only delegate to roles that can WRITE FILES: executor, frontend-engineer, devops-engineer, backend-engineer, test-engineer, db-engineer.
Do NOT delegate to browser-operator, api-designer, security-auditor, cicd-engineer in BUILD — they cannot write files and will just waste time. Browser verification belongs to the VERIFY step.

### FILE FORMAT RULES
- **JSON files (package.json, tsconfig.json, etc.) must be VALID JSON.** No comments (// or /* */), no trailing commas. JSON does not support comments.
- Write COMPLETE file content — no "..." ellipsis, no placeholders, no TODOs.
- Each file must work immediately after being written.

### FILE OWNERSHIP (CRITICAL)
Each file must be written by exactly ONE delegate. Do NOT have multiple delegates write the same file.
- Assign each file in the design plan to a specific delegate.
- If a delegate needs to know what another file contains, use the read tool — do NOT rewrite it.
- package.json should be written by ONE delegate only (usually devops-engineer).
- The main application code (game.js, app.js, etc.) should be written by ONE delegate (usually frontend-engineer or executor).

### TEST-CODE CONSISTENCY (CRITICAL)
Tests and application code MUST be consistent:
- If index.html has \`<canvas id="gameCanvas">\`, tests must use \`canvas#gameCanvas\` — NOT a different id.
- If index.html is the entry point, Playwright config must serve it correctly.
- After writing ALL files, ONE delegate should verify consistency: read the test file AND the application file, check that selectors/IDs/imports match.
- The delegate writing tests should READ the application code first, then write tests that match the actual DOM structure.

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
1. Treat the DesignArtifact above as the authoritative build plan.
2. Create package.json FIRST with all dependencies and a working "start" script.
3. Run \`bash: cd ${childCwd} && npm install\` to install dependencies.
4. Write EVERY application file listed in the DesignArtifact with COMPLETE, WORKING code.
5. **The main entry point (index.html for web apps) is the MOST IMPORTANT file. Create it FIRST after package.json.**
6. Write EVERY tests/ file listed in the DesignArtifact and implement real assertions, not placeholders.
7. Each file must be FULL — no placeholders, no TODOs, no "...".
8. DO NOT run test, build, lint, or startup verification commands in BUILD. Those belong to the VERIFY phase.
9. DO NOT STOP until every planned file is written and dependency installation is complete.
10. Before finishing, run \`bash: ls -la ${childCwd}\` to confirm all planned files exist.

### EFFICIENCY RULES
- Read each file AT MOST ONCE. Do not re-read files you already know the contents of.
- Write files in dependency order: package.json → server → client → tests.
- If npm install fails, check package.json for typos and fix immediately.`,

        verify: `## VERIFY THAT THE APPLICATION WORKS

### WORKING DIRECTORY
Your working directory is: \`${childCwd}\`
**NEVER use /home/user, /Users/username, or any other path.** Use the path above for all bash commands.

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

### STEP 7: FINAL VERDICT
After all checks, run this command to report your verdict:
- If ALL checks pass: \`bash: echo "VERIFY_VERDICT:PASS"\`
- If ANY critical check fails: \`bash: echo "VERIFY_VERDICT:FAIL" && exit 1\`

**A missing core deliverable (e.g., no index.html for a web game) is ALWAYS a critical failure, even if npm test passes.**

Report ALL errors with file paths and line numbers. Do NOT fix anything — just report.`,

        fix: `Fix ONLY the actionable failures reported by the verify step.

### WORKING DIRECTORY
Your working directory is: \`${childCwd}\`
**NEVER use /home/user, /Users/username, or any other path.** Use the path above for all bash commands.

### RULES
1. Read each broken file
2. Identify the root cause (not just the symptom)
3. Write the COMPLETE corrected file using the write tool (not just a patch)
4. If files are missing, CREATE them using the write tool — this is the most common fix
5. If npm install failed, run: \`cd ${childCwd} && npm install\`
6. Do NOT run verification commands in FIX. VERIFY is a separate phase.
7. **YOU MUST USE TOOLS.** Read files with the read tool, write fixes with the write tool. If you don't call any tools, the FIX step will fail.`,

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
    async function executeStep(prompt, mode, maxTurns, blockedTools, pipelineStep) {
      return new Promise((resolve, reject) => {
        if (aborted) { reject(new Error("Aborted")); return; }
        const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");

        const singleStepPrompt = pipelineStep && !/^\[STEP\s+\d+:/.test(prompt)
          ? `[STEP ${stepIdx + 1}: ${String(pipelineStep.type || "custom").toUpperCase()}] ${pipelineStep.title}

${prompt}`
          : prompt;
        traceText("Functions", `executeStep() input [${pipelineStep?.type || "custom"}]`, singleStepPrompt, "markdown");

        // [FIX #7] Pass prompt via temp file instead of CLI arg to avoid OS arg length limits
        const tmpPromptFile = path.join(os.tmpdir(), `agi-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        fs.writeFileSync(tmpPromptFile, singleStepPrompt, "utf-8");

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
        let preludeArtifact = null; // Capture AGI prelude artifact (analyze/debate/design)
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
              // Capture AGI prelude artifacts emitted by engine
              if (parsed.eventType === "agi.prelude.artifact" && parsed.payload?.artifact) {
                preludeArtifact = { type: parsed.payload.type, artifact: parsed.payload.artifact };
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

          // Error detection — match known error prefixes via string matching, no regex
          const errorPrefixes = [
            "Error:", "TypeError:", "SyntaxError:", "ReferenceError:", "RangeError:", "URIError:", "EvalError:",
            "FATAL ERROR", "FATAL EXCEPTION",
            "UnhandledPromiseRejection",
            "ENOENT", "EACCES", "EPERM",
            "Segmentation fault", "segmentation fault",
            "npm ERR!",
            "panic:",
            "Traceback (most recent",
          ];
          for (const line of stderr.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const lower = trimmed.toLowerCase();
            const isError = errorPrefixes.some(prefix => {
              const p = prefix.toLowerCase();
              return lower.startsWith(p) || lower.includes(p);
            }) || (trimmed.startsWith("    at ") && trimmed.includes("(")); // stack trace
            if (isError) errors.push(trimmed);
          }

          // [FIX #1, #10] Return full stdout as summary AND rawOutput — no truncation
          const resultPayload = { summary, changes, toolResults, tokensUsed: 0, errors, rawOutput: stdout, stderr, exitCode: code };
          // Attach prelude artifact if captured from engine events
          if (preludeArtifact) {
            if (preludeArtifact.type === "analyze") resultPayload.analysisArtifact = preludeArtifact.artifact;
            if (preludeArtifact.type === "debate") resultPayload.debateArtifact = preludeArtifact.artifact;
            if (preludeArtifact.type === "design") resultPayload.designArtifact = preludeArtifact.artifact;
          }
          traceJson("Functions", `executeStep() result [${pipelineStep?.type || "custom"}]`, {
            summary,
            changes,
            toolResults,
            tokensUsed: 0,
            errors,
            exitCode: code
          });
          traceText("Raw Outputs", `executeStep() rawOutput [${pipelineStep?.type || "custom"}]`, stdout || "(empty)", "text");
          if (stderr.trim()) traceText("Raw Outputs", `executeStep() stderr [${pipelineStep?.type || "custom"}]`, stderr, "text");
          resolve(resultPayload);
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

    async function executeAnalyzeStep(prompt) {
      if (aborted) throw new Error("Aborted");
      traceText("Functions", "executeAnalyzeStep() input", prompt, "markdown");
      const { ProviderRegistry } = require(path.join(PROJECT_DIR, "dist", "providers", "registry.js"));
      const { loadConfig } = require(path.join(PROJECT_DIR, "dist", "core", "config.js"));
      const config = await loadConfig(childCwd);
      const registry = new ProviderRegistry();
      let streamedText = "";

      const analyzeProvider = config.routing?.categories?.planning || "anthropic";
      sendAgi("agi.debug", { message: `ANALYZE provider resolved: ${analyzeProvider}`, config: { routing: config.routing, anthropicEnabled: config.providers?.anthropic?.enabled, openaiEnabled: config.providers?.openai?.enabled } });
      const response = await registry.invokeWithFailover(config, analyzeProvider, {
        role: "planner",
        category: "planning",
        systemPrompt: "You are the ANALYZE stage for the AGI pipeline. Return exactly one valid JSON object matching the requested schema. Do not wrap the JSON in markdown fences. Do not add commentary before or after the JSON.",
        prompt,
        responseFormat: "json"
      }, {
        onTextDelta: async (chunk, providerId) => {
          if (typeof chunk === "string" && chunk.length > 0) {
            streamedText += chunk;
            sendAgi("llm", { text: chunk, provider: providerId });
          }
        }
      });

      const rawText = (response.text || streamedText || "").trim();
      const parsed = extractStructuredJson(rawText);
      const tokensUsed = Number(response.usage?.inputTokens || 0) + Number(response.usage?.outputTokens || 0);
      if (!parsed) {
        const failureResult = {
          summary: rawText || "Structured ANALYZE response was empty.",
          rawOutput: rawText,
          changes: [],
          toolResults: [],
          tokensUsed,
          errors: ["Failed to parse structured ANALYZE JSON."],
          analysisArtifact: null
        };
        traceJson("Functions", "executeAnalyzeStep() result", failureResult);
        traceText("Raw Outputs", "executeAnalyzeStep() rawOutput", rawText || "(empty)", "json");
        return failureResult;
      }

      const artifact = normalizeAnalyzeArtifact(task, parsed);
      const successResult = {
        summary: summarizeAnalyzeArtifact(artifact),
        rawOutput: JSON.stringify(artifact, null, 2),
        changes: [],
        toolResults: [],
        tokensUsed,
        errors: [],
        analysisArtifact: artifact
      };
      traceJson("Functions", "executeAnalyzeStep() result", successResult);
      traceText("Raw Outputs", "executeAnalyzeStep() rawOutput", successResult.rawOutput, "json");
      return successResult;
    }

    // Run the pipeline
    const pipelineStartedAt = Date.now();
    let stepIdx = 0;
    let replanCount = 0;
    const MAX_REPLANS = 10;

    while (stepIdx < steps.length && !aborted) {
      if (replanCount > MAX_REPLANS) {
        sendAgi("agi.pipeline.fail", { error: `Max replans (${MAX_REPLANS}) exceeded` });
        break;
      }

      const step = steps[stepIdx];

      // Skip FIX step if VERIFY already passed — nothing to fix
      if (step.type === "fix") {
        const lastVerifyResult = ctx.stepResults.filter(r => r.type === "verify").pop();
        if (lastVerifyResult && lastVerifyResult.status === "completed") {
          sendAgi("agi.debug", { message: "Skipping FIX — VERIFY already passed" });
          sendAgi("agi.step.complete", { stepId: step.id, stepType: step.type, stepTitle: step.title, status: "completed", summary: "Skipped — VERIFY passed.", totalSteps: steps.length, completedSteps: ctx.stepResults.filter(r => r.status === "completed").length + 1, filesCreated: ctx.allFiles.length });
          ctx.stepResults.push({ stepId: step.id, type: step.type, status: "completed", summary: "Skipped — VERIFY passed.", changes: [], toolResults: [], durationMs: 0, tokensUsed: 0, errors: [] });
          stepIdx++;
          continue;
        }
      }

      // Artifact dependency validation — don't run steps if required upstream artifacts are missing
      if (step.type === "debate" && !ctx.analyzeArtifact) {
        sendAgi("agi.debug", { message: "DEBATE requires analyzeArtifact but it is null — pipeline cannot continue" });
        sendAgi("agi.pipeline.fail", { error: "DEBATE step requires a valid ANALYZE artifact. ANALYZE may have failed to produce structured output." });
        break;
      }
      if (step.type === "design" && !ctx.debateArtifact) {
        sendAgi("agi.debug", { message: "DESIGN requires debateArtifact but it is null — pipeline cannot continue" });
        sendAgi("agi.pipeline.fail", { error: "DESIGN step requires a valid DEBATE artifact. DEBATE may have failed to produce structured output." });
        break;
      }
      if (step.type === "build" && !ctx.designArtifact) {
        sendAgi("agi.debug", { message: "BUILD requires designArtifact but it is null — pipeline cannot continue" });
        sendAgi("agi.pipeline.fail", { error: "BUILD step requires a valid DESIGN artifact. DESIGN may have failed to produce structured output." });
        break;
      }

      // [FIX] Write step-specific AGENTS.md before each step
      writeStepAgentsMd(step.type);

      // [FIX] Block write tools at engine level for analysis steps
      // analyze step needs write for .agi/analysis.json (AGI_ALLOWED_WRITE_PATHS handles this)
      const isAnalysisStep = ["design", "debate"].includes(step.type);
      const blockedTools = isAnalysisStep ? ["write", "apply_patch", "multi_patch"]
        : step.type === "analyze" ? ["apply_patch", "multi_patch"] : [];

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

          // All steps use executeStep (CLI subprocess) — it runs the full engine
          // with proper auth, planner/researcher roles, and produces rich artifacts.
          const output = await executeStep(retryPrompt, step.mode, step.maxTurns, blockedTools, step);

          result = {
            stepId: step.id,
            type: step.type,
            status: output.errors.length === 0 ? "completed" : "failed",
            // [FIX #1, #10] Full summary and rawOutput — no truncation
            summary: output.summary,
            rawOutput: output.rawOutput,
            changes: output.changes,
            toolResults: output.toolResults,
            durationMs: Date.now() - start,
            tokensUsed: output.tokensUsed,
            errors: output.errors,
            analysisArtifact: output.analysisArtifact || null,
            debateArtifact: output.debateArtifact || null,
            designArtifact: output.designArtifact || null,
          };
          if (result.status === "completed") break;
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const errStack = e instanceof Error ? e.stack : undefined;
          sendAgi("agi.step.error", { stepId: step.id, stepType: step.type, error: errMsg, stack: errStack });
          result = {
            stepId: step.id, type: step.type, status: "failed",
            summary: `Step failed: ${errMsg}`, changes: [], toolResults: [],
            durationMs: Date.now() - start, tokensUsed: 0, errors: [errMsg],
          };
          ctx.errorLog.push({ stepId: step.id, error: errMsg, category: "runtime", resolved: false });
        }
      }

      // Record result
      if (result) {
        ctx.stepResults.push(result);
        traceJson("Step Results", `${step.type}:${step.title}`, result);
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

        if (step.type === "analyze" && result.status === "completed") {
          // Try multiple sources for the analysis artifact:
          // 1. Already parsed from output
          // 2. .agi/analysis.json file (written by the engine per prompt instructions)
          // 3. Extract JSON from rawOutput/summary text
          const parsedFromOutput = result.analysisArtifact
            || (() => {
              // Source 1: Read from CLI session file — the engine stores the planner output here
              const sessionsDir = path.join(childCwd, ".agent", "sessions");
              try {
                if (fs.existsSync(sessionsDir)) {
                  const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json") && !f.endsWith(".jsonl"));
                  // Get the most recent session file
                  const sorted = sessionFiles.sort((a, b) => {
                    try { return fs.statSync(path.join(sessionsDir, b)).mtimeMs - fs.statSync(path.join(sessionsDir, a)).mtimeMs; } catch { return 0; }
                  });
                  for (const sf of sorted) {
                    try {
                      const sessionData = JSON.parse(fs.readFileSync(path.join(sessionsDir, sf), "utf8"));
                      const plannerTask = sessionData.tasks?.find(t => t.role === "planner" && t.status === "completed");
                      if (plannerTask?.output && typeof plannerTask.output === "object" && plannerTask.output.clarificationRequest !== undefined) {
                        sendAgi("agi.debug", { message: `Loaded analysis from session file: ${sf}` });
                        return normalizeAnalyzeArtifact(task, plannerTask.output);
                      }
                    } catch {}
                  }
                }
              } catch (e) {
                sendAgi("agi.debug", { message: `Session file read failed: ${e.message}` });
              }
              // Source 2: .agi/analysis.json file
              const analysisFilePath = path.join(childCwd, ".agi", "analysis.json");
              try {
                if (fs.existsSync(analysisFilePath)) {
                  const fileContent = fs.readFileSync(analysisFilePath, "utf8");
                  const fileParsed = JSON.parse(fileContent);
                  sendAgi("agi.debug", { message: "Loaded analysis from .agi/analysis.json" });
                  return normalizeAnalyzeArtifact(task, fileParsed);
                }
              } catch (e) {
                sendAgi("agi.debug", { message: `.agi/analysis.json read failed: ${e.message}` });
              }
              // Source 3: extract JSON from text output
              const parsed = extractStructuredJson(result.rawOutput || result.summary || "");
              return parsed ? normalizeAnalyzeArtifact(task, parsed) : null;
            })();

          if (!parsedFromOutput) {
            result.status = "failed";
            result.summary = "AnalyzeArtifact generation failed.";
            result.errors = [...new Set([...(result.errors || []), "AnalyzeArtifact generation failed."])];
            sendAgi("agi.analysis.parseError", { error: "AnalyzeArtifact generation failed." });
          } else {
            result.analysisArtifact = parsedFromOutput;
            result.summary = summarizeAnalyzeArtifact(parsedFromOutput);
            result.rawOutput = JSON.stringify(parsedFromOutput, null, 2);
            sendAgi("agi.debug", {
              message: "ANALYZE artifact parsed",
              clarificationRequest: parsedFromOutput.clarificationRequest,
              clarificationRequired_raw: parsedFromOutput.clarificationRequest?.required,
              intent: parsedFromOutput.intent,
              codebaseState: parsedFromOutput.codebaseState,
              featureCount: parsedFromOutput.features?.length || 0,
            });
            applyAnalyzeArtifact(parsedFromOutput);

            // Dynamic complexity adjustment — AI decides, not regex
            const aiComplexity = parsedFromOutput.complexity?.level;
            if (aiComplexity) {
              complexity = aiComplexity;
              const buildStep = steps.find(s => s.type === "build" && !String(s.title || "").startsWith("Build Wave "));
              if (buildStep) {
                const turnMap = { "simple": 150, "moderate": 300, "complex": 500, "very-complex": 500 };
                buildStep.maxTurns = turnMap[aiComplexity] || 300;
                sendAgi("agi.debug", { message: `AI complexity: ${aiComplexity} → BUILD maxTurns=${buildStep.maxTurns}` });
              }
            }
          }
        }

        if (step.type === "debate" && result.status === "completed") {
          const parsedFromOutput = result.debateArtifact
            || (() => {
              const parsed = extractStructuredJson(result.rawOutput || result.summary || "");
              if (parsed) return normalizeDebateArtifact(task, parsed, ctx.analyzeArtifact);
              // No structured JSON found — this is a real failure, don't fabricate a minimal artifact
              sendAgi("agi.debug", { message: "DEBATE produced no structured JSON — cannot create valid artifact" });
              return null;
            })();

          if (!parsedFromOutput) {
            result.status = "failed";
            result.summary = "DebateArtifact generation failed.";
            result.errors = [...new Set([...(result.errors || []), "DebateArtifact generation failed."])];
            sendAgi("agi.debate.parseError", { error: "DebateArtifact generation failed." });
          } else {
            result.debateArtifact = parsedFromOutput;
            result.summary = summarizeDebateArtifact(parsedFromOutput);
            result.rawOutput = JSON.stringify(parsedFromOutput, null, 2);
            applyDebateArtifact(parsedFromOutput);
            if (parsedFromOutput.readiness === "blocked" && !aborted) {
              sendAgi("agi.pipeline.awaiting_input", {
                stepId: step.id,
                stepType: step.type,
                nextStep: "design",
                reason: "debate_blocked",
                summary: parsedFromOutput.summary,
                openQuestions: parsedFromOutput.openQuestions || []
              });
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
          }
        }

        if (step.type === "design" && result.status === "completed") {
          // Use AI output directly — no regex, no hardcoded overrides
          const sourceForDesign = result.designArtifact
            || extractStructuredJson(result.rawOutput || result.summary || "");
          if (!sourceForDesign) {
            result.status = "failed";
            result.summary = "DESIGN produced no structured JSON output.";
            result.errors = [...new Set([...(result.errors || []), "DESIGN produced no structured JSON output."])];
            sendAgi("agi.design.parseError", { error: "DESIGN produced no structured JSON output." });
          }
          const parsedFromOutput = sourceForDesign ? normalizeDesignArtifact(task, sourceForDesign, ctx.analyzeArtifact, ctx.debateArtifact) : null;

          if (!parsedFromOutput) {
            result.status = "failed";
            result.summary = "DesignArtifact generation failed.";
            result.errors = [...new Set([...(result.errors || []), "DesignArtifact generation failed."])];
            sendAgi("agi.design.parseError", { error: "DesignArtifact generation failed." });
          } else {
            result.designArtifact = parsedFromOutput;
            result.summary = summarizeDesignArtifact(parsedFromOutput);
            result.rawOutput = JSON.stringify(parsedFromOutput, null, 2);
            applyDesignArtifact(parsedFromOutput);
            if (parsedFromOutput.readiness === "blocked" && !aborted) {
              sendAgi("agi.pipeline.awaiting_input", {
                stepId: step.id,
                stepType: step.type,
                nextStep: "build",
                reason: "design_blocked",
                summary: parsedFromOutput.summary,
                testPlan: parsedFromOutput.testPlan || []
              });
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
            if (expandBuildStepsFromDesignArtifact(parsedFromOutput, stepIdx)) {
              replanCount += 1;
              sendAgi("agi.replan", { plan: { steps }, replanCount, totalSteps: steps.length });
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
        traceJson("Step State", `${step.type}:${step.title}`, {
          status: result.status,
          errors: result.errors,
          allFiles: ctx.allFiles,
          decisions: ctx.decisions,
          totalTokens: ctx.totalTokens
        });

        if (step.type === "analyze" && result.status !== "completed") {
          sendAgi("agi.pipeline.fail", { error: result.errors?.[0] || "AnalyzeArtifact generation failed." });
          break;
        }
        if (step.type === "debate" && result.status !== "completed") {
          sendAgi("agi.pipeline.fail", { error: result.errors?.[0] || "DebateArtifact generation failed." });
          break;
        }
        if (step.type === "design" && result.status !== "completed") {
          sendAgi("agi.pipeline.fail", { error: result.errors?.[0] || "DesignArtifact generation failed." });
          break;
        }
        if (step.type === "build" && result.status !== "completed") {
          sendAgi("agi.pipeline.fail", { error: result.errors?.[0] || "Build step failed." });
          break;
        }
        // VERIFY failure → continue to FIX step (don't stop the pipeline)
        // FIX failure → continue to next step (VERIFY will run again if pipeline has more iterations)
        // Only ask user for help if we've exhausted all FIX retries
        if (step.type === "verify" && result.status !== "completed") {
          // Check if there's a FIX step ahead — if so, let pipeline continue
          const hasFixStep = steps.slice(stepIdx + 1).some(s => s.type === "fix");
          if (hasFixStep) {
            sendAgi("agi.debug", { message: "VERIFY failed — continuing to FIX step" });
            // Don't break — let pipeline advance to FIX
          } else {
            sendAgi("agi.pipeline.fail", { error: result.errors?.[0] || "Verification failed and no FIX step available." });
            break;
          }
        }
        if (step.type === "fix" && result.status !== "completed") {
          // FIX failed — offer discussion or AI-vs-AI debate
          sendAgi("agi.pipeline.awaiting_input", {
            stepId: step.id,
            stepType: step.type,
            nextStep: "verify",
            reason: "needs_user_help",
            summary: `FIX step could not resolve all issues.`,
            errors: result.errors || [],
            discussionTopic: `FIX step failed. Errors: ${(result.errors || []).join("; ")}`,
            discussionContext: `Task: ${task}\nStep: ${step.title}\nPrevious attempts: ${verifyFixCycles}`,
            allowDiscussion: true,
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // FIX completed → go back to VERIFY ONLY if the previous VERIFY failed
        if (step.type === "fix" && result.status === "completed") {
          const lastVerifyResult = ctx.stepResults.filter(r => r.type === "verify").pop();
          if (lastVerifyResult && lastVerifyResult.status !== "completed") {
            verifyFixCycles++;
            if (verifyFixCycles < MAX_VERIFY_FIX_CYCLES) {
              const verifyIdx = steps.findIndex((s, i) => i < stepIdx && s.type === "verify");
              if (verifyIdx >= 0) {
                sendAgi("agi.debug", { message: `FIX completed, VERIFY was failing — re-running VERIFY (cycle ${verifyFixCycles}/${MAX_VERIFY_FIX_CYCLES})` });
                stepIdx = verifyIdx - 1; // will be incremented by stepIdx++ at bottom of loop
              }
            } else {
              // Max cycles exhausted — ask user for help instead of silently continuing
              sendAgi("agi.debug", { message: `Max VERIFY-FIX cycles (${MAX_VERIFY_FIX_CYCLES}) reached — escalating to user` });
              sendAgi("agi.pipeline.awaiting_input", {
                stepId: step.id,
                stepType: "fix",
                nextStep: "verify",
                reason: "needs_user_help",
                summary: `VERIFY-FIX loop exhausted ${MAX_VERIFY_FIX_CYCLES} cycles without resolving all issues.`,
                errors: result.errors || [],
                discussionTopic: `VERIFY-FIX loop failed after ${MAX_VERIFY_FIX_CYCLES} cycles. Errors: ${(result.errors || []).join("; ")}`,
                discussionContext: `Task: ${task}\nCycles attempted: ${MAX_VERIFY_FIX_CYCLES}\nAll step results available.`,
                allowDiscussion: true,
              });
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
          }
          // If last VERIFY passed, don't loop back — we're done
        }


        if (step.type === "analyze" && result.status === "completed" && clarificationRequest && !aborted) {
          const nextPlanningStep = steps.slice(stepIdx + 1).find((candidate) => candidate.type !== "analyze")?.type || "design";
          traceJson("Clarification", "clarificationRequest", clarificationRequest);
          sendAgi("agi.clarification.requested", {
            stepId: step.id,
            stepType: step.type,
            stepTitle: step.title,
            originalTask: task,
            reason: clarificationRequest.reason,
            message: clarificationRequest.message,
            summary: clarificationRequest.summary,
            groups: clarificationRequest.groups,
            targetStep: nextPlanningStep
          });
          sendAgi("agi.pipeline.awaiting_input", {
            stepId: step.id,
            stepType: step.type,
            nextStep: nextPlanningStep,
            reason: "clarification_required"
          });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

      }

      stepIdx++;
    }

    // ═══ Pipeline complete ═══
    const completed = ctx.stepResults.filter(r => r.status === "completed").length;
    const failed = ctx.stepResults.filter(r => r.status === "failed").length;
    const success = !aborted && failed === 0;

    // Save run-summary.json for future runs to detect and optionally continue from
    try {
      const runSummary = {
        runId: traceRunId,
        task,
        completedAt: new Date().toISOString(),
        success,
        totalSteps: steps.length,
        completedSteps: completed,
        failedSteps: failed,
        filesCreated: ctx.allFiles.length,
        totalTokens: ctx.totalTokens,
        durationMs: Date.now() - pipelineStartedAt,
        allFiles: ctx.allFiles,
        decisions: ctx.decisions,
        debateConclusion: ctx.debateArtifact?.recommendedApproach || ctx.debateArtifact?.summary || "",
        // Store full artifacts for "continue" mode
        analyzeArtifact: ctx.analyzeArtifact || null,
        debateArtifact: ctx.debateArtifact || null,
        designArtifact: ctx.designArtifact || null,
      };
      const summaryDir = path.join(childCwd, ".agent");
      if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir, { recursive: true });
      fs.writeFileSync(path.join(summaryDir, "run-summary.json"), JSON.stringify(runSummary, null, 2), "utf8");
    } catch {}

    sendAgi("agi.pipeline.complete", {
      success,
      totalSteps: steps.length,
      completedSteps: completed,
      failedSteps: failed,
      filesCreated: ctx.allFiles.length,
      totalTokens: ctx.totalTokens,
      projectDir: projName,
      replanCount,
      durationMs: Date.now() - pipelineStartedAt,
      summary: `${completed}/${ctx.stepResults.length} steps completed, ${ctx.allFiles.length} files created`,
    });
    traceJson("Pipeline", "complete", {
      success,
      totalSteps: steps.length,
      completedSteps: completed,
      failedSteps: failed,
      filesCreated: ctx.allFiles.length,
      totalTokens: ctx.totalTokens,
      projectDir: projName,
      replanCount,
      durationMs: Date.now() - pipelineStartedAt,
      tracePath
    });

    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // ── AGI Discussion System — User↔AI or AI↔AI debate to resolve issues ──
  if (url.pathname === "/api/agi/discuss" && req.method === "POST") {
    const body = await readBody(req);
    const { topic, context, userMessage, mode, provider: discussProvider } = safeJsonParse(body) || {};
    // mode: "user" (user types input) or "auto" (AI-vs-AI debate)

    if (!topic) { res.writeHead(400); res.end("Missing topic"); return; }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const sendDisc = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };

    try {
      const { ProviderRegistry } = require(path.join(PROJECT_DIR, "dist", "providers", "registry.js"));
      const { loadConfig } = require(path.join(PROJECT_DIR, "dist", "core", "config.js"));
      const config = await loadConfig(CWD);
      const registry = new ProviderRegistry();
      const selectedProv = discussProvider || "anthropic";

      if (mode === "auto") {
        // ── AI-vs-AI Debate Mode ──
        // Two AI perspectives debate to reach optimal conclusion
        sendDisc("agi.discussion.start", { mode: "auto", topic });

        const MAX_DEBATE_ROUNDS = 3;
        const debateHistory = [];

        // Perspective A: Optimistic / Build-forward
        const perspectiveA = await registry.invokeWithFailover(config, selectedProv, {
          role: "planner", category: "planning",
          systemPrompt: "You are Perspective A — the pragmatic builder. You favor practical solutions that unblock progress. Be concise.",
          prompt: `Topic: ${topic}\n\nContext: ${context || "none"}\n\nPropose the most practical solution to move forward. Be specific — give exact steps. Output JSON:\n{"position": "your position", "reasoning": "why", "steps": ["step 1", "step 2"], "confidence": "high|medium|low"}`,
          responseFormat: "json"
        }, {});
        sendDisc("agi.discussion.message", { from: "AI-A (Builder)", text: perspectiveA.text });
        debateHistory.push({ from: "A", text: perspectiveA.text });

        // Perspective B: Critical / Risk-aware
        const perspectiveB = await registry.invokeWithFailover(config, selectedProv, {
          role: "reviewer", category: "review",
          systemPrompt: "You are Perspective B — the critical reviewer. You challenge assumptions, find risks, and ensure quality. Be concise.",
          prompt: `Topic: ${topic}\n\nContext: ${context || "none"}\n\nPerspective A proposed:\n${perspectiveA.text}\n\nChallenge this proposal. What could go wrong? What's missing? Suggest improvements or an alternative. Output JSON:\n{"position": "your position", "challenges": ["challenge 1"], "improvements": ["improvement 1"], "alternative": "if you have a better approach", "confidence": "high|medium|low"}`,
          responseFormat: "json"
        }, {});
        sendDisc("agi.discussion.message", { from: "AI-B (Critic)", text: perspectiveB.text });
        debateHistory.push({ from: "B", text: perspectiveB.text });

        // Rounds of refinement
        let lastA = perspectiveA.text;
        let lastB = perspectiveB.text;
        for (let round = 2; round <= MAX_DEBATE_ROUNDS; round++) {
          // A responds to B's challenges
          const responseA = await registry.invokeWithFailover(config, selectedProv, {
            role: "planner", category: "planning",
            systemPrompt: "You are Perspective A. Address the critic's challenges. Adjust your proposal if they have valid points. Be concise.",
            prompt: `Topic: ${topic}\n\nYour previous position:\n${lastA}\n\nCritic's response:\n${lastB}\n\nAddress their challenges. Update your proposal. If they're right about something, incorporate it. Output JSON:\n{"updatedPosition": "refined position", "accepted": ["what you accepted from critic"], "defended": ["what you defended"], "finalSteps": ["step 1", "step 2"]}`,
            responseFormat: "json"
          }, {});
          sendDisc("agi.discussion.message", { from: `AI-A (Round ${round})`, text: responseA.text });
          lastA = responseA.text;

          // B reviews A's update
          const responseB = await registry.invokeWithFailover(config, selectedProv, {
            role: "reviewer", category: "review",
            systemPrompt: "You are Perspective B. Review the updated proposal. If acceptable, APPROVE. If not, explain remaining concerns. Be concise.",
            prompt: `Topic: ${topic}\n\nBuilder's updated proposal:\n${lastA}\n\nIs this acceptable now? Output JSON:\n{"verdict": "approve|needs-work", "reason": "why", "remainingConcerns": []}`,
            responseFormat: "json"
          }, {});
          sendDisc("agi.discussion.message", { from: `AI-B (Round ${round})`, text: responseB.text });
          lastB = responseB.text;

          // Check if approved
          if (lastB.toLowerCase().includes('"approve"') || lastB.toLowerCase().includes("verdict\":\"approve")) break;
        }

        // Final synthesis — combine both perspectives into one conclusion
        const synthesis = await registry.invokeWithFailover(config, selectedProv, {
          role: "planner", category: "planning",
          systemPrompt: "You are a neutral synthesizer. Combine the best of both perspectives into a single actionable conclusion.",
          prompt: `Topic: ${topic}\n\nDebate summary:\n${debateHistory.map(d => `[${d.from}]: ${d.text}`).join("\n\n")}\n\nFinal Builder position: ${lastA}\nFinal Critic position: ${lastB}\n\nSynthesize the OPTIMAL conclusion. Output JSON:\n{"conclusion": "the final decision", "reasoning": "why this is optimal", "actionSteps": ["step 1", "step 2", "step 3"], "risksAccepted": ["risk 1"], "risksMitigated": ["mitigation 1"]}`,
          responseFormat: "json"
        }, {});

        sendDisc("agi.discussion.conclusion", { text: synthesis.text, rounds: debateHistory.length });
        sendDisc("agi.discussion.done", { mode: "auto" });

      } else {
        // ── User↔AI Discussion Mode ──
        sendDisc("agi.discussion.start", { mode: "user", topic });

        const aiResponse = await registry.invokeWithFailover(config, selectedProv, {
          role: "planner", category: "planning",
          systemPrompt: "You are discussing an issue with the user. Be helpful, concise, and suggest actionable solutions. Match the user's language.",
          prompt: `Topic: ${topic}\n\nContext: ${context || "none"}\n\nUser says: ${userMessage}\n\nRespond helpfully. If you can resolve the issue, explain how. If you need more info, ask a specific question.`,
          responseFormat: "text"
        }, {});

        sendDisc("agi.discussion.message", { from: "AI", text: aiResponse.text });
        sendDisc("agi.discussion.done", { mode: "user" });
      }
    } catch (err) {
      sendDisc("agi.discussion.error", { error: err.message || String(err) });
    }

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
    const dir = url.searchParams.get("path") || require("os").homedir();
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
      const { execSync } = require("child_process");
      const checks = [];
      const timed = (name, category, fn) => { const s = Date.now(); try { const r = fn(); checks.push({ ...r, name, category, durationMs: Date.now() - s }); } catch (e) { checks.push({ name, category, status: "error", message: e.message, durationMs: Date.now() - s }); } };

      // ── Environment ──
      timed("Node.js", "Environment", () => ({ status: "ok", message: `${process.version} (${process.platform} ${process.arch})` }));
      timed("npm", "Environment", () => { const v = execSync("npm --version", { encoding: "utf-8", timeout: 5000 }).trim(); return { status: "ok", message: `v${v}` }; });
      timed("Git", "Environment", () => { const v = execSync("git --version", { encoding: "utf-8", timeout: 3000 }).trim(); return { status: "ok", message: v }; });
      timed("Shell", "Environment", () => ({ status: "ok", message: process.env.SHELL || "unknown" }));
      timed("Memory", "Environment", () => { const mem = process.memoryUsage(); const mb = Math.round(mem.heapUsed / 1024 / 1024); return { status: mb > 500 ? "warn" : "ok", message: `${mb}MB heap used` }; });
      timed("Disk (CWD)", "Environment", () => { try { const out = execSync(`df -h "${CWD}" | tail -1`, { encoding: "utf-8", timeout: 3000 }).trim(); const parts = out.split(/\s+/); return { status: parseInt(parts[4]) > 90 ? "warn" : "ok", message: `${parts[3]} free (${parts[4]} used)` }; } catch { return { status: "ok", message: "Unable to check" }; } });

      // ── Providers ──
      for (const [name, envKey] of [["OpenAI", "OPENAI_API_KEY"], ["Anthropic", "ANTHROPIC_API_KEY"], ["Gemini", "GEMINI_API_KEY"]]) {
        timed(name + " API Key", "Providers", () => ({ status: process.env[envKey] ? "ok" : "warn", message: process.env[envKey] ? `${envKey} set (${process.env[envKey].slice(0,8)}...)` : `${envKey} not set` }));
      }
      timed("Codex OAuth", "Providers", () => { const p = path.join(require("os").homedir(), ".codex", "auth.json"); return { status: fs.existsSync(p) ? "ok" : "warn", message: fs.existsSync(p) ? "Token found" : "Not configured — run: codex auth login" }; });
      timed("Claude OAuth", "Providers", () => { const p = path.join(require("os").homedir(), ".claude"); return { status: fs.existsSync(p) ? "ok" : "warn", message: fs.existsSync(p) ? "Claude config found" : "Not configured — run: claude auth login" }; });

      // ── Workspace ──
      timed("Config File", "Workspace", () => { const p = path.join(CWD, ".agent", "config.json"); if (!fs.existsSync(p)) return { status: "warn", message: "No config — using defaults" }; const sz = fs.statSync(p).size; return { status: "ok", message: `Found (${sz} bytes)` }; });
      timed("package.json", "Workspace", () => { const p = path.join(CWD, "package.json"); if (!fs.existsSync(p)) return { status: "warn", message: "Not found" }; const pkg = JSON.parse(fs.readFileSync(p, "utf8")); return { status: "ok", message: `${pkg.name || "unnamed"}@${pkg.version || "0.0.0"}` }; });
      timed("node_modules", "Workspace", () => { const p = path.join(CWD, "node_modules"); return { status: fs.existsSync(p) ? "ok" : "warn", message: fs.existsSync(p) ? "Installed" : "Missing — run: npm install" }; });
      timed("Build Output", "Workspace", () => { const p = path.join(CWD, "dist", "cli.js"); return { status: fs.existsSync(p) ? "ok" : "warn", message: fs.existsSync(p) ? "dist/cli.js exists" : "Not built — run: npm run build" }; });
      timed("File Count", "Workspace", () => { const n = fs.readdirSync(CWD).length; return { status: "ok", message: `${n} entries in root` }; });
      timed(".gitignore", "Workspace", () => { const p = path.join(CWD, ".gitignore"); return { status: fs.existsSync(p) ? "ok" : "warn", message: fs.existsSync(p) ? "Present" : "Missing — secrets may be committed" }; });

      // ── Git ──
      timed("Git Repo", "Git", () => { try { execSync("git rev-parse --is-inside-work-tree", { cwd: CWD, encoding: "utf-8", timeout: 3000 }); return { status: "ok", message: "Valid repository" }; } catch { return { status: "warn", message: "Not a git repository" }; } });
      timed("Git Branch", "Git", () => { try { const b = execSync("git branch --show-current", { cwd: CWD, encoding: "utf-8", timeout: 3000 }).trim(); return { status: "ok", message: b || "detached HEAD" }; } catch { return { status: "warn", message: "Unable to determine" }; } });
      timed("Uncommitted Changes", "Git", () => { try { const s = execSync("git status --porcelain", { cwd: CWD, encoding: "utf-8", timeout: 5000 }).trim(); const n = s ? s.split("\n").length : 0; return { status: n > 20 ? "warn" : "ok", message: n === 0 ? "Clean working tree" : `${n} changed file(s)` }; } catch { return { status: "warn", message: "Unable to check" }; } });
      timed("Remote", "Git", () => { try { const r = execSync("git remote get-url origin", { cwd: CWD, encoding: "utf-8", timeout: 3000 }).trim(); return { status: "ok", message: r }; } catch { return { status: "warn", message: "No remote configured" }; } });

      // ── Tools ──
      for (const [tool, cmd] of [["TypeScript", "npx tsc --version"], ["ESLint", "npx eslint --version"], ["Prettier", "npx prettier --version"]]) {
        timed(tool, "Tools", () => { try { const v = execSync(cmd, { cwd: CWD, encoding: "utf-8", timeout: 10000, stdio: ["pipe","pipe","pipe"] }).trim(); return { status: "ok", message: v }; } catch { return { status: "warn", message: "Not available" }; } });
      }
      timed("Playwright", "Tools", () => { try { require.resolve("playwright"); return { status: "ok", message: "Installed" }; } catch { return { status: "warn", message: "Not installed" }; } });

      // ── Security ──
      timed(".env Protection", "Security", () => { const gi = path.join(CWD, ".gitignore"); if (!fs.existsSync(gi)) return { status: "warn", message: "No .gitignore" }; const c = fs.readFileSync(gi, "utf8"); return { status: c.includes(".env") ? "ok" : "warn", message: c.includes(".env") ? ".env in .gitignore" : ".env NOT in .gitignore — secrets at risk" }; });
      timed("Exposed Secrets", "Security", () => { const envFile = path.join(CWD, ".env"); if (!fs.existsSync(envFile)) return { status: "ok", message: "No .env file in root" }; try { const tracked = execSync(`git ls-files --error-unmatch .env`, { cwd: CWD, encoding: "utf-8", timeout: 3000, stdio: ["pipe","pipe","pipe"] }); return { status: "error", message: ".env is tracked by git — REMOVE IT" }; } catch { return { status: "ok", message: ".env exists but not tracked" }; } });

      const errors = checks.filter(c => c.status === "error").length;
      const warnings = checks.filter(c => c.status === "warn").length;
      const okCount = checks.filter(c => c.status === "ok").length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healthy: errors === 0, checks, summary: `${checks.length} checks: ${okCount} ok, ${warnings} warn, ${errors} error` }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healthy: false, checks: [], error: e.message }));
    }
    return;
  }

  // ── Resolve dropped file/folder path ──
  if (url.pathname === "/api/resolve-drop-path" && req.method === "POST") {
    const body = await readBody(req);
    const { fullPath, name, isDirectory } = safeJsonParse(body) || {};

    let resolved = null;

    // Method 1: Full absolute path from file:// URL (most reliable)
    if (fullPath && fullPath.startsWith('/')) {
      if (fullPath.startsWith(CWD)) {
        // Inside project — convert to relative
        const rel = path.relative(CWD, fullPath);
        try {
          const stat = fs.statSync(fullPath);
          resolved = stat.isDirectory() ? rel : path.dirname(rel);
          if (resolved === '.') resolved = '';
        } catch {
          resolved = path.dirname(rel);
          if (resolved === '.') resolved = '';
        }
      } else {
        // Outside project — use absolute path directly for scan
        try {
          const stat = fs.statSync(fullPath);
          resolved = stat.isDirectory() ? fullPath : path.dirname(fullPath);
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Path not found: ${fullPath}` }));
          return;
        }
      }
    }

    // Method 2: Search by name (fallback)
    if (resolved === null && name) {
      function findInDir(dir, target, depth) {
        if (depth > 5) return null;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const ignoreDirs = ["node_modules","dist",".git","build","coverage",".next",".agent"];
          for (const e of entries) {
            if (ignoreDirs.includes(e.name)) continue;
            if (e.name === target) {
              const full = path.join(dir, e.name);
              const stat = fs.statSync(full);
              if (stat.isDirectory()) return path.relative(CWD, full);
              return path.relative(CWD, path.dirname(full));
            }
            if (e.isDirectory()) {
              const found = findInDir(path.join(dir, e.name), target, depth + 1);
              if (found) return found;
            }
          }
        } catch {}
        return null;
      }
      // Direct check
      const directPath = path.join(CWD, name);
      if (fs.existsSync(directPath)) {
        const stat = fs.statSync(directPath);
        resolved = stat.isDirectory() ? name : path.dirname(name);
        if (resolved === '.') resolved = '';
      } else {
        resolved = findInDir(CWD, name, 0);
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resolved !== null ? { path: resolved } : { error: `"${name || fullPath}" not found in project` }));
    return;
  }

  // ── Resolve dropped folder name via Spotlight (system-wide search) ──
  if (url.pathname === "/api/resolve-drop-folder" && req.method === "POST") {
    const body = await readBody(req);
    const { name } = safeJsonParse(body) || {};
    if (!name) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "name required" })); return; }
    try {
      const { execSync } = require("child_process");
      // Use mdfind (Spotlight) to find directories with this exact name
      const cmd = `mdfind "kMDItemFSName == '${name.replace(/'/g, "\\'")}' && kMDItemContentType == 'public.folder'" 2>/dev/null | head -20`;
      const output = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
      const candidates = output.split("\n").filter(p => p && p.startsWith("/") && !p.includes("/node_modules/") && !p.includes("/.git/"));
      if (candidates.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Folder "${name}" not found on this system` }));
        return;
      }
      // Sort: prefer paths outside CWD, prefer shorter paths, prefer recently modified
      const scored = candidates.map(p => {
        let score = 0;
        if (p.startsWith(CWD)) score -= 10; // deprioritize CWD-internal matches
        if (p.includes("node_modules") || p.includes(".git") || p.includes("Library")) score -= 5;
        // Prefer common project locations
        if (p.includes("/Developer/") || p.includes("/Projects/") || p.includes("/Desktop/") || p.includes("/Documents/")) score += 3;
        try { const stat = fs.statSync(p); score += Math.min(5, Math.floor((Date.now() - stat.mtimeMs) / -86400000) + 5); } catch {}
        return { path: p, score };
      }).sort((a, b) => b.score - a.score);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: scored.map(s => s.path) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Browse folders API ──
  if (url.pathname === "/api/browse-folders" && req.method === "GET") {
    const rel = url.searchParams?.get("path") || "";
    const target = path.resolve(CWD, rel);
    // Security: must be within CWD
    if (!target.startsWith(CWD)) { res.writeHead(403); res.end("Access denied"); return; }
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const ignoreDirs = ["node_modules","dist",".git","build","coverage",".next",".agent",".research","autoresearch-mega-eval","electron"];
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && !ignoreDirs.includes(e.name))
        .map(e => ({ name: e.name, path: path.relative(CWD, path.join(target, e.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ current: path.relative(CWD, target) || ".", dirs }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Browse filesystem folders (absolute paths, for AGI target selection) ──
  if (url.pathname === "/api/browse-folders-abs" && req.method === "GET") {
    const reqPath = url.searchParams?.get("path") || "/";
    const target = path.resolve(reqPath);
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const ignoreDirs = ["node_modules","dist",".git","build","coverage",".next",".agent","$Recycle.Bin","System Volume Information"];
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && !ignoreDirs.includes(e.name))
        .map(e => ({ name: e.name, path: path.join(target, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = target === "/" ? null : path.dirname(target);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ current: target, parent, dirs }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ══ Shared AI Auth + Call helpers ══
  function _getAnthropicAuth() {
    if (process.env.ANTHROPIC_API_KEY) return { token: process.env.ANTHROPIC_API_KEY, mode: "api_key" };
    const homedir = require("os").homedir();
    for (const p of [path.join(homedir, ".claude", ".credentials.json"), path.join(homedir, ".claude", "credentials.json")]) {
      try { const raw = JSON.parse(fs.readFileSync(p, "utf8")); const token = raw.claudeAiOauth?.accessToken || raw.access_token; if (token) return { token, mode: "oauth" }; } catch {}
    }
    try {
      const token = require("child_process").execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', { encoding: "utf8", timeout: 3000 }).trim();
      if (token) { const parsed = JSON.parse(token); const at = parsed.claudeAiOauth?.accessToken || parsed.access_token; if (at) return { token: at, mode: "oauth" }; }
    } catch {}
    return null;
  }
  function _getOpenAIAuth() {
    if (process.env.OPENAI_API_KEY) return { token: process.env.OPENAI_API_KEY, accountId: null };
    try { const p = path.join(require("os").homedir(), ".codex", "auth.json"); const raw = JSON.parse(fs.readFileSync(p, "utf8")); const token = raw.tokens?.access_token; const accountId = raw.tokens?.account_id; if (token) return { token, accountId }; } catch {}
    return null;
  }
  async function _callAI(provider, messages, maxTokens = 3000) {
    if (provider === "anthropic") {
      const auth = _getAnthropicAuth();
      if (!auth) throw new Error("Anthropic not authenticated — connect via Settings > Providers");
      const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
      if (auth.mode === "oauth") { headers["authorization"] = `Bearer ${auth.token}`; headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14"; }
      else { headers["x-api-key"] = auth.token; }
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages }) });
      const d = await r.json(); if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    } else {
      const auth = _getOpenAIAuth();
      if (!auth) throw new Error("OpenAI not authenticated — connect via Settings > Providers");
      const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${auth.token}` };
      if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
      // Use Codex OAuth endpoint (free with ChatGPT subscription) — never api.openai.com
      const codexUrl = "https://chatgpt.com/backend-api/codex/responses";
      const r = await fetch(codexUrl, { method: "POST", headers, body: JSON.stringify({ model: "gpt-4o", instructions: messages.find(m => m.role === "system")?.content || "", input: messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })), max_output_tokens: maxTokens }) });
      const d = await r.json(); if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      // Codex responses format: output array with message items
      const output = d.output || [];
      const text = output.filter(o => o.type === "message").map(o => (o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("")).join("");
      return text || d.choices?.[0]?.message?.content || "";
    }
  }
  // Helper: read code files from a directory
  function _readCodeFiles(scanRoot, maxTotalChars = 80000) {
    const exts = [".js",".ts",".tsx",".jsx",".cjs",".mjs",".html",".css"];
    const ignoreDirs = ["node_modules","dist",".git","build","coverage",".next",".agent",".research","autoresearch-mega-eval","electron"];
    const files = [];
    let totalChars = 0;
    function walk(dir, depth) {
      if (depth > 6 || totalChars > maxTotalChars) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (ignoreDirs.includes(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (!exts.some(x => e.name.endsWith(x))) continue;
          try {
            const stat = fs.statSync(full);
            if (stat.size > 500 * 1024) continue;
            const content = fs.readFileSync(full, "utf8");
            const rel = path.relative(CWD, full);
            files.push({ file: rel, content, sizeKB: Math.round(stat.size / 1024) });
            totalChars += content.length;
            if (totalChars > maxTotalChars) return;
          } catch {}
        }
      } catch {}
    }
    walk(scanRoot, 0);
    return files;
  }

  // ── AI Code Analysis (read code → AI identifies issues by risk) ──
  if (url.pathname === "/api/scan-code-health" && req.method === "POST") {
    const body = await readBody(req);
    const { folder } = safeJsonParse(body) || {};

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const send = (type, data) => { try { res.write(`data: ${JSON.stringify({type,data})}\n\n`); } catch {} };

    try {
      const scanRoot = folder ? (folder.startsWith('/') ? folder : path.resolve(CWD, folder)) : CWD;
      if (!fs.existsSync(scanRoot)) { send("error", "Folder not found: " + folder); res.end(); return; }

      send("status", "Reading code files...");
      const codeFiles = _readCodeFiles(scanRoot);
      send("status", `Read ${codeFiles.length} files. AI is analyzing code...`);

      if (codeFiles.length === 0) { send("result", { issues: [], fileCount: 0, scannedFolder: folder || "." }); send("done", null); res.end(); return; }

      // Build code summary for AI (truncate if too large)
      const codeSummary = codeFiles.map(f => `=== ${f.file} (${f.sizeKB}KB) ===\n${f.content.slice(0, 3000)}`).join("\n\n").slice(0, 60000);

      // AI reads all code and identifies real issues ranked by risk
      const analysis = await _callAI("anthropic", [{
        role: "user",
        content: `You are a senior code auditor. Read ALL the code below and identify real issues.\n\nCategorize issues by severity:\n- 🔴 CRITICAL: Security vulnerabilities, data loss risks, crashes\n- 🟠 HIGH: Bugs, logic errors, race conditions, memory leaks\n- 🟡 MEDIUM: Bad patterns, performance issues, missing error handling\n- 🔵 LOW: Code smells, style issues, minor improvements\n\nFor each issue provide:\n- file, line number, severity (critical/high/medium/low)\n- category (security/bug/performance/pattern/style)\n- description (1-2 sentences, specific)\n- suggested fix (brief)\n\nOutput ONLY JSON array: [{"file":"...","line":N,"severity":"critical|high|medium|low","category":"...","description":"...","suggestedFix":"..."}]\n\nRules:\n- Only report REAL issues. Not style preferences.\n- Ignore test data strings that happen to contain keywords like "todo"\n- Focus on things that could actually break in production\n- Max 20 issues, prioritize by severity\n\nCode:\n${codeSummary}`
      }], 4000);

      let issues = [];
      try {
        const match = analysis.match(/\[[\s\S]*\]/);
        if (match) issues = JSON.parse(match[0]);
      } catch {}

      // Sort by severity
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      issues.sort((a, b) => (sevOrder[a.severity] ?? 4) - (sevOrder[b.severity] ?? 4));

      send("analysis", analysis);
      send("result", { issues, fileCount: codeFiles.length, scannedFolder: folder || "." });
      send("done", null);
    } catch (e) {
      send("error", e.message);
    }
    res.end();
    return;
  }

  // ── Dual-AI Debate Fix API (Claude + OpenAI, up to 5 rounds each = 10 turns max) ──
  if (url.pathname === "/api/ai-debate-fix" && req.method === "POST") {
    const body = await readBody(req);
    const { issues } = safeJsonParse(body) || {};
    if (!issues || !issues.length) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"No issues provided"})); return; }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const send = (type, data) => { try { res.write(`data: ${JSON.stringify({type,data})}\n\n`); } catch {} };

    try {
      // Read source files
      const fileContents = {};
      for (const issue of issues.slice(0, 10)) {
        if (!fileContents[issue.file]) {
          try { fileContents[issue.file] = fs.readFileSync(path.join(CWD, issue.file), "utf8"); } catch {}
        }
      }
      const issueList = issues.slice(0, 10).map((i, idx) => `${idx + 1}. [${i.type}] ${i.file}:${i.line} — ${i.text}`).join("\n");
      const fileSnippets = Object.entries(fileContents).map(([f, c]) => {
        const lines = c.split("\n");
        const relevantLines = new Set();
        issues.filter(i => i.file === f).forEach(i => {
          for (let l = Math.max(0, i.line - 15); l < Math.min(lines.length, i.line + 15); l++) relevantLines.add(l);
        });
        return `=== ${f} ===\n` + [...relevantLines].sort((a, b) => a - b).map(l => `${l + 1}: ${lines[l]}`).join("\n");
      }).join("\n\n");

      const MAX_ROUNDS = 5; // 5 rounds = Claude speaks 5 times, OpenAI speaks 5 times = 10 turns
      const claudeHistory = []; // Anthropic messages
      const openaiHistory = [{ role: "system", content: "You are a strict senior code reviewer at a top tech company. Your job: prevent over-engineering, reject unnecessary changes, ensure minimal diffs. Be direct and opinionated. When you see a good fix, APPROVE it. When it's overkill, REJECT it and explain why. When it's close but needs adjustment, MODIFY it with your exact version. You must reach a final consensus — no open-ended suggestions." }];

      // ── Round 1: Claude initial proposal ──
      send("status", "Round 1/5: Claude analyzing issues and proposing fixes...");
      claudeHistory.push({
        role: "user",
        content: `You are a precise code fixer. Below are code issues. Propose minimal fixes.\n\nRULES:\n- Fix ONLY the listed issues. Do NOT touch surrounding code.\n- Smallest possible change for each fix.\n- Each fix: exact old_string → new_string replacement.\n- JSON format: [{"file":"...","old":"exact old text","new":"exact new text","reason":"one sentence","confidence":"high|medium|low"}]\n\nIssues:\n${issueList}\n\nCode:\n${fileSnippets}\n\nRespond with ONLY the JSON array.`
      });
      const round1Claude = await _callAI("anthropic", claudeHistory);
      claudeHistory.push({ role: "assistant", content: round1Claude });
      send("claude", round1Claude);

      // ── Round 1: OpenAI reviews ──
      send("status", "Round 1/5: OpenAI reviewing Claude's proposals...");
      openaiHistory.push({
        role: "user",
        content: `Original issues:\n${issueList}\n\nSource code:\n${fileSnippets}\n\nClaude proposed these fixes:\n${round1Claude}\n\nReview EACH fix. For each one respond:\n- APPROVE: fix is correct and minimal\n- REJECT: fix is wrong, unnecessary, or over-engineered (explain why)\n- MODIFY: fix idea is right but implementation needs adjustment (provide your exact version)\n\nJSON format: [{"index":0,"verdict":"APPROVE|REJECT|MODIFY","reason":"...","modified_old":"if MODIFY","modified_new":"if MODIFY"}]\n\nBe strict. Only approve what's truly needed.`
      });
      const round1OpenAI = await _callAI("openai", openaiHistory);
      openaiHistory.push({ role: "assistant", content: round1OpenAI });
      send("openai", round1OpenAI);

      // Check if there are disagreements — keyword presence in AI's structured verdict output
      const openAILower = round1OpenAI.toLowerCase();
      let hasDisagreement = openAILower.includes("reject") || openAILower.includes("modify");
      let roundCount = 1;
      let lastClaudeResponse = round1Claude;
      let lastOpenAIResponse = round1OpenAI;

      // ── Rounds 2-5: Continue debating until consensus or max rounds ──
      while (hasDisagreement && roundCount < MAX_ROUNDS) {
        roundCount++;

        // Claude responds to OpenAI's review
        send("status", `Round ${roundCount}/5: Claude responding to OpenAI's feedback...`);
        claudeHistory.push({
          role: "user",
          content: `OpenAI reviewed your fixes:\n${lastOpenAIResponse}\n\nRespond to their feedback:\n- For APPROVED fixes: keep them exactly as-is.\n- For REJECTED fixes: either accept the rejection (drop the fix) or argue why it's needed with a better justification. Be honest — if they're right, drop it.\n- For MODIFIED fixes: accept their version if it's better, or counter-propose with reasoning.\n\nOutput your UPDATED fix list as JSON: [{"file":"...","old":"...","new":"...","reason":"...","status":"kept|revised|dropped","confidence":"high|medium|low"}]\n\nYou MUST converge toward agreement. Do not stubbornly keep rejected fixes unless you have a strong technical reason.`
        });
        lastClaudeResponse = await _callAI("anthropic", claudeHistory);
        claudeHistory.push({ role: "assistant", content: lastClaudeResponse });
        send("claude", lastClaudeResponse);

        // OpenAI reviews again
        send("status", `Round ${roundCount}/5: OpenAI reviewing Claude's revised proposals...`);
        openaiHistory.push({
          role: "user",
          content: `Claude revised the fixes based on your feedback:\n${lastClaudeResponse}\n\nReview again. Same rules:\n- APPROVE fixes that are now correct and minimal\n- REJECT fixes that are still wrong or unnecessary\n- MODIFY if close but needs tweaking\n\nJSON: [{"index":0,"verdict":"APPROVE|REJECT|MODIFY","reason":"...","modified_old":"if MODIFY","modified_new":"if MODIFY"}]\n\n${roundCount >= MAX_ROUNDS - 1 ? "IMPORTANT: This is the final round. You MUST reach a definitive verdict on every fix — no more MODIFY, only APPROVE or REJECT." : "Try to converge. If a fix has been debated for 2+ rounds without agreement, lean toward REJECT to keep things safe."}`
        });
        lastOpenAIResponse = await _callAI("openai", openaiHistory);
        openaiHistory.push({ role: "assistant", content: lastOpenAIResponse });
        send("openai", lastOpenAIResponse);

        // Check if still disagreeing
        hasDisagreement = lastOpenAIResponse.toLowerCase().includes("modify");
        // On final round, force conclusion regardless
        if (roundCount >= MAX_ROUNDS) hasDisagreement = false;
      }

      // ── Final consensus: Claude produces the definitive changeset ──
      send("status", `Finalizing consensus after ${roundCount} round${roundCount > 1 ? "s" : ""}...`);
      claudeHistory.push({
        role: "user",
        content: `Final OpenAI verdict:\n${lastOpenAIResponse}\n\nProduce the FINAL changeset. STRICT RULES:\n- Include ONLY fixes with APPROVE verdict.\n- For any remaining MODIFY: use OpenAI's version.\n- EXCLUDE all REJECTED fixes completely.\n- Output ONLY valid JSON array: [{"file":"...","old":"exact old string from source","new":"exact new string","reason":"..."}]\n- If nothing survived, return []\n- The "old" field MUST be an exact substring from the source code that can be found with string.includes().\n- Double-check every "old" string against the source code provided above.`
      });
      const finalConsensus = await _callAI("anthropic", claudeHistory);
      send("consensus", finalConsensus);

      // Parse
      let changes = [];
      try {
        const jsonMatch = finalConsensus.match(/\[[\s\S]*?\]/);
        if (jsonMatch) changes = JSON.parse(jsonMatch[0]);
        // Validate: filter out changes where old string doesn't exist in source
        changes = changes.filter(c => {
          const content = fileContents[c.file];
          return content && content.includes(c.old);
        });
      } catch {}

      send("result", { changes, roundCount, totalTurns: roundCount * 2 });
      send("done", null);
    } catch (e) {
      send("error", e.message);
    }
    res.end();
    return;
  }

  // ── Apply AI-debated fixes ──
  if (url.pathname === "/api/ai-apply-fix" && req.method === "POST") {
    const body = await readBody(req);
    const { changes } = safeJsonParse(body) || {};
    if (!changes || !changes.length) { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"No changes"})); return; }

    const results = [];
    for (const c of changes) {
      try {
        const filePath = path.join(CWD, c.file);
        let content = fs.readFileSync(filePath, "utf8");
        if (!content.includes(c.old)) { results.push({ file: c.file, ok: false, error: "old string not found" }); continue; }
        content = content.replace(c.old, c.new);
        fs.writeFileSync(filePath, content, "utf8");
        results.push({ file: c.file, ok: true, reason: c.reason });
      } catch (e) { results.push({ file: c.file, ok: false, error: e.message }); }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
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
    const scope = url.searchParams?.get("scope") || "workspace";
    const configPath = scope === "user"
      ? path.join(require("os").homedir(), ".open-seed", "config.json")
      : path.join(CWD, ".agent", "config.json");
    try {
      const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}";
      // For workspace scope, merge user (global) defaults underneath
      if (scope === "workspace") {
        const userPath = path.join(require("os").homedir(), ".open-seed", "config.json");
        const userCfg = fs.existsSync(userPath) ? safeJsonParse(fs.readFileSync(userPath, "utf8")) || {} : {};
        const wsCfg = safeJsonParse(content) || {};
        // workspace overrides user — shallow merge per top-level key
        const merged = { ...userCfg };
        for (const [k, v] of Object.entries(wsCfg)) {
          if (v && typeof v === "object" && !Array.isArray(v) && merged[k] && typeof merged[k] === "object") {
            merged[k] = { ...merged[k], ...v };
          } else {
            merged[k] = v;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(merged));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(content);
      }
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
    const scope = url.searchParams?.get("scope") || "workspace";
    const configPath = scope === "user"
      ? path.join(require("os").homedir(), ".open-seed", "config.json")
      : path.join(CWD, ".agent", "config.json");
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
