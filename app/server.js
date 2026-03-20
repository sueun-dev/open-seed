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
const CWD = args.find((a, i) => args[i - 1] === "--cwd") || process.cwd();
const APP_DIR = __dirname;
const PROJECT_DIR = path.join(APP_DIR, "..");

function safePath(userPath) {
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
    const { task, mode, projectDir } = safeJsonParse(body) || {};

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

    const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
    const child = spawn("node", [agentCli, mode || "run", task], {
      cwd: childCwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

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
    });

    child.on("error", (err) => {
      sendEvent("error", { message: err.message });
      res.write("data: [DONE]\n\n");
      res.end();
    });

    req.on("close", () => {
      child.kill("SIGTERM");
    });

    return;
  }

  // ── Question mode: direct LLM call without pipeline ──
  if (url.pathname === "/api/ask" && req.method === "POST") {
    const body = await readBody(req);
    const { question } = safeJsonParse(body) || {};

    // Gather minimal context
    const repoFiles = [];
    try {
      const walk = (dir, depth = 0) => {
        if (depth > 2) return;
        const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if ([".git", "node_modules", "dist", ".agent", "coverage"].includes(e.name)) continue;
          const rel = require("node:path").relative(CWD, require("node:path").join(dir, e.name));
          if (e.isDirectory()) walk(require("node:path").join(dir, e.name), depth + 1);
          else repoFiles.push(rel);
        }
      };
      walk(CWD);
    } catch {}

    // Build a simple prompt with context
    const contextLines = [
      `Project files: ${repoFiles.slice(0, 30).join(", ")}`,
      `Working directory: ${CWD}`,
    ];

    // Read recent session info
    try {
      const sessDir = require("node:path").join(CWD, ".agent", "sessions");
      const sessions = require("node:fs").readdirSync(sessDir).filter(f => f.endsWith(".json")).sort().slice(-3);
      for (const s of sessions) {
        const data = JSON.parse(require("node:fs").readFileSync(require("node:path").join(sessDir, s), "utf8"));
        contextLines.push(`Recent session: ${data.task || "unknown"} → ${data.status || "unknown"}`);
      }
    } catch {}

    const systemPrompt = "You are agent40, an AGI coding agent. Answer the user's question based on the project context below. Be concise and helpful. If they ask about files, tell them the exact paths.\n\nContext:\n" + contextLines.join("\n");

    // Call the LLM via the agent CLI infrastructure
    const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");

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

    // Read relevant files for context
    const fileContents = [];
    for (const f of repoFiles.slice(0, 5)) {
      try {
        const content = require("node:fs").readFileSync(require("node:path").join(CWD, f), "utf8");
        if (content.length < 3000) {
          fileContents.push(`--- ${f} ---\n${content}`);
        }
      } catch {}
    }

    const fullPrompt = `${systemPrompt}\n\nFile contents:\n${fileContents.join("\n\n")}\n\nUser question: ${question}`;

    // Use node to call the provider
    const child = spawn("node", ["-e", `
      const { ProviderRegistry } = require("${PROJECT_DIR}/dist/providers/registry.js");
      const { loadConfig } = require("${PROJECT_DIR}/dist/core/config.js");
      (async () => {
        const config = await loadConfig("${CWD.replace(/"/g, '\\"')}");
        const registry = new ProviderRegistry();
        const resp = await registry.invokeWithFailover(config, "openai", {
          role: "researcher",
          category: "research",
          systemPrompt: ${JSON.stringify(systemPrompt)},
          prompt: ${JSON.stringify(question + "\n\nProject files: " + repoFiles.slice(0, 20).join(", ") + "\n\n" + fileContents.join("\n\n"))},
          responseFormat: "text"
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
    const { task, projectDir } = safeJsonParse(body) || {};
    if (!task) { res.writeHead(400); res.end("Missing task"); return; }

    // Workspace setup
    const projName = projectDir || "agi-" + Date.now().toString(36);
    const workspaceRoot = path.join(CWD, "workspace");
    const childCwd = path.join(workspaceRoot, projName);
    if (!fs.existsSync(childCwd)) fs.mkdirSync(childCwd, { recursive: true });

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
    const isFullApp = /full.*app|complete.*project|entire.*system|from.*scratch/i.test(task);
    const isSimple = /fix.*bug|rename|add.*comment|update.*version|change.*color/i.test(task);
    const needsDebate = /architect|design|pattern|approach|strategy|tradeoff|choose|select|compare|migrate/i.test(task);
    let complexity = "moderate";
    if (isSimple && words < 20) complexity = "simple";
    else if (isFullApp || words > 100) complexity = "massive";
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

    // Always: build
    steps.push({ id: mkId("build"), type: "build", title: "Build & Implement", mode: "team", maxTurns: 200, maxRetries: 2, useStrategyBranching: true });

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

    // Shared context — passed between steps
    const ctx = {
      task,
      projectDir: projName,
      stepResults: [],
      allFiles: [],
      errorLog: [],
      decisions: [],
      totalTokens: 0,
    };

    // Build step prompt with full inter-step memory
    function buildStepPrompt(step) {
      const sections = [];
      sections.push(`# AGI Pipeline — ${step.title}`);
      sections.push(`## Original Task\n${task}`);

      // Inter-step memory: all prior results
      if (ctx.stepResults.length > 0) {
        sections.push(`## Prior Step Results (${ctx.stepResults.length} completed)`);
        for (const r of ctx.stepResults) {
          const icon = r.status === "completed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP";
          sections.push(`### [${icon}] ${r.type.toUpperCase()}\n${(r.summary || "").slice(0, 2000)}`);
          if (r.changes && r.changes.length) sections.push(`Files: ${r.changes.join(", ")}`);
          if (r.errors && r.errors.length) sections.push(`Errors: ${r.errors.join("; ")}`);
        }
      }

      if (ctx.decisions.length) sections.push(`## Architecture Decisions\n${ctx.decisions.map((d,i) => `${i+1}. ${d}`).join("\n")}`);
      if (ctx.allFiles.length) sections.push(`## Project Files\n${ctx.allFiles.map(f => `- ${f}`).join("\n")}`);

      const unresolved = ctx.errorLog.filter(e => !e.resolved);
      if (unresolved.length) sections.push(`## Unresolved Errors\n${unresolved.map(e => `- [${e.category}] ${e.error}`).join("\n")}`);

      // Step-type instructions
      sections.push(`## Your Task: ${step.title}`);
      sections.push(getStepInstructions(step.type));

      // Scaffold for new projects
      if (ctx.allFiles.length === 0 && (step.type === "build" || step.type === "design")) {
        sections.push(`\nCRITICAL PROJECT STRUCTURE RULES:\n- STANDALONE project in workspace/${projName}/\n- MUST create: package.json (with "start" script), src/, tests/\n- Write EVERY file with COMPLETE content. No placeholders.\n- Runnable with: npm install && npm start`);
      }

      return sections.join("\n\n");
    }

    function getStepInstructions(type) {
      const m = {
        analyze: "Perform deep analysis: intent, requirements, risks, technology choices, complexity estimate.",
        debate: "Multi-agent design debate. Present architecture positions with reasoning, risks, alternatives.",
        design: "Detailed implementation plan: file structure, architecture, API design, component breakdown, data model.",
        build: "IMPLEMENT EVERYTHING. Write ALL files with COMPLETE content. NO placeholders. Use write tool for every file. DO NOT STOP until done.",
        verify: "Run ALL checks: type-check, lint, tests, build. Report ALL errors with file paths and line numbers. Do NOT fix — just report.",
        fix: "Fix ALL reported errors. Read each file, find root cause, apply minimal fix, verify the fix.",
        improve: "Security audit, performance optimization, add missing tests, documentation. Only improve what exists.",
        review: "Final quality review: correctness, completeness, security, performance, code quality, testing. Verdict: pass or fail.",
      };
      return m[type] || "";
    }

    // Execute one step via the engine CLI
    async function executeStep(prompt, mode, maxTurns) {
      return new Promise((resolve, reject) => {
        if (aborted) { reject(new Error("Aborted")); return; }
        const agentCli = path.join(PROJECT_DIR, "dist", "cli.js");
        const child = spawn("node", [agentCli, mode || "run", prompt], {
          cwd: childCwd,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "", stderr = "";
        let summary = "", changes = [], errors = [], toolResults = [];

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
                if (c) sendAgi("llm", { text: typeof c === "string" ? c : "" });
                continue;
              }
              // Tool streaming output (bash stdout/stderr) → forward for real-time visibility
              if (parsed.eventType === "tool.stream") {
                const streamChunk = parsed.payload?.chunk || "";
                if (streamChunk) sendAgi("stdout", { text: typeof streamChunk === "string" ? streamChunk.slice(0, 500) : "" });
                continue;
              }
              // Provider retry → show as warning
              if (parsed.eventType === "provider.retry") {
                sendAgi("event", parsed);
                continue;
              }
              // Everything else: forward with full payload
              sendAgi("event", parsed);
              // Track tool results
              if (parsed.eventType === "tool.completed") {
                const ok = parsed.payload?.ok !== false;
                const name = parsed.payload?.tool || "unknown";
                toolResults.push({ name, ok, output: (parsed.payload?.output?.path || "").toString().slice(0, 200) });
                if (ok && name === "write" && parsed.payload?.output?.path) {
                  changes.push("created " + parsed.payload.output.path);
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
          sendAgi("stderr", { text: text.slice(0, 500) });
        });

        child.on("close", (code) => {
          // Extract summary from stdout
          summary = stdout.slice(-3000);
          if (code !== 0) errors.push(`Exit code ${code}`);

          // Detect errors in output
          const errorPatterns = [/error/i, /failed/i, /TypeError/i, /SyntaxError/i, /FAIL/i];
          for (const line of stderr.split("\n")) {
            for (const p of errorPatterns) {
              if (p.test(line)) { errors.push(line.trim().slice(0, 200)); break; }
            }
          }

          resolve({ summary, changes, toolResults, tokensUsed: 0, errors, rawOutput: stdout.slice(-5000) });
        });

        child.on("error", (err) => { reject(err); });

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
      const prompt = buildStepPrompt(step);

      sendAgi("agi.step.start", { stepId: step.id, stepType: step.type, stepTitle: step.title, stepIndex: stepIdx, totalSteps: steps.length, completedSteps: ctx.stepResults.filter(r => r.status === "completed").length });

      let result = null;
      let attempts = 0;
      const maxRetries = step.maxRetries || 0;

      while (attempts <= maxRetries) {
        attempts++;
        const start = Date.now();
        try {
          const retryPrompt = attempts > 1
            ? `${prompt}\n\n[RETRY ${attempts}/${maxRetries+1}] Previous attempt failed. Try a different approach.\nErrors: ${result?.errors?.join("; ") || "unknown"}`
            : prompt;

          const output = await executeStep(retryPrompt, step.mode, step.maxTurns);

          result = {
            stepId: step.id,
            type: step.type,
            status: (output.errors.length === 0 || step.type === "verify") ? "completed" : "failed",
            summary: output.summary,
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

        // Extract decisions
        if ((step.type === "analyze" || step.type === "design") && result.status === "completed") {
          const dm = (result.summary || "").match(/(?:decision|chose|selected|will use|architecture):\s*([^\n]+)/gi);
          if (dm) ctx.decisions.push(...dm.map(d => d.slice(0, 200)));
        }

        const evtType = result.status === "completed" ? "agi.step.complete" : "agi.step.fail";
        sendAgi(evtType, {
          stepId: step.id, stepType: step.type, stepTitle: step.title,
          status: result.status, summary: (result.summary || "").slice(0, 500),
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

    // Pipeline complete
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
        const file = line.slice(3);
        let s = "untracked";
        if (code.includes("M")) s = "modified";
        else if (code.includes("A")) s = "added";
        else if (code.includes("D")) s = "deleted";
        else if (code.includes("R")) s = "renamed";
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
          if (e.isDirectory()) { files.push({ path: rel, type: "dir" }); walk(full, depth + 1); }
          else files.push({ path: rel, type: "file" });
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
      const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter(f => f.endsWith(".json")).sort().reverse().slice(0, 50) : [];
      const sessions = [];
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf8"));
          sessions.push({ id: data.id || f.replace(".json", ""), task: data.task || "", status: data.status || "unknown", createdAt: data.createdAt || "", phase: data.phase || "" });
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
    const child = spawn("node", [agentCli, "soak", "--providers", provider, "--rounds", "1"], {
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
    const child = spawn("node", [agentCli, ...args], {
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
  console.log(`  ║  cwd: ${CWD.slice(-28).padEnd(28)}║`);
  console.log(`  ╚══════════════════════════════════╝\n`);

  // Only auto-open browser if NOT launched from desktop app
  if (!process.env.OPENSEED_DESKTOP) {
    const openCmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    spawn(openCmd, [`http://localhost:${PORT}`], { stdio: "ignore", detached: true }).unref();
  }
});
