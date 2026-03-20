const path = require("path");
const { app, BrowserWindow, shell, Menu, dialog } = require("electron");

const cliArgs = process.argv.slice(2);
const CWD = cliArgs.find((a, i) => cliArgs[i - 1] === "--cwd") || process.cwd();
const PORT = parseInt(cliArgs.find((a, i) => cliArgs[i - 1] === "--port") || "4040", 10);

let mainWindow, serverProcess;

function startServer(cwd) {
  const { spawn } = require("child_process");
  const serverJs = path.join(__dirname, "server.js");
  serverProcess = spawn(process.execPath, [serverJs, "--port", String(PORT), "--cwd", cwd || CWD], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }
  });
  serverProcess.stdout?.on("data", d => {
    if (d.toString().includes("http://localhost") && !mainWindow) createWindow();
  });
  setTimeout(() => { if (!mainWindow) createWindow(); }, 3000);
}

function createWindow() {
  if (mainWindow) { mainWindow.loadURL("http://localhost:" + PORT); return; }
  const m = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: "Open Seed", titleBarStyle: m ? "hiddenInset" : "default",
    trafficLightPosition: m ? { x: 12, y: 10 } : undefined,
    backgroundColor: "#0d1117",
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    show: false
  });
  mainWindow.loadURL("http://localhost:" + PORT);
  mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.includes("localhost")) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.on("did-finish-load", () => { mainWindow.setTitle("Open Seed | " + CWD); });
}

const m = process.platform === "darwin";
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(m ? [{ label: "Open Seed", submenu: [{ role: "about" },{ type: "separator" },{ role: "hide" },{ role: "hideOthers" },{ type: "separator" },{ role: "quit" }] }] : []),
  { label: "File", submenu: [{ label: "Save", accelerator: "CmdOrCtrl+S", click: () => mainWindow?.webContents.executeJavaScript("saveActive()") },{ type: "separator" },...(m ? [] : [{ role: "quit" }])] },
  { label: "Edit", submenu: [{ role: "undo" },{ role: "redo" },{ type: "separator" },{ role: "cut" },{ role: "copy" },{ role: "paste" },{ role: "selectAll" }] },
  { label: "View", submenu: [
    { label: "Explorer", accelerator: "CmdOrCtrl+Shift+E", click: () => mainWindow?.webContents.executeJavaScript("nav('files')") },
    { label: "AI Chat", accelerator: "CmdOrCtrl+Shift+A", click: () => mainWindow?.webContents.executeJavaScript("nav('chat')") },
    { label: "AGI Mode", accelerator: "CmdOrCtrl+Shift+G", click: () => mainWindow?.webContents.executeJavaScript("nav('agi')") },
    { label: "Terminal", accelerator: "CmdOrCtrl+J", click: () => mainWindow?.webContents.executeJavaScript("toggleTerm()") },
    { type: "separator" },{ role: "reload" },{ role: "toggleDevTools" },{ type: "separator" },{ role: "togglefullscreen" }
  ]},
  { label: "Window", submenu: [{ role: "minimize" },{ role: "zoom" },...(m ? [{ type: "separator" },{ role: "front" }] : [{ role: "close" }])] },
  { label: "Help", submenu: [{ label: "GitHub", click: () => shell.openExternal("https://github.com/sueun-dev/open-seed") }] }
]));

app.setName("Open Seed");
app.whenReady().then(() => { startServer(); app.on("activate", () => { if (!mainWindow) createWindow(); }); });
app.on("window-all-closed", () => { if (!m) app.quit(); });
app.on("before-quit", () => { if (serverProcess) serverProcess.kill("SIGTERM"); });
