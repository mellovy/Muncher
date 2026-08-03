const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath),
  pickExe: (defaultPath) => ipcRenderer.invoke('pick-exe', defaultPath),
  scanExes: (folderPath) => ipcRenderer.invoke('scan-exes', folderPath),
  scanSteamGames: () => ipcRenderer.invoke('scan-steam-games'),
  launchGame: (exePath) => ipcRenderer.invoke('launch-game', exePath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  fetchGameBanner: (gameName) => ipcRenderer.invoke('fetch-game-banner', gameName),
  fetchGameHeader: (gameName) => ipcRenderer.invoke('fetch-game-header', gameName),
  fetchImageData: (url) => ipcRenderer.invoke('fetch-image-data', url),
  checkPaths: (exePaths) => ipcRenderer.invoke('check-paths', exePaths),
  onGameSessionEnded: (callback) => ipcRenderer.on('game-session-ended', (event, data) => callback(data)),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
  // Themed update prompts: main.js sends the state to show, renderer shows
  // its own in-app modal (instead of a native OS dialog) and reports the
  // user's choice back over 'update-response'.
  promptUpdate: (callback) => ipcRenderer.on('update-prompt', (event, data) => callback(data)),
  respondUpdate: (action) => ipcRenderer.send('update-response', action),
  // Same pattern for the "quit while a game session is tracking" confirmation.
  promptQuitConfirm: (callback) => ipcRenderer.on('quit-confirm-request', () => callback()),
  respondQuitConfirm: (confirmed) => ipcRenderer.send('quit-confirm-response', confirmed)
});