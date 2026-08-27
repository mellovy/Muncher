const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut, desktopCapturer, screen } = electron;
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ffmpeg-static resolves to a path *inside* app.asar in a packaged build,
// which isn't spawnable — asarUnpack (see package.json build config) copies
// the binary out alongside the asar, so redirect the path there.
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

let autoUpdater = null;
let manualUpdateCheck = false;

// Muncher is a single-window utility — a second launch should just focus the
// existing window instead of spinning up a whole second Chromium renderer.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// No File/Edit/View menu is used anywhere in this app — removing it outright
// (rather than just hiding it via autoHideMenuBar) skips building it at all.
Menu.setApplicationMenu(null);

// Keeps the renderer's V8 heap ceiling modest — this is a game list, not a
// heavyweight app, and it stops idle memory from creeping up over a long
// session (e.g. sitting minimized for hours while a game runs).
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192');

// exePaths of spawned games we're currently tracking playtime for — used to
// warn before quitting so a session in progress doesn't lose its playtime.
const activeLaunches = new Set();
// Maps a launched game's exePath -> its child process PID, so instant replay
// can look up the actual game window (by title) instead of just grabbing
// the whole desktop. Cleared when the process exits.
const activeGamePids = new Map();
let forceQuit = false;

// ---- Game-bar-style overlay ----
// A separate transparent, click-through, always-on-top window spanning the
// primary display, used purely to show toasts *over* a running (possibly
// fullscreen) game — the launcher window itself is typically minimized or
// behind the game, so its own in-page toast never gets seen during play.
let overlayWin = null;
// The one true reference to the launcher window. Every hotkey/IPC handler
// used to grab "the window" via BrowserWindow.getAllWindows()[0], which
// silently breaks the moment a second window exists — and the overlay
// window below IS a second window, created lazily the first time any
// toast fires. Window ordering from getAllWindows() isn't something
// Electron guarantees stays stable once there's more than one, so relying
// on index [0] there was the actual cause of things like the clip hotkey
// appearing to "stop working after the first press" — the very first press
// (before any overlay toast had ever created overlayWin) targeted the
// right window by luck, and every call after that was a coin flip.
let mainWindow = null;

function createOverlay() {
  const display = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile('overlay.html');
  overlayWin.on('closed', () => { overlayWin = null; });
}

function showOverlayToast(payload) {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  if (!overlayWin.isVisible()) overlayWin.showInactive();
  overlayWin.webContents.send('overlay-toast', payload);
}

ipcMain.on('show-overlay-toast', (event, payload) => {
  showOverlayToast(payload);
});

function createWindow(){
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'muncher.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => win.show());
  win.setMenuBarVisibility(false);
  win.loadFile('launcher.html');

  // While minimized there's nothing to render, so occlusion-based throttling
  // (backgroundThrottling) already halts timers/rAF — this just also drops
  // the compositor's offscreen backing store instead of keeping it warm,
  // since a game launcher sitting minimized behind a running game shouldn't
  // be holding onto GPU/CPU it isn't using.
  win.on('minimize', () => {
    win.webContents.setBackgroundThrottling(true);
  });

  win.on('close', (e) => {
    if (forceQuit || activeLaunches.size === 0) return;
    e.preventDefault();
    askRenderer(win, 'quit-confirm-request', null, 'quit-confirm-response').then((confirmed) => {
      if (confirmed) {
        forceQuit = true;
        win.close();
      }
    });
  });
  return win;
}

// Sends a themed-prompt request to the renderer and resolves once the user
// makes a choice there — this is the async stand-in for the native
// dialog.showMessageBox()/showMessageBoxSync() calls we used to use, so every
// prompt renders as an in-app modal that matches the rest of the UI instead
// of an OS-native dialog.
function askRenderer(win, channel, payload, responseChannel) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(undefined);
    ipcMain.once(responseChannel, (event, data) => resolve(data));
    win.webContents.send(channel, payload);
  });
}

// GitHub release bodies come through as Markdown-ish HTML fragments (lists,
// headings) from the "generate release notes" feature — strip the tags down
// to something readable in a plain native dialog rather than showing raw markup.
function formatReleaseNotes(notes) {
  const clean = (s) => String(s)
    .replace(/<\/(li|p|h[1-6])>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!notes) return 'No changelog was provided for this release.';
  if (Array.isArray(notes)) {
    return notes.map(n => `${n.version || ''}\n${clean(n.note || '')}`).join('\n\n').trim();
  }
  return clean(notes) || 'No changelog was provided for this release.';
}

function setupAutoUpdater(autoUpdater, win) {
  // Handle case where autoUpdater is null (e.g., require failed)
  if (!autoUpdater) {
    console.error('[setupAutoUpdater] autoUpdater is null - electron-updater may have failed to load');
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-status', { status: 'error', message: 'Updater unavailable' });
    }
    return;
  }

  autoUpdater.on('update-available', async (info) => {
    manualUpdateCheck = false;
    const action = await askRenderer(win, 'update-prompt', {
      type: 'available',
      version: info.version,
      currentVersion: app.getVersion(),
      notes: formatReleaseNotes(info.releaseNotes)
    }, 'update-response');
    if (action === 'install') {
      win.webContents.send('update-status', { status: 'downloading', percent: 0 });
      autoUpdater.downloadUpdate().catch(() => {});
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-status', { status: 'downloading', percent: Math.round(progress.percent) });
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-status', { status: 'downloaded' });
    }
    const action = await askRenderer(win, 'update-prompt', {
      type: 'ready',
      version: info.version
    }, 'update-response');
    if (action === 'restart') {
      forceQuit = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('update-not-available', async () => {
    if (win && !win.isDestroyed()) win.webContents.send('update-status', { status: 'idle' });
    if (manualUpdateCheck) {
      await askRenderer(win, 'update-prompt', {
        type: 'none',
        currentVersion: app.getVersion()
      }, 'update-response');
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on('error', async (err) => {
    if (win && !win.isDestroyed()) win.webContents.send('update-status', { status: 'idle' });
    console.error('[autoUpdater]', err);
    if (manualUpdateCheck) {
      await askRenderer(win, 'update-prompt', {
        type: 'error',
        reason: (err && err.message) || String(err)
      }, 'update-response');
    }
    manualUpdateCheck = false;
  });
}

if (gotLock) {
  app.whenReady().then(() => {
    const mainWin = createWindow();
    // Initialize autoUpdater after the window is created to avoid timing issues.
    // NOTE: intentionally assigning the module-level `autoUpdater` (declared
    // with `let` near the top of the file) rather than declaring a new local
    // one — the manual 'check-for-updates' IPC handler and the packaged-build
    // auto-check below both reference that outer variable, so shadowing it
    // here left them permanently pointed at null.
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
      console.error('[app.whenready] Failed to load electron-updater:', e);
      autoUpdater = null;
    }
    if (autoUpdater) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      setupAutoUpdater(autoUpdater, mainWin);
    } else {
      console.warn('[app.whenready] Running without auto-updater functionality');
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('update-status', { status: 'error', message: 'Updater unavailable' });
      }
    }
    // Give the window a few seconds to finish loading before checking, and
    // only bother in packaged builds — there's no update feed (app-update.yml)
    // when running unpackaged via `npm start`.
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {});
      }, 4000);
    }
    // Toggle: brings the window to front if it's minimized/hidden/unfocused,
    // otherwise minimizes it back out of the way. Works globally, i.e. even
    // while a game has focus, since this is meant to sit backgrounded during play.
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      if (win.isVisible() && win.isFocused()) {
        win.minimize();
      } else {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });

    // Toggles clip recording for whatever game is currently marked as
    // playing in the renderer — works even while a game has focus, since
    // that's exactly when you'd want to clip something.
    //
    // NOTE on why this isn't globalShortcut/RegisterHotKey: that API relies
    // on Windows delivering a WM_HOTKEY message through the normal message
    // queue, and some games/anti-cheat swallow that message class entirely
    // while they have focus — no amount of re-registering fixes that, since
    // the message is never sent to anyone in the first place. Instead, poll
    // the actual hardware key state directly via GetAsyncKeyState (same
    // general approach tools like Discord/OBS use for in-game hotkeys) —
    // that bypasses the message queue a game could be intercepting.
    let currentClipAccelerator = 'CommandOrControl+Alt+C';
    let keyPollProc = null;
    let keyPollLastFire = 0;

    const CLIP_HOTKEY_VK = { 'C': 0x43, 'K': 0x4B, 'X': 0x58, 'F9': 0x78 };

    function parseAccelerator(accel){
      const parts = accel.split('+').map(p => p.trim());
      const mods = { ctrl: false, alt: false, shift: false };
      let key = null;
      for (const p of parts) {
        const low = p.toLowerCase();
        if (low === 'commandorcontrol' || low === 'ctrl' || low === 'control') mods.ctrl = true;
        else if (low === 'alt') mods.alt = true;
        else if (low === 'shift') mods.shift = true;
        else key = p.toUpperCase();
      }
      return { mods, key };
    }

    function buildKeyPollScript(accel){
      const { mods, key } = parseAccelerator(accel);
      const vk = CLIP_HOTKEY_VK[key];
      if (!vk) return null;
      const down = (code) => `((0x8000 -band [Native.Win32]::GetAsyncKeyState(${code})) -ne 0)`;
      const conds = [
        mods.ctrl ? down(0x11) : `(-not ${down(0x11)})`,
        mods.alt ? down(0x12) : `(-not ${down(0x12)})`,
        mods.shift ? down(0x10) : `(-not ${down(0x10)})`,
        down(vk)
      ];
      return [
        `Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);' -Name Win32 -Namespace Native`,
        `$down = $false`,
        `while ($true) {`,
        `  $match = ${conds.join(' -and ')}`,
        `  if ($match -and -not $down) { Write-Output 'HOTKEY_FIRED'; $down = $true }`,
        `  elseif (-not $match) { $down = $false }`,
        `  Start-Sleep -Milliseconds 40`,
        `}`
      ].join('\n');
    }

    function stopKeyPoll(){
      if (keyPollProc) {
        try { keyPollProc.kill(); } catch (e) {}
        keyPollProc = null;
      }
    }

    function startKeyPoll(accel){
      stopKeyPoll();
      const script = buildKeyPollScript(accel);
      if (!script) return false;
      try {
        keyPollProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true });
      } catch (e) {
        keyPollProc = null;
        return false;
      }
      let buf = '';
      keyPollProc.stdout?.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          if (line.trim() !== 'HOTKEY_FIRED') continue;
          const now = Date.now();
          // Debounce a held key firing the same edge signal twice in quick
          // succession, not consecutive genuine presses (those are always
          // well over 300ms apart in practice).
          if (now - keyPollLastFire < 300) continue;
          keyPollLastFire = now;
          const win = mainWindow;
          if (win && !win.isDestroyed()) win.webContents.send('toggle-clip-recording');
        }
      });
      keyPollProc.on('exit', () => { keyPollProc = null; });
      keyPollProc.on('error', () => { keyPollProc = null; });
      currentClipAccelerator = accel;
      return true;
    }

    const clipHotkeyOk = startKeyPoll(currentClipAccelerator);
    if (!clipHotkeyOk) {
      console.error(`[keyPoll] Could not start hotkey listener for ${currentClipAccelerator}`);
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.once('did-finish-load', () => win.webContents.send('clip-hotkey-unavailable'));
        if (!win.webContents.isLoading()) win.webContents.send('clip-hotkey-unavailable');
      }
    }

    ipcMain.handle('set-clip-hotkey', (event, accelerator) => {
      if (typeof accelerator !== 'string' || !accelerator.trim()) return { ok: false };
      // Ensure startKeyPoll is defined (should be, but adding safety check)
      if (typeof startKeyPoll !== 'function') {
        console.error('[set-clip-hotkey] startKeyPoll is not defined');
        return { ok: false };
      }
      const ok = startKeyPoll(accelerator);
      return { ok, accelerator: currentClipAccelerator };
    });

    app.on('will-quit', stopKeyPoll);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  replayStoppedIntentionally = true;
  clearTimeout(replayRestartTimer);
  clearInterval(replayCleanupInterval);
  if (replayProc) { try { replayProc.kill(); } catch (e) {} }
  if (replayBufferDir) cleanupReplayDir(replayBufferDir);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('get-app-version', () => app.getVersion());
;

ipcMain.handle('check-for-updates', async (event) => {
  if (!app.isPackaged) {
    return { ok: false, reason: 'Updates only work in the installed app, not `npm start`.' };
  }
  manualUpdateCheck = true;
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    manualUpdateCheck = false;
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('pick-folder', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('pick-exe', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    defaultPath: defaultPath || undefined,
    filters: [{ name: 'Executable', extensions: ['exe'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

const JUNK_EXE_PATTERNS = [
  /^unins/i, /uninstall/i, /crashpad/i, /crashhandler/i, /crash_report/i,
  /vcredist/i, /vc_redist/i, /dxsetup/i, /dotnetfx/i, /dotnet.*redist/i,
  /redist/i, /^setup\.exe$/i, /prereq/i, /easyanticheat/i, /^eac/i,
  /battleye/i, /^python/i, /^curl/i, /^7z/i, /directx/i, /^report/i,
  /helper\.exe$/i, /updater\.exe$/i, /update\.exe$/i
];

function isJunkExe(name){
  return JUNK_EXE_PATTERNS.some(p => p.test(name));
}

function normalizeName(s){
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findGameExeCandidates(topDir, topDirBaseName){
  const candidates = [];
  function walk(dir, depth){
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e){ return; }
    for (const entry of entries){
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()){
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')){
        candidates.push({ path: full, name: entry.name, depth });
      }
    }
  }
  walk(topDir, 0);
  if (candidates.length === 0) return null;

  const filtered = candidates.filter(c => !isJunkExe(c.name));
  const pool = filtered.length > 0 ? filtered : candidates;
  const folderNorm = normalizeName(topDirBaseName);

  let best = pool[0];
  let bestScore = -Infinity;
  for (const c of pool){
    const nameNorm = normalizeName(c.name.replace(/\.exe$/i, ''));
    let score = 0;
    if (nameNorm === folderNorm) score += 200;
    else if (folderNorm.includes(nameNorm) || nameNorm.includes(folderNorm)) score += 100;
    // Depth is a much weaker signal than it used to be — real executables are
    // routinely nested a folder or two down (e.g. GameName/GameName/Game.exe,
    // or Unreal's Binaries/Win64), so a small penalty keeps ties sane without
    // letting a shallow decoy beat the actual game exe further down.
    score -= c.depth * 3;
    try { score += fs.statSync(c.path).size / 1000000; } catch(e){}
    if (score > bestScore){ bestScore = score; best = c; }
  }
  return best.path;
}

const STEAM_NAME_DENYLIST = [
  /^steamworks common redistributables$/i,
  /^steam linux runtime/i,
  /^proton\b/i,
  /redistributables?$/i
];

function getSteamInstallPath(){
  const candidates = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam'
  ];
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', { windowsHide: true }).toString();
    const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match) candidates.unshift(match[1].trim().replace(/\//g, path.sep));
  } catch (e) {}
  return candidates.find(p => { try { return fs.existsSync(p); } catch(e){ return false; } }) || null;
}

function getSteamLibraryFolders(steamPath){
  const libraries = [steamPath];
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  try {
    const content = fs.readFileSync(vdfPath, 'utf8');
    const matches = content.matchAll(/"path"\s+"([^"]+)"/g);
    for (const m of matches) {
      const libPath = m[1].replace(/\\\\/g, '\\');
      if (!libraries.includes(libPath)) libraries.push(libPath);
    }
  } catch (e) {}
  return libraries;
}

// --- Steam playtime import -------------------------------------------------
// Playtime isn't in the .acf manifests — it lives in each local Steam user's
// localconfig.vdf under userdata/<id>/config/. VDF nests with braces (and
// "tags" sub-blocks nest further), so a flat regex can't safely extract a
// single app's block; we walk brace-matched instead.
function extractVdfBlock(content, fromIndex, key){
  const marker = `"${key}"`;
  const idx = content.indexOf(marker, fromIndex);
  if (idx === -1) return null;
  let i = idx + marker.length;
  while (i < content.length && content[i] !== '{' && content[i] !== '"') i++;
  if (content[i] !== '{') return null;
  let depth = 0, start = i;
  for (; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return { block: content.slice(start, i), endIndex: i };
}

function findLocalconfigPaths(steamPath){
  const userdataDir = path.join(steamPath, 'userdata');
  let dirs;
  try { dirs = fs.readdirSync(userdataDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (e) { return []; }
  const paths = [];
  for (const d of dirs) {
    const p = path.join(userdataDir, d.name, 'config', 'localconfig.vdf');
    try { if (fs.existsSync(p)) paths.push(p); } catch (e) {}
  }
  return paths;
}

// Returns a Map<appid, minutes> merged across every local Steam user profile
// found (covers shared/family PCs where the wrong profile might be active).
function getSteamPlaytimes(steamPath){
  const playtimes = new Map();
  for (const cfgPath of findLocalconfigPaths(steamPath)) {
    try {
      const content = fs.readFileSync(cfgPath, 'utf8');
      const appsBlock = extractVdfBlock(content, 0, 'apps');
      if (!appsBlock) continue;
      const block = appsBlock.block;
      const appIdRegex = /"(\d+)"\s*\{/g;
      let m;
      while ((m = appIdRegex.exec(block))) {
        const appid = m[1];
        const sub = extractVdfBlock(block, m.index, appid);
        if (!sub) continue;
        const playMatch = sub.block.match(/"Playtime"\s*"(\d+)"/i);
        if (playMatch) {
          const minutes = parseInt(playMatch[1], 10) || 0;
          playtimes.set(appid, Math.max(minutes, playtimes.get(appid) || 0));
        }
        appIdRegex.lastIndex = sub.endIndex;
      }
    } catch (e) {}
  }
  return playtimes;
}

ipcMain.handle('scan-steam-games', async () => {
  const steamPath = getSteamInstallPath();
  if (!steamPath) return [];
  const libraries = getSteamLibraryFolders(steamPath);
  let playtimes;
  try { playtimes = getSteamPlaytimes(steamPath); } catch (e) { playtimes = new Map(); }
  const results = [];
  const seenAppIds = new Set();
  for (const lib of libraries) {
    const steamappsDir = path.join(lib, 'steamapps');
    let files;
    try { files = fs.readdirSync(steamappsDir); } catch (e) { continue; }
    for (const file of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
      try {
        const content = fs.readFileSync(path.join(steamappsDir, file), 'utf8');
        const appidMatch = content.match(/"appid"\s+"(\d+)"/i);
        const nameMatch = content.match(/"name"\s+"([^"]+)"/i);
        if (!appidMatch || !nameMatch) continue;
        const appid = appidMatch[1];
        const name = nameMatch[1];
        if (seenAppIds.has(appid)) continue;
        if (STEAM_NAME_DENYLIST.some(p => p.test(name))) continue;
        seenAppIds.add(appid);
        const minutes = playtimes.get(appid) || 0;
        results.push({
          name,
          path: `steam://rungameid/${appid}`,
          header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
          playtimeSeconds: minutes * 60
        });
      } catch (e) {}
    }
  }
  return results;
});

ipcMain.handle('scan-exes', async (event, folderPath) => {
  let topEntries;
  try {
    topEntries = fs.readdirSync(folderPath, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch(e){
    return [];
  }
  const results = [];
  for (const dirEnt of topEntries){
    const topDir = path.join(folderPath, dirEnt.name);
    const exePath = findGameExeCandidates(topDir, dirEnt.name);
    if (exePath){
      results.push({ name: dirEnt.name, path: exePath, folderPath: topDir });
    }
  }
  return results;
});

ipcMain.handle('launch-game', async (event, exePath) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    // Steam (and other custom-protocol) games aren't a real .exe on disk —
    // they're launched by handing the OS a URI like steam://rungameid/730,
    // which the Steam client itself intercepts and boots. We have no handle
    // on the resulting process, so playtime can't be auto-tracked for these.
    if (/^[a-z0-9.+-]+:\/\//i.test(exePath) && !/^file:\/\//i.test(exePath)) {
      await shell.openExternal(exePath);
      if (win && !win.isDestroyed()) win.minimize();
      // No process handle to confirm against, so this is a best-effort delay
      // to roughly cover Steam's own boot time before we treat it as "running".
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('game-launch-confirmed', { exePath });
      }, 3000);
      return { ok: true };
    }
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(exePath)
    });
    const startTime = Date.now();
    activeLaunches.add(exePath);
    activeGamePids.set(exePath, child.pid);
    // Listen for exit BEFORE unref-ing so we still hear about it even though
    // the child is detached and the parent won't wait on it.
    child.on('exit', () => {
      activeLaunches.delete(exePath);
      activeGamePids.delete(exePath);
      const seconds = Math.round((Date.now() - startTime) / 1000);
      if (win && !win.isDestroyed()) {
        win.webContents.send('game-session-ended', { exePath, seconds, startTime });
        // Bring the launcher back once the game closes.
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    child.unref();
    if (win && !win.isDestroyed()) win.minimize();
    // Only tell the renderer the game is actually "launched" once the process
    // has survived a couple seconds — if it exited instantly (crash, missing
    // dependency, etc.) we don't want to fire off instant-replay capture for
    // a game that never really started.
    setTimeout(() => {
      if (child.exitCode === null && win && !win.isDestroyed()) {
        win.webContents.send('game-launch-confirmed', { exePath });
      }
    }, 2000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, reason: describeLaunchError(e, exePath) };
  }
});

// Turns a raw spawn error into a short, specific reason a user can act on,
// instead of just "could not launch game" every time.
function describeLaunchError(e, exePath){
  const code = e && e.code;
  if (code === 'ENOENT') return 'FILE NOT FOUND';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION DENIED — TRY RUNNING AS ADMIN';
  if (code === 'ENOTDIR') return 'INVALID PATH';
  if (code === 'UNKNOWN' && /steam/i.test(exePath || '')) return 'STEAM MAY NOT BE RUNNING';
  return 'LAUNCH FAILED';
}

ipcMain.handle('fetch-image-data', async (event, url) => {
  // Downloads a remote image (e.g. a Steam CDN banner) and returns it as a
  // base64 data URL. Used before cropping, since drawing a cross-origin
  // <img> onto a <canvas> in the renderer would taint the canvas and block
  // toDataURL(). Fetching it here in the main process sidesteps CORS.
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('pick-image', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'ico', 'gif', 'webp'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon', gif: 'image/gif', webp: 'image/webp' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath).toString('base64');
    return `data:${mime};base64,${data}`;
  } catch (e) {
    return null;
  }
});

function normalizeStoreName(s){
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// storesearch's first result isn't always the right game (sequels, demos,
// and soundtrack/DLC entries often outrank the base game for a short or
// generic title), so score every result against the game's name instead of
// blindly trusting items[0].
function pickBestStoreMatch(items, gameName){
  if (!items || items.length === 0) return null;
  const target = normalizeStoreName(gameName);
  let best = null;
  let bestScore = -Infinity;
  for (const item of items){
    const name = normalizeStoreName(item.name);
    let score;
    if (name === target) score = 200;
    else if (name.startsWith(target) || target.startsWith(name)) score = 100;
    else if (name.includes(target) || target.includes(name)) score = 50;
    else continue;
    score -= Math.abs(name.length - target.length);
    if (score > bestScore){ bestScore = score; best = item; }
  }
  // Fall back to the top result if nothing scored — better than nothing.
  return best || items[0];
}

ipcMain.handle('fetch-game-banner', async (event, gameName) => {
  try {
    const query = encodeURIComponent(gameName);
    const res = await fetch(`https://store.steampowered.com/api/storesearch/?term=${query}&cc=us&l=english`);
    if (!res.ok) return null;
    const data = await res.json();
    const first = pickBestStoreMatch(data.items, gameName);
    if (!first || !first.id) return null;

    // Prefer the much higher-resolution "library hero" art so the banner
    // isn't stretched/blurry. Fall back to the smaller header image if
    // the hero art doesn't exist for this app.
    const heroUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${first.id}/library_hero.jpg`;
    try {
      const heroCheck = await fetch(heroUrl, { method: 'HEAD' });
      if (heroCheck.ok) return heroUrl;
    } catch (e) {}

    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${first.id}/header.jpg`;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('fetch-game-header', async (event, gameName) => {
  try {
    const query = encodeURIComponent(gameName);
    const res = await fetch(`https://store.steampowered.com/api/storesearch/?term=${query}&cc=us&l=english`);
    if (res.ok) {
      const data = await res.json();
      const first = pickBestStoreMatch(data.items, gameName);
      if (first && first.id) {
        return `https://cdn.cloudflare.steamstatic.com/steam/apps/${first.id}/header.jpg`;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('export-library-data', async (event, jsonString) => {
  const result = await dialog.showSaveDialog({
    title: 'Export Muncher library backup',
    defaultPath: `muncher-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, jsonString, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('import-library-data', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import Muncher library backup',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  shell.openPath(folderPath);
  return true;
});

ipcMain.handle('delete-game-folder', async (event, exePath, explicitFolderPath) => {
  // Deletes the game's install folder (used when a game is removed from the
  // library and the user opts to also delete the files). When the caller
  // knows the real top-level game folder (e.g. from scan-exes, where the exe
  // can be nested a few levels deeper — bin/, Binaries/Win64/, etc.) it's
  // passed as explicitFolderPath; otherwise we fall back to the exe's parent.
  if (typeof exePath !== 'string' || !exePath) {
    return { ok: false, error: 'No path provided.' };
  }
  // Steam / protocol "paths" (steam://, etc.) aren't real files — nothing to delete.
  if (/^[a-z0-9.+-]+:\/\//i.test(exePath) && !/^file:\/\//i.test(exePath)) {
    return { ok: false, error: 'Not a local file path (e.g. a Steam link) — nothing to delete.' };
  }

  const folderPath = (typeof explicitFolderPath === 'string' && explicitFolderPath)
    ? explicitFolderPath
    : path.dirname(exePath);
  const parsed = path.parse(folderPath);

  // Refuse to delete a drive root, home directory, or anything suspiciously
  // shallow — a bad path here should never be able to wipe out C:\ etc.
  const normalized = path.resolve(folderPath);
  const isRoot = normalized === parsed.root;
  const home = app.getPath('home');
  const segmentCount = normalized.split(path.sep).filter(Boolean).length;

  if (isRoot || normalized === path.resolve(home) || segmentCount < 2) {
    return { ok: false, error: `Refusing to delete "${normalized}" — path looks too broad to be a game folder.` };
  }

  try {
    if (!fs.existsSync(normalized)) {
      return { ok: false, error: 'Folder no longer exists.' };
    }
    await fs.promises.rm(normalized, { recursive: true, force: true });
    return { ok: true, deletedPath: normalized };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Recursively sums file sizes under a directory. Symlinks are skipped (avoids
// cycles/double-counting into other install locations), and a depth cap keeps
// a pathological tree from hanging the scan. Uses the async fs API so each
// readdir/stat call yields back to the event loop instead of blocking the
// main process — the old sync version froze the whole app's IPC/UI while
// walking big game folders.
async function getDirSizeAsync(dirPath, depth){
  if (depth > 12) return 0;
  let total = 0;
  let entries;
  try { entries = await fs.promises.readdir(dirPath, { withFileTypes: true }); } catch (e) { return 0; }
  for (const entry of entries){
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await getDirSizeAsync(full, depth + 1);
      } else if (entry.isFile()) {
        const st = await fs.promises.stat(full);
        total += st.size;
      }
    } catch (e) {}
  }
  return total;
}

ipcMain.handle('get-folder-sizes', async (event, folderPaths) => {
  // Used by the Library Tools storage breakdown. Returns { [folderPath]:
  // bytes|null } — null means the folder is missing or unreadable, so the
  // renderer can distinguish "0 bytes" from "couldn't measure this one".
  // Folders are measured one at a time (not in parallel) so a large library
  // doesn't spawn dozens of concurrent recursive walks competing for disk I/O.
  const results = {};
  for (const p of (folderPaths || [])) {
    if (typeof p !== 'string' || !p || results[p] !== undefined) continue;
    try {
      const exists = await fs.promises.access(p).then(() => true).catch(() => false);
      if (!exists) { results[p] = null; continue; }
      results[p] = await getDirSizeAsync(p, 0);
    } catch (e) {
      results[p] = null;
    }
  }
  return results;
});

function sanitizeForFilename(name){
  return (name || 'game').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'game';
}

function defaultClipsBaseDir(){
  return path.join(app.getPath('userData'), 'clips');
}

// customBase is the user's chosen clip directory (from Settings > Clips),
// passed in from the renderer on each call since that's where it's persisted.
// Falls back to the default <userData>/clips location when unset.
function getClipsDir(gameName, customBase){
  const base = (typeof customBase === 'string' && customBase.trim()) ? customBase : defaultClipsBaseDir();
  return path.join(base, sanitizeForFilename(gameName));
}

// ---- Instant Replay v2: main-process ffmpeg capture, bypasses Chromium's
// desktopCapturer/WGC pipeline entirely ----
// The previous approach captured via getUserMedia in the renderer (Windows
// Graphics Capture under the hood) and encoded with MediaRecorder (VP9) in
// the renderer too — every frame paid for both WGC's overhead AND a
// software VP9 encode competing with the renderer's UI thread, and WGC
// itself is flaky enough on some GPU/driver combos to crash mid-session on
// its own. Recording via ffmpeg's gdigrab in the main process sidesteps WGC
// completely and moves all encode work off the renderer — closer to how a
// dedicated clipper like Medal works (a separate, low-level capture process
// rather than a browser capture API).
//
// Trade-off: gdigrab is video-only — Windows has no built-in loopback audio
// source ffmpeg can grab without a virtual audio driver — so instant replay
// clips are video-only in this mode.
const REPLAY_SEGMENT_SECONDS = 5; // must match REPLAY_SEGMENT_MS/1000 in launcher.html
let replayProc = null;
let replayBufferDir = null;
let replayCleanupInterval = null;
let replayStoppedIntentionally = false;
let replayRestartAttempts = 0;
let replayRestartTimer = null;

function replayBaseDir(){
  return path.join(app.getPath('temp'), 'muncher-replay-buffer');
}

function cleanupReplayDir(dir){
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

// Resolves the actual on-screen window title for a launched game so gdigrab
// can capture just that window — cropped to whatever size/position it's
// currently at — instead of the whole desktop. Tries the known PID first
// (works for the common case of a game launched directly), then falls back
// to matching by executable name (covers games that immediately hand off to
// a child process with a different PID, e.g. a bootstrapper/launcher stub).
// Retries a few times since a window can take a moment to actually appear
// after the process starts.
function resolveGameWindowTitle(exePath, pid){
  return new Promise((resolve) => {
    const exeName = path.basename(exePath, path.extname(exePath));
    const script = [
      `$byPid = Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' }`,
      `if ($byPid) { Write-Output $byPid.MainWindowTitle; exit }`,
      `$byName = Get-Process -Name '${exeName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1`,
      `if ($byName) { Write-Output $byName.MainWindowTitle }`
    ].join('; ');

    let attempts = 0;
    const tryOnce = () => {
      attempts++;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
        const title = (stdout || '').trim().split(/\r?\n/)[0]?.trim();
        if (title) return resolve(title);
        if (attempts < 6) setTimeout(tryOnce, 500);
        else resolve(null); // give up — caller falls back to full-desktop capture
      });
    };
    tryOnce();
  });
}

// Launches the actual gdigrab process and wires up crash recovery. Unlike
// the very first version of this rewrite, an unexpected exit (display mode
// change, GPU hiccup, the captured window closing, etc.) no longer just
// leaves instant replay silently dead — that was the bug behind "only the
// first clip works, then nothing": the buffer stops growing the moment
// gdigrab dies, so every save after that fails with "not running", but
// nothing ever told the user that or tried to recover.
function spawnReplayProcess(args, capturingWindow, captureTarget){
  let proc;
  try {
    proc = spawn(ffmpegPath, args, { windowsHide: true });
  } catch (e) {
    return null;
  }
  let sawEarlyError = false;
  proc.stderr?.on('data', () => { /* ffmpeg logs everything to stderr even on success; hook kept for future diagnostics */ });
  proc.on('exit', (code) => {
    if (replayStoppedIntentionally) { replayProc = null; return; }

    // A window-title capture can fail immediately if the window closes,
    // minimizes, or the title didn't match cleanly. Fall back to
    // full-desktop capture once before falling through to the general
    // crash-recovery path below.
    if (capturingWindow && code !== 0 && !sawEarlyError) {
      sawEarlyError = true;
      replayProc = null;
      const fallbackArgs = args.slice();
      fallbackArgs[fallbackArgs.indexOf(captureTarget)] = 'desktop';
      replayProc = spawnReplayProcess(fallbackArgs, false, 'desktop');
      if (replayProc) return;
    }

    replayProc = null;
    // General crash recovery: gdigrab itself can still die mid-session
    // (display/resolution change, GPU driver hiccup) even when capturing
    // the full desktop. Retry with backoff instead of leaving the buffer
    // dead — capped so a persistently broken capture doesn't retry forever.
    if (replayRestartAttempts++ < 6) {
      const delay = Math.min(1000 * Math.pow(2, replayRestartAttempts - 1), 8000);
      clearTimeout(replayRestartTimer);
      replayRestartTimer = setTimeout(() => {
        if (replayStoppedIntentionally) return;
        replayProc = spawnReplayProcess(args, false, captureTarget);
      }, delay);
    }
  });
  proc.on('error', () => { replayProc = null; });
  return proc;
}

ipcMain.handle('start-instant-replay', async (event, maxSeconds, exePath) => {
  if (replayProc) return { ok: true }; // already running
  replayStoppedIntentionally = false;
  replayRestartAttempts = 0;
  const dir = replayBaseDir();
  cleanupReplayDir(dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  replayBufferDir = dir;

  // Figure out what to capture: the specific game window if we can resolve
  // one, otherwise the whole desktop as a safe fallback (also what happens
  // for Steam/protocol-launched games, where we never got a real PID).
  let captureTarget = 'desktop';
  let capturingWindow = false;
  const pid = exePath ? activeGamePids.get(exePath) : null;
  if (pid) {
    const title = await resolveGameWindowTitle(exePath, pid);
    if (title) {
      captureTarget = `title=${title}`;
      capturingWindow = true;
    }
  }

  const pattern = path.join(dir, 'seg_%06d.mp4');
  const args = [
    '-y',
    '-f', 'gdigrab',
    '-framerate', '30',
    '-i', captureTarget,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-g', String(30 * REPLAY_SEGMENT_SECONDS),
    '-f', 'segment',
    '-segment_time', String(REPLAY_SEGMENT_SECONDS),
    '-reset_timestamps', '1',
    pattern
  ];

  replayProc = spawnReplayProcess(args, capturingWindow, captureTarget);
  if (!replayProc) return { ok: false, error: 'Could not start the capture process' };

  // The segment muxer just keeps writing forever — periodically delete
  // segments older than what any clip length could need, so the buffer
  // folder doesn't grow unbounded over a long play session.
  const keepSeconds = Math.max(60, (maxSeconds || 30) * 4);
  clearInterval(replayCleanupInterval);
  replayCleanupInterval = setInterval(() => {
    if (!replayBufferDir) return;
    try {
      const files = fs.readdirSync(replayBufferDir).filter(f => /^seg_\d+\.mp4$/.test(f)).sort();
      const keepCount = Math.ceil(keepSeconds / REPLAY_SEGMENT_SECONDS) + 2;
      const toDelete = files.slice(0, Math.max(0, files.length - keepCount));
      for (const f of toDelete) {
        try { fs.unlinkSync(path.join(replayBufferDir, f)); } catch (e) {}
      }
    } catch (e) {}
  }, REPLAY_SEGMENT_SECONDS * 1000);

  return { ok: true };
});

ipcMain.handle('stop-instant-replay', async () => {
  replayStoppedIntentionally = true;
  clearTimeout(replayRestartTimer);
  clearInterval(replayCleanupInterval);
  replayCleanupInterval = null;
  if (replayProc) {
    try { replayProc.kill(); } catch (e) {}
    replayProc = null;
  }
  if (replayBufferDir) {
    cleanupReplayDir(replayBufferDir);
    replayBufferDir = null;
  }
  return { ok: true };
});

ipcMain.handle('save-instant-replay-clip', async (event, gameName, clipsDir, seconds, audioBuffers) => {
  if (!replayProc || !replayBufferDir) return { ok: false, error: 'Instant replay is not running' };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muncher-clip-'));
  try {
    const files = fs.readdirSync(replayBufferDir).filter(f => /^seg_\d+\.mp4$/.test(f)).sort();
    if (files.length < 2) return { ok: false, error: 'Not enough buffered yet — wait a few seconds and try again' };
    const usable = files.slice(0, -1); // the newest segment is still being written to, skip it
    const needed = Math.max(1, Math.ceil((seconds || 30) / REPLAY_SEGMENT_SECONDS) + 1);
    const chosen = usable.slice(-needed);

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(
      listFile,
      chosen.map(f => `file '${path.join(replayBufferDir, f).replace(/'/g, "'\\''")}'`).join('\n')
    );

    const dir = getClipsDir(gameName, clipsDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${sanitizeForFilename(gameName)}-${stamp}.mp4`);

    const writeVideoOnly = () => new Promise((resolve, reject) => {
      // All video segments share identical codec params (see
      // start-instant-replay), so a stream copy is enough — no re-encode.
      execFile(ffmpegPath, [
        '-y',
        '-safe', '0',
        '-f', 'concat',
        '-i', listFile,
        '-c', 'copy',
        filePath
      ], (err) => (err ? reject(err) : resolve()));
    });

    // Audio (only present when "Record audio" is on) comes from a separate
    // rolling buffer captured in the renderer via a desktop-loopback
    // getUserMedia + MediaRecorder — gdigrab itself stays video-only, it has
    // no system-audio loopback of its own (see notes above
    // start-instant-replay). The renderer segments its own audio the same
    // way this buffer segments video, but the two rolling buffers are
    // started independently (video when instant replay starts in main.js,
    // audio a moment later once the renderer's getUserMedia call resolves),
    // so their segment boundaries don't line up. We used to just concat
    // N-of-each and trim to -shortest, which left a fixed offset (typically
    // several hundred ms up to most of a segment) for the whole clip —
    // that's the audio/video desync. Fix: figure out the real wall-clock
    // start of the first chosen video segment and the first chosen audio
    // segment, and shift whichever started later with -itsoffset so both
    // streams begin at the same instant.
    const audioSegments = Array.isArray(audioBuffers)
      ? audioBuffers.filter(seg => seg && seg.buffer)
      : [];

    if (audioSegments.length === 0) {
      await writeVideoOnly();
      return { ok: true, filePath };
    }

    const audioPaths = audioSegments.map((seg, i) => {
      const segPath = path.join(tmpDir, `aseg${String(i).padStart(3, '0')}.webm`);
      fs.writeFileSync(segPath, Buffer.from(seg.buffer));
      return segPath;
    });
    const audioListFile = path.join(tmpDir, 'audiolist.txt');
    fs.writeFileSync(
      audioListFile,
      audioPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    );

    // Video segment files are created the instant gdigrab's segment muxer
    // rolls over to them, so birthtime is a good proxy for "when this
    // segment's video actually starts". Fall back to mtime minus one
    // segment length if birthtime isn't available (rare, but some
    // filesystems don't report it).
    let videoStartMs = null;
    try {
      const firstVideoPath = path.join(replayBufferDir, chosen[0]);
      const stat = fs.statSync(firstVideoPath);
      videoStartMs = (stat.birthtimeMs && stat.birthtimeMs > 0)
        ? stat.birthtimeMs
        : stat.mtimeMs - REPLAY_SEGMENT_SECONDS * 1000;
    } catch (e) { /* leave null — skip offset below */ }

    const audioStartMs = audioSegments[0].startTs || null;

    // Positive offsetSeconds = audio started after video (delay audio).
    // Negative = audio started before video (delay video instead).
    // Clamp to a sane range so a bogus timestamp can't produce a
    // multi-minute -itsoffset and silently blank out a stream.
    let offsetSeconds = 0;
    if (videoStartMs != null && audioStartMs != null) {
      offsetSeconds = (audioStartMs - videoStartMs) / 1000;
      if (Math.abs(offsetSeconds) > REPLAY_SEGMENT_SECONDS * 2) offsetSeconds = 0;
    }

    const videoInputArgs = offsetSeconds < 0
      ? ['-itsoffset', String(-offsetSeconds), '-i', listFile]
      : ['-i', listFile];
    const audioInputArgs = offsetSeconds > 0
      ? ['-itsoffset', String(offsetSeconds), '-i', audioListFile]
      : ['-i', audioListFile];

    try {
      // Video stream-copies straight through (already h264/mp4 from
      // gdigrab); audio gets decoded from its webm/opus segments and
      // re-encoded to AAC so it can live in the same mp4 container.
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
          '-y',
          '-safe', '0', '-f', 'concat', ...videoInputArgs,
          '-safe', '0', '-f', 'concat', ...audioInputArgs,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '160k',
          '-shortest',
          '-movflags', '+faststart',
          filePath
        ], (err) => (err ? reject(err) : resolve()));
      });
    } catch (e) {
      // Muxing failed (e.g. malformed/empty audio segments) — still give the
      // user the video rather than losing the clip entirely.
      await writeVideoOnly();
    }

    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle('get-capture-sources', async () => {
  try {
    // Window-level WGC capture is markedly more crash-prone against games in
    // exclusive fullscreen than monitor-level capture, since the game and
    // the capture session end up fighting over the same swapchain. Only
    // offering 'screen' sources means the renderer always grabs a full
    // monitor capture instead, which is meaningfully more stable.
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    return [];
  }
});

ipcMain.handle('get-default-clips-dir', async () => defaultClipsBaseDir());

// `buffers` is an array of ArrayBuffers — one per recorded replay segment,
// oldest first (see recordReplaySegment in launcher.html). Each segment is
// its own independent, self-contained WebM stream, so we can't just glue
// their bytes together: that "works" in permissive players (VLC/mpv/ffmpeg)
// but stops after the first segment's duration in most others, since it
// isn't a single continuous stream. Instead we write each segment to a temp
// file and have ffmpeg's concat demuxer decode/re-encode them back-to-back
// into one real, continuous .mp4 — which fixes both the playback cutoff and
// gives an actually-portable file format.
ipcMain.handle('save-clip', async (event, gameName, buffers, clipsDir) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muncher-clip-'));
  try {
    const segments = Array.isArray(buffers) ? buffers : [buffers];
    if (segments.length === 0) return { ok: false, error: 'Nothing to save' };

    const segmentPaths = segments.map((buf, i) => {
      const segPath = path.join(tmpDir, `seg${String(i).padStart(3, '0')}.webm`);
      fs.writeFileSync(segPath, Buffer.from(buf));
      return segPath;
    });
    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(
      listFile,
      segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    );

    const dir = getClipsDir(gameName, clipsDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${sanitizeForFilename(gameName)}-${stamp}.mp4`);

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-y',
        '-safe', '0',
        '-f', 'concat',
        '-i', listFile,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-movflags', '+faststart',
        filePath
      ], (err) => (err ? reject(err) : resolve()));
    });

    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle('open-clips-folder', async (event, gameName, clipsDir) => {
  const dir = getClipsDir(gameName, clipsDir);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return true;
});

ipcMain.handle('play-clip', async (event, filePath) => {
  // Play the clip using the default system player
  shell.openPath(filePath);
  return { ok: true };
});

ipcMain.handle('delete-clip', async (event, filePath) => {
  // Delete the clip file
  try {
    await fs.promises.unlink(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('check-paths', async (event, exePaths) => {
  // Only checks real filesystem paths — steam:// (and other protocol) links
  // aren't files, so they're never reported as missing.
  const missing = [];
  for (const p of exePaths || []) {
    if (typeof p !== 'string' || !p) continue;
    if (/^[a-z0-9.+-]+:\/\//i.test(p) && !/^file:\/\//i.test(p)) continue;
    try {
      if (!fs.existsSync(p)) missing.push(p);
    } catch (e) {
      missing.push(p);
    }
  }
  return missing;
});