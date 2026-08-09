const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Core functionality
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
  
  // Game session tracking
  onGameSessionEnded: (callback) => ipcRenderer.on('game-session-ended', (event, data) => callback(data)),
  
  // App version and updates
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
  
  // Update prompts
  promptUpdate: (callback) => ipcRenderer.on('update-prompt', (event, data) => callback(data)),
  respondUpdate: (action) => ipcRenderer.send('update-response', action),
  
  // Quit confirmation
  promptQuitConfirm: (callback) => ipcRenderer.on('quit-confirm-request', () => callback()),
  respondQuitConfirm: (confirmed) => ipcRenderer.send('quit-confirm-response', confirmed),

  // ---------- Download Manager ----------
  downloadsGetAll: () => ipcRenderer.invoke('downloads-get-all'),
  downloadsGetDefaultDir: () => ipcRenderer.invoke('downloads-get-default-dir'),
  downloadsAddHttp: (opts) => ipcRenderer.invoke('downloads-add-http', opts),
  downloadsAddTorrent: (opts) => ipcRenderer.invoke('downloads-add-torrent', opts),
  downloadsScanPage: (url) => ipcRenderer.invoke('downloads-scan-page', url),
  downloadsSearchSources: (query) => ipcRenderer.invoke('downloads-search-sources', query),
  downloadsFetchDownloadLink: (pageUrl) => ipcRenderer.invoke('downloads-fetch-download-link', pageUrl),
  downloadsPause: (id) => ipcRenderer.invoke('downloads-pause', id),
  downloadsResume: (id) => ipcRenderer.invoke('downloads-resume', id),
  downloadsCancel: (id) => ipcRenderer.invoke('downloads-cancel', id),
  downloadsRemove: (id) => ipcRenderer.invoke('downloads-remove', id),
  downloadsOpenFolder: (folderPath) => ipcRenderer.invoke('downloads-open-folder', folderPath),
  onDownloadsUpdated: (callback) => ipcRenderer.on('downloads-updated', (event, data) => callback(data)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data))
});