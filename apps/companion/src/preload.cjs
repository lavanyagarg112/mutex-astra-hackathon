const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relaycode", {
  state: () => ipcRenderer.invoke("companion:state"),
  configure: (input) => ipcRenderer.invoke("companion:configure", input),
  browserLogin: (server) => ipcRenderer.invoke("companion:browser-login", server),
  claim: (server, code) => ipcRenderer.invoke("companion:claim", server, code),
  map: (project) => ipcRenderer.invoke("companion:map", project),
  clone: (project) => ipcRenderer.invoke("companion:clone", project),
  refresh: () => ipcRenderer.invoke("companion:refresh"),
  onStatus: (listener) => ipcRenderer.on("companion:status", (_event, status) => listener(status)),
  onPaired: (listener) => ipcRenderer.on("companion:paired", listener),
});
