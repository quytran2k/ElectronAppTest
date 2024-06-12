const { contextBridge, ipcRenderer } = require("electron");

// Use Electron's contextBridge to expose a secure API to the renderer process
contextBridge.exposeInMainWorld("api", {
  // Function to trigger the file selection dialog in the main process
  selectFile: () => ipcRenderer.invoke("select-file"),

  // Function to request the main process to convert a selected video file
  convertFile: (filePath, totalDuration) =>
    ipcRenderer.invoke("convert-file", filePath, totalDuration),
  // Function to listen for messages from the main process on a specific channel
  receive: (channel, func) => {
    // Register a listener for the channel, forwarding any received arguments
    // to the provided callback function
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },

  // Function get file path optimized a video
  getOptimizedVideo: () => ipcRenderer.invoke("get-optimized-video"),

  // Function get temp local
  getTempLocal: () => ipcRenderer.invoke("get-temp-local"),

  // Function to remove all listeners from a specific channel
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
