/**
 * Open Seed | Desktop App Entry Point
 *
 * Detects environment:
 * - Electron: opens native window with embedded web server
 * - Node.js: starts web server only (http://localhost:4040)
 *
 * Usage:
 *   Desktop: cd app && npx electron .
 *   Web:     node app/main.js
 */

const path = require("path");

// ── Parse CLI args ──
const cliArgs = process.argv.slice(2);
const CWD = cliArgs.find((a, i) => cliArgs[i - 1] === "--cwd") || process.cwd();
const PORT = parseInt(cliArgs.find((a, i) => cliArgs[i - 1] === "--port") || "4040", 10);

// ── Detect Electron ──
const IS_ELECTRON = Boolean(process.versions.electron);

if (!IS_ELECTRON) {
  // Running under plain Node.js — start web server only
  require("./server.js");
  // Early return from module scope
  return;
}

// ── Electron Main Process ──
// Workaround: node_modules/electron/index.js returns the binary path (a string),
// which shadows the built-in "electron" module. Temporarily override the resolver
// so that require("electron") hits Electron's internal module, not the npm package.
const Module = require("module");
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === "electron") {
    // Return a sentinel that Electron's own loader can intercept.
    // This prevents node_modules/electron/index.js from being loaded.
    try {
      return _origResolve.call(this, request, parent, isMain, options);
    } catch {
      return request; // Let Electron handle it
    }
  }
  return _origResolve.call(this, request, parent, isMain, options);
};

// Try to load Electron APIs
let app, BrowserWindow, shell, globalShortcut, Menu, dialog;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object" && electron.app) {
    ({ app, BrowserWindow, shell, globalShortcut, Menu, dialog } = electron);
  }
} catch { /* fallback below */ }

// Restore original resolver
Module._resolveFilename = _origResolve;

if (!app) {
  // Electron APIs not available — fall back to web server
  console.log("[Open Seed] Electron APIs not available. Starting web server...");
  require("./server.js");
  return;
}

let mainWindow;
let serverProcess;

// ── App Menu ──
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: "Open Seed",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings", accelerator: "Cmd+,", click: () => mainWindow?.webContents.executeJavaScript("nav('settings')") },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New File", accelerator: "CmdOrCtrl+N", click: () => mainWindow?.webContents.executeJavaScript("promptNewFile()") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => mainWindow?.webContents.executeJavaScript("saveActive()") },
        { type: "separator" },
        { label: "Open Workspace...", accelerator: "CmdOrCtrl+O", click: openWorkspace },
        { type: "separator" },
        ...(isMac ? [] : [{ role: "quit" }])
      ]
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { label: "Explorer", accelerator: "CmdOrCtrl+Shift+E", click: () => mainWindow?.webContents.executeJavaScript("nav('files')") },
        { label: "AI Chat", accelerator: "CmdOrCtrl+Shift+A", click: () => mainWindow?.webContents.executeJavaScript("nav('chat')") },
        { label: "AGI Mode", accelerator: "CmdOrCtrl+Shift+G", click: () => mainWindow?.webContents.executeJavaScript("nav('agi')") },
        { label: "Terminal", accelerator: "CmdOrCtrl+J", click: () => mainWindow?.webContents.executeJavaScript("toggleTerm()") },
        { type: "separator" },
        { role: "reload" }, { role: "toggleDevTools" },
        { type: "separator" },
        { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Agent",
      submenu: [
        { label: "Run Task...", accelerator: "CmdOrCtrl+Enter", click: () => mainWindow?.webContents.executeJavaScript("document.getElementById('chIn')?.focus()") },
        { label: "AGI Mode", accelerator: "CmdOrCtrl+Shift+G", click: () => mainWindow?.webContents.executeJavaScript("nav('agi')") },
        { type: "separator" },
        { label: "Doctor", click: () => mainWindow?.webContents.executeJavaScript("nav('doctor')") },
        { label: "Sessions", click: () => mainWindow?.webContents.executeJavaScript("nav('sessions')") },
      ]
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }])] },
    {
      label: "Help",
      submenu: [
        { label: "GitHub", click: () => shell.openExternal("https://github.com/sueun-dev/open-seed") },
        { type: "separator" },
        { label: "About", click: () => dialog.showMessageBox(mainWindow, { type: "info", title: "Open Seed", message: "Open Seed", detail: "Autonomous AGI Coding Engine\n49 subsystems | 40 neural roles | Prometheus Engine" }) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openWorkspace() {
  const result = dialog.showOpenDialogSync(mainWindow, { properties: ["openDirectory"], title: "Open Project" });
  if (result?.[0]) {
    if (serverProcess) serverProcess.kill("SIGTERM");
    setTimeout(() => startServer(result[0]), 500);
  }
}

function startServer(cwd) {
  const { spawn } = require("child_process");
  serverProcess = spawn(process.execPath, [path.join(__dirname, "server.js"), "--port", String(PORT), "--cwd", cwd || CWD], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });
  serverProcess.stdout?.on("data", (data) => {
    if (data.toString().includes("http://localhost") && !mainWindow) createWindow();
  });
  serverProcess.stderr?.on("data", () => {});
  serverProcess.on("exit", (code) => { if (code && code !== 0) console.error(`Server exited: ${code}`); });
  setTimeout(() => { if (!mainWindow) createWindow(); }, 3000);
}

function createWindow() {
  if (mainWindow) { mainWindow.loadURL(`http://localhost:${PORT}`); return; }
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: "Open Seed",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    backgroundColor: "#0d1117",
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    show: false
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.includes("localhost")) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.on("did-finish-load", () => { mainWindow.setTitle(`Open Seed | ${CWD}`); });
}

app.setName("Open Seed");
app.whenReady().then(() => {
  buildMenu();
  startServer();
  app.on("activate", () => { if (!mainWindow) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (serverProcess) serverProcess.kill("SIGTERM"); });
