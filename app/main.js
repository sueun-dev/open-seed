/**
 * Open Seed — Electron Desktop App
 *
 * Runs the web server internally and opens a native window.
 * Usage: npx electron app/
 *   or:  cd app && npm run electron
 */

const path = require("path");
const { fork } = require("child_process");

// Parse CLI args
const args = process.argv.slice(2);
const CWD = args.find((a, i) => args[i - 1] === "--cwd") || process.cwd();
const PORT = parseInt(args.find((a, i) => args[i - 1] === "--port") || "4040", 10);

let app, BrowserWindow, shell, globalShortcut;
try {
  const electron = require("electron");
  if (typeof electron === "string" || !electron.app) {
    // Not running as Electron main process — launch ourselves properly
    const electronPath = typeof electron === "string" ? electron : require("electron/index.js");
    if (typeof electronPath === "string") {
      const { execSync } = require("child_process");
      const args = process.argv.slice(2).map(a => `"${a}"`).join(" ");
      try {
        execSync(`"${electronPath}" "${__dirname}" ${args}`, { stdio: "inherit" });
      } catch {}
      process.exit(0);
    }
    console.error("Cannot start Electron. Use web mode: node app/server.js");
    process.exit(1);
  }
  ({ app, BrowserWindow, shell, globalShortcut } = electron);
} catch (e) {
  console.error("Electron error:", e.message);
  console.error("Use web mode instead: node app/server.js");
  process.exit(1);
}

let mainWindow;
let serverProcess;

// Start the web server as a child process
function startServer() {
  const serverPath = path.join(__dirname, "server.js");
  const { spawn: cpSpawn } = require("child_process");

  // Use spawn (not fork) for better compatibility with Electron's node
  serverProcess = cpSpawn(process.execPath, [serverPath, "--port", String(PORT), "--cwd", CWD], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });

  serverProcess.stdout?.on("data", (data) => {
    const text = data.toString();
    console.log("[server]", text.trim());
    if (text.includes("http://localhost")) {
      createWindow();
    }
  });

  serverProcess.stderr?.on("data", (data) => {
    console.error("[server]", data.toString().trim());
  });

  serverProcess.on("exit", (code) => {
    if (code !== 0) console.error(`Server exited with code ${code}`);
  });

  // Fallback: create window after 3 seconds
  setTimeout(() => {
    if (!mainWindow) createWindow();
  }, 3000);
}

function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Open Seed",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: "#0a0a0a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();

  // Register global shortcuts
  globalShortcut.register("CommandOrControl+Shift+A", () => {
    mainWindow?.webContents.executeJavaScript("nav('chat')");
  });

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Kill server process
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
  }
});
