// downloads.js - Complete rewrite for SteamUnlocked.net
// HTTP(S) downloads with pause/resume, and WebTorrent for magnet links.
// Both share one queue/UI model.

const { app, net, ipcMain: defaultIpcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const extractZip = require('extract-zip');

// Import scraper for SteamUnlocked
const { searchAllSources, getDownloadLink } = require('./scraper');

const STATE_FILE = () => path.join(app.getPath('userData'), 'downloads.json');

let win = null; // set via init()
let webTorrentClient = null; // lazily created

// id -> { item, controller (http) | torrent (wt), paused, cancelled }
const active = new Map();

let items = []; // persisted metadata

// ---------- IPC communication ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ---------- State persistence ----------

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf-8');
    items = JSON.parse(raw);
    // Mark any in-progress downloads as paused on app restart
    items.forEach(it => {
      if (it.status === 'downloading') it.status = 'paused';
    });
  } catch (e) {
    items = [];
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify(items, null, 2));
  } catch (e) {}
}

// ---------- Utility functions ----------

function getDefaultDownloadDir() {
  return path.join(app.getPath('downloads'), 'Muncher');
}

function findItem(id) {
  return items.find(i => i.id === id);
}

function broadcastList() {
  send('downloads-updated', items);
}

function updateProgress(id, patch) {
  const it = findItem(id);
  if (!it) return;
  Object.assign(it, patch);
  send('download-progress', { id, ...patch });
}

function makeArchiveFolder(destPath) {
  const ext = path.extname(destPath).toLowerCase();
  if (ext !== '.zip') return null;
  return path.join(path.dirname(destPath), path.basename(destPath, ext));
}

// ---------- Auto-extract ZIP files ----------

async function maybeAutoExtract(item) {
  if (item.source !== 'steamunlocked' && item.source !== 'steamrip') return false;
  
  const extractPath = makeArchiveFolder(item.destPath);
  if (!extractPath) return false;
  
  try {
    fs.mkdirSync(extractPath, { recursive: true });
    await extractZip(item.destPath, { dir: extractPath });
    try { fs.unlinkSync(item.destPath); } catch (e) {}
    
    item.destPath = extractPath;
    item.name = path.basename(extractPath);
    updateProgress(item.id, { 
      status: 'completed', 
      destPath: extractPath, 
      name: item.name, 
      speedBps: 0 
    });
    return true;
  } catch (e) {
    console.error('Archive extraction failed:', e);
    updateProgress(item.id, { status: 'error', error: 'Extraction failed' });
    return false;
  }
}

// ---------- HTTP download with redirect handling ----------

function startHttpDownload(id, url, destPath, resumeFromBytes) {
  const item = findItem(id);
  const fileFlags = resumeFromBytes > 0 ? 'r+' : 'w';
  let fd;
  
  try {
    fd = fs.openSync(destPath, fileFlags);
    if (resumeFromBytes > 0) fs.ftruncateSync(fd, resumeFromBytes);
  } catch (e) {
    updateProgress(id, { status: 'error', error: 'Could not open destination file' });
    return;
  }

  let fdClosed = false;
  function closeFd() {
    if (fdClosed) return;
    fdClosed = true;
    try { fs.closeSync(fd); } catch (e) {}
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br'
  };
  if (resumeFromBytes > 0) {
    headers['Range'] = `bytes=${resumeFromBytes}-`;
  }

  let received = resumeFromBytes;
  let total = item.totalBytes || 0;
  const startedAt = Date.now();
  let lastTick = startedAt;
  let lastReceived = received;
  let redirectCount = 0;
  const maxRedirects = 10;

  const entry = { item, closeFd };
  active.set(id, entry);

  function makeRequest(requestUrl) {
    const request = net.request({ url: requestUrl, method: 'GET', headers });
    entry.request = request;

    request.on('response', (response) => {
      // Handle redirects (3xx)
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers['location'];
        if (location && redirectCount < maxRedirects) {
          redirectCount++;
          const redirectUrl = new URL(location, requestUrl).toString();
          console.log(`[Download] Redirect ${redirectCount}: ${requestUrl} -> ${redirectUrl}`);
          
          try { request.abort(); } catch (e) {}
          makeRequest(redirectUrl);
          return;
        }
      }

      // Handle errors
      if (response.statusCode >= 400) {
        updateProgress(id, { status: 'error', error: `Server returned ${response.statusCode}` });
        closeFd();
        active.delete(id);
        saveState();
        return;
      }

      // Handle range request
      if (resumeFromBytes > 0 && response.statusCode !== 206) {
        try { fs.ftruncateSync(fd, 0); } catch (e) {}
        received = 0;
      }

      // Get content length
      const lengthHeader = response.headers['content-length'];
      if (lengthHeader) {
        const len = parseInt(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader, 10);
        if (!isNaN(len)) total = received + len;
      }

      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('text/html') && !requestUrl.match(/\.(zip|rar|7z|exe|iso)(\?|$)/i)) {
        console.warn('[Download] Received HTML instead of file. URL might need further resolution.');
      }

      updateProgress(id, { status: 'downloading', totalBytes: total });

      response.on('data', (chunk) => {
        try {
          fs.writeSync(fd, chunk, 0, chunk.length, received);
        } catch (e) {
          updateProgress(id, { status: 'error', error: 'Disk write failed' });
          try { request.abort(); } catch (er) {}
          return;
        }
        received += chunk.length;
        
        const now = Date.now();
        if (now - lastTick > 300) {
          const speed = ((received - lastReceived) / ((now - lastTick) / 1000));
          lastTick = now;
          lastReceived = received;
          updateProgress(id, {
            receivedBytes: received,
            totalBytes: total,
            speedBps: speed
          });
        }
      });

      response.on('end', async () => {
        closeFd();
        active.delete(id);
        
        const it = findItem(id);
        if (it && it.status !== 'cancelled') {
          if ((it.source === 'steamunlocked' || it.source === 'steamrip') && 
              path.extname(it.destPath).toLowerCase() === '.zip') {
            updateProgress(id, { 
              status: 'extracting', 
              receivedBytes: received, 
              totalBytes: total || received, 
              speedBps: 0 
            });
            await maybeAutoExtract(it);
          } else {
            updateProgress(id, { 
              status: 'completed', 
              receivedBytes: received, 
              totalBytes: total || received, 
              speedBps: 0 
            });
          }
          saveState();
        }
      });

      response.on('error', () => {
        closeFd();
        active.delete(id);
        updateProgress(id, { status: 'error', error: 'Connection lost' });
        saveState();
      });
    });

    request.on('error', (err) => {
      closeFd();
      active.delete(id);
      updateProgress(id, { status: 'error', error: err.message || 'Network error' });
      saveState();
    });

    request.end();
  }

  makeRequest(url);
}

// ---------- Add HTTP download ----------

function addHttpDownload({ url, saveDir, source }) {
  const id = randomUUID();
  let name;
  
  try {
    const urlObj = new URL(url);
    let pathName = urlObj.pathname;
    if (!pathName || pathName === '/') {
      const params = new URLSearchParams(urlObj.search);
      for (const [key, value] of params) {
        if (value && /\.(zip|rar|7z|exe|iso|dmg|pkg)$/i.test(value)) {
          pathName = '/' + value;
          break;
        }
      }
    }
    name = decodeURIComponent(path.basename(pathName)) || 'download';
    name = name.replace(/[<>:"/\\|?*]/g, '_');
  } catch (e) {
    name = 'download';
  }
  
  if (!path.extname(name)) {
    name += '.zip';
  }

  const destPath = path.join(saveDir, name);
  const item = {
    id,
    kind: 'http',
    name,
    url,
    destPath,
    source: source || 'steamunlocked',
    status: 'downloading',
    receivedBytes: 0,
    totalBytes: 0,
    speedBps: 0,
    addedAt: Date.now()
  };
  
  items.unshift(item);
  broadcastList();
  fs.mkdirSync(saveDir, { recursive: true });
  startHttpDownload(id, url, destPath, 0);
  return item;
}

// ---------- Pause/resume HTTP ----------

function pauseHttpDownload(id) {
  const entry = active.get(id);
  if (entry && entry.request) {
    try { entry.request.abort(); } catch (e) {}
  }
  active.delete(id);
  updateProgress(id, { status: 'paused', speedBps: 0 });
  saveState();
}

function resumeHttpDownload(id) {
  const it = findItem(id);
  if (!it) return;
  startHttpDownload(id, it.url, it.destPath, it.receivedBytes || 0);
}

// ---------- Torrent downloads (WebTorrent) ----------

async function getWebTorrentClient() {
  if (webTorrentClient) return webTorrentClient;
  const WebTorrent = (await import('webtorrent')).default;
  webTorrentClient = new WebTorrent();
  return webTorrentClient;
}

async function addTorrentDownload({ magnetOrUrl, saveDir }) {
  const id = randomUUID();
  const item = {
    id,
    kind: 'torrent',
    name: 'Fetching torrent info…',
    url: magnetOrUrl,
    destPath: saveDir,
    status: 'downloading',
    receivedBytes: 0,
    totalBytes: 0,
    speedBps: 0,
    addedAt: Date.now()
  };
  
  items.unshift(item);
  broadcastList();
  fs.mkdirSync(saveDir, { recursive: true });

  const client = await getWebTorrentClient();
  let torrent;
  
  try {
    torrent = client.add(magnetOrUrl, { path: saveDir });
  } catch (e) {
    updateProgress(id, { status: 'error', error: 'Invalid magnet/torrent link' });
    return item;
  }
  
  active.set(id, { item, torrent });

  torrent.on('infoHash', () => {
    updateProgress(id, { name: torrent.name || item.name });
  });

  torrent.on('metadata', () => {
    updateProgress(id, { name: torrent.name, totalBytes: torrent.length });
  });

  let lastTick = 0;
  torrent.on('download', () => {
    const now = Date.now();
    if (now - lastTick < 300) return;
    lastTick = now;
    updateProgress(id, {
      name: torrent.name || item.name,
      receivedBytes: torrent.downloaded,
      totalBytes: torrent.length,
      speedBps: torrent.downloadSpeed,
      peers: torrent.numPeers
    });
  });

  torrent.on('done', () => {
    updateProgress(id, { 
      status: 'completed', 
      receivedBytes: torrent.length, 
      totalBytes: torrent.length, 
      speedBps: 0 
    });
    active.delete(id);
    saveState();
  });

  torrent.on('error', (err) => {
    updateProgress(id, { status: 'error', error: (err && err.message) || 'Torrent error' });
    active.delete(id);
    saveState();
  });

  return item;
}

function pauseTorrentDownload(id) {
  const entry = active.get(id);
  if (entry && entry.torrent) {
    entry.torrent.pause();
  }
  updateProgress(id, { status: 'paused', speedBps: 0 });
  saveState();
}

function resumeTorrentDownload(id) {
  const entry = active.get(id);
  if (entry && entry.torrent) {
    entry.torrent.resume();
    updateProgress(id, { status: 'downloading' });
    return;
  }
  const it = findItem(id);
  if (it) {
    addTorrentDownload({ magnetOrUrl: it.url, saveDir: it.destPath }).then(() => {
      saveState();
      broadcastList();
    });
  }
}

// ---------- Shared controls ----------

function cancelDownload(id) {
  const it = findItem(id);
  if (!it) return;
  
  const entry = active.get(id);
  if (entry) {
    if (entry.request) {
      try { entry.request.abort(); } catch (e) {}
    }
    if (entry.closeFd) entry.closeFd();
    if (entry.torrent) {
      try {
        entry.torrent.destroy({ destroyStore: true });
      } catch (e) {}
    }
  }
  
  active.delete(id);
  it.status = 'cancelled';
  saveState();
  deletePartialFile(it);
  broadcastList();
}

function deletePartialFile(it) {
  if (!it || !it.destPath) return;
  try {
    if (it.kind === 'http') {
      if (fs.existsSync(it.destPath) && fs.statSync(it.destPath).isFile()) {
        fs.unlinkSync(it.destPath);
      }
    } else if (it.kind === 'torrent' && it.name && it.name !== 'Fetching torrent info…') {
      const torrentPath = path.join(it.destPath, it.name);
      if (fs.existsSync(torrentPath)) {
        fs.rmSync(torrentPath, { recursive: true, force: true });
      }
    }
  } catch (e) {}
}

function removeDownload(id) {
  const it = findItem(id);
  if (it && it.status !== 'completed') {
    cancelDownload(id);
  } else if (it) {
    const entry = active.get(id);
    if (entry) {
      if (entry.request) {
        try { entry.request.abort(); } catch (e) {}
      }
      if (entry.closeFd) entry.closeFd();
      active.delete(id);
    }
  }
  items = items.filter(i => i.id !== id);
  saveState();
  broadcastList();
}

// ---------- Page scanning ----------

const INSTALLER_EXT_RE = /\.(exe|msi|zip|7z|dmg|pkg|appimage|rar)(\?[^"'<>\s]*)?$/i;
const DOWNLOAD_HINT_RE = /(download|installer|setup|launcher|client|getfile|\/dl\/|cdn)/i;

function extractDownloadLinks(html, baseUrl) {
  const found = new Map();
  
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const rawHref = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let abs;
    try { abs = new URL(rawHref, baseUrl).toString(); } catch (e) { continue; }
    if (!/^https?:\/\//i.test(abs)) continue;
    
    const looksLikeFile = INSTALLER_EXT_RE.test(abs);
    const looksLikeDownloadPath = DOWNLOAD_HINT_RE.test(abs) || DOWNLOAD_HINT_RE.test(text);
    if (!looksLikeFile && !looksLikeDownloadPath) continue;
    
    if (!found.has(abs)) {
      found.set(abs, text || abs.split('/').pop() || abs);
    }
  }

  const bareUrlRe = /["'](https?:\/\/[^"'<>\s]+?\.(?:exe|msi|zip|7z|dmg|pkg|appimage|rar))(?:\?[^"'<>\s]*)?["']/gi;
  while ((m = bareUrlRe.exec(html)) !== null) {
    const abs = m[1];
    if (!found.has(abs)) found.set(abs, abs.split('/').pop());
  }

  return Array.from(found.entries()).map(([url, label]) => ({ url, label })).slice(0, 30);
}

// ---------- Register IPC handlers ----------

function registerHandlers(ipcMainParam, mainWindow) {
  const ipcMain = ipcMainParam || defaultIpcMain;
  win = mainWindow;
  loadState();

  // Safe handler wrapper to eliminate duplicate IPC registration crashes
  function safeHandle(channel, handler) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }

  safeHandle('downloads-get-all', () => items);
  safeHandle('downloads-get-default-dir', () => getDefaultDownloadDir());

  safeHandle('downloads-add-http', async (event, { url, saveDir, source }) => {
    if (!url || typeof url !== 'string') return { ok: false, error: 'No URL provided' };
    const dir = saveDir || getDefaultDownloadDir();
    try {
      const item = addHttpDownload({ url, saveDir: dir, source });
      return { ok: true, item };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  safeHandle('downloads-add-torrent', async (event, { magnetOrUrl, saveDir }) => {
    if (!magnetOrUrl || typeof magnetOrUrl !== 'string') return { ok: false, error: 'No magnet/torrent link provided' };
    const dir = saveDir || getDefaultDownloadDir();
    try {
      const item = await addTorrentDownload({ magnetOrUrl, saveDir: dir });
      return { ok: true, item };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  safeHandle('downloads-search-sources', async (event, query) => {
    if (!query || typeof query !== 'string') return { ok: false, error: 'No search query provided' };
    try {
      const results = await searchAllSources(query);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message || 'Search failed' };
    }
  });

  safeHandle('downloads-fetch-download-link', async (event, pageUrl) => {
    if (!pageUrl || typeof pageUrl !== 'string') return { ok: false, error: 'No page URL provided' };
    try {
      const downloadUrl = await getDownloadLink(pageUrl);
      if (!downloadUrl) return { ok: false, error: 'No download link found' };
      return { ok: true, url: downloadUrl };
    } catch (e) {
      return { ok: false, error: e.message || 'Fetch failed' };
    }
  });

  safeHandle('downloads-scan-page', async (event, pageUrl) => {
    if (!pageUrl || typeof pageUrl !== 'string') return { ok: false, error: 'No URL provided' };
    let base;
    try { base = new URL(pageUrl); } catch (e) { return { ok: false, error: 'Invalid URL' }; }
    try {
      const res = await net.fetch(pageUrl, { 
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!res.ok) return { ok: false, error: `Page returned ${res.status}` };
      const html = await res.text();
      const links = extractDownloadLinks(html, base);
      return { ok: true, links };
    } catch (e) {
      return { ok: false, error: e.message || 'Fetch failed' };
    }
  });

  // Legacy aliases fixed to execute search direct instead of calling ipcMain.handle
  safeHandle('downloads-search-steamunlocked', async (event, query) => {
    if (!query || typeof query !== 'string') return { ok: false, error: 'No search query provided' };
    try {
      const results = await searchAllSources(query);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message || 'Search failed' };
    }
  });

  safeHandle('downloads-fetch-steamunlocked-link', async (event, pageUrl) => {
    if (!pageUrl || typeof pageUrl !== 'string') return { ok: false, error: 'No page URL provided' };
    try {
      const downloadUrl = await getDownloadLink(pageUrl);
      if (!downloadUrl) return { ok: false, error: 'No download link found' };
      return { ok: true, url: downloadUrl };
    } catch (e) {
      return { ok: false, error: e.message || 'Fetch failed' };
    }
  });

  safeHandle('downloads-pause', (event, id) => {
    const it = findItem(id);
    if (!it) return false;
    if (it.kind === 'http') pauseHttpDownload(id);
    else pauseTorrentDownload(id);
    return true;
  });

  safeHandle('downloads-resume', (event, id) => {
    const it = findItem(id);
    if (!it) return false;
    if (it.kind === 'http') resumeHttpDownload(id);
    else resumeTorrentDownload(id);
    return true;
  });

  safeHandle('downloads-cancel', (event, id) => { 
    cancelDownload(id); 
    return true; 
  });

  safeHandle('downloads-remove', (event, id) => { 
    removeDownload(id); 
    return true; 
  });

  safeHandle('downloads-open-folder', async (event, folderPath) => {
    const { shell } = require('electron');
    shell.openPath(folderPath);
    return true;
  });
}

module.exports = { registerHandlers };