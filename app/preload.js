const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openseed", {
  // Platform info
  platform: process.platform,
  isElectron: true,

  // Window controls
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),

  // Dialog
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),

  // App info
  version: "0.1.0",
  name: "Open Seed"
});
