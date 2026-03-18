const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent40", {
  run: (params) => ipcRenderer.invoke("agent:run", params),
  doctor: () => ipcRenderer.invoke("agent:doctor"),
  checkComments: () => ipcRenderer.invoke("agent:check-comments"),
  getTheme: () => ipcRenderer.invoke("theme:get"),
  onStream: (callback) => {
    ipcRenderer.on("agent:stream", (event, data) => callback(data));
  }
});
