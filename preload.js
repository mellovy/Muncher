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
  getFolderSizes: (folderPaths) => ipcRenderer.invoke('get-folder-sizes', folderPaths),
  getCaptureSources: () => ipcRenderer.invoke('get-capture-sources'),
  saveClip: (gameName, arrayBuffers, clipsDir) => ipcRenderer.invoke('save-clip', gameName, arrayBuffers, clipsDir),
  // Instant Replay v2 — main-process ffmpeg/gdigrab capture (see main.js).
  startInstantReplayCapture: (maxSeconds, exePath) => ipcRenderer.invoke('start-instant-replay', maxSeconds, exePath),
  stopInstantReplayCapture: () => ipcRenderer.invoke('stop-instant-replay'),
  saveInstantReplayClip: (gameName, clipsDir, seconds, audioBuffers) => ipcRenderer.invoke('save-instant-replay-clip', gameName, clipsDir, seconds, audioBuffers),
  showOverlayToast: (payload) => ipcRenderer.send('show-overlay-toast', payload),
  openClipsFolder: (gameName, clipsDir) => ipcRenderer.invoke('open-clips-folder', gameName, clipsDir),
  getDefaultClipsDir: () => ipcRenderer.invoke('get-default-clips-dir'),
  onToggleClipRecording: (callback) => ipcRenderer.on('toggle-clip-recording', () => callback()),
  onClipHotkeyUnavailable: (callback) => ipcRenderer.on('clip-hotkey-unavailable', () => callback()),
  setClipHotkey: (accelerator) => ipcRenderer.invoke('set-clip-hotkey', accelerator),
  deleteGameFolder: (exePath, folderPath) => ipcRenderer.invoke('delete-game-folder', exePath, folderPath),
  
  // Game session tracking
  onGameSessionEnded: (callback) => ipcRenderer.on('game-session-ended', (event, data) => callback(data)),
  onGameLaunchConfirmed: (callback) => ipcRenderer.on('game-launch-confirmed', (event, data) => callback(data)),
  
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

  // Clip gallery functions
  playClip: (filePath) => ipcRenderer.invoke('play-clip', filePath),
  deleteClip: (filePath) => ipcRenderer.invoke('delete-clip', filePath),

  // Library backup
  exportLibraryData: (jsonString) => ipcRenderer.invoke('export-library-data', jsonString),
  importLibraryData: () => ipcRenderer.invoke('import-library-data')
});