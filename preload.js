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
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data))
});