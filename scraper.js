// scraper.js - Electron Scraper for SteamUnlocked, UploadHaven, and SteamRIP
const { net, BrowserWindow } = require('electron');

const STEAMUNLOCKED_BASE = 'https://steamunlocked.org';
const STEAMRIP_BASE = 'https://steamrip.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function fetchHtml(url, customHeaders = {}) {
  const response = await net.fetch(url, {
    method: 'GET',
    headers: { ...HEADERS, ...customHeaders },
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.text();
}

function isIgnoredUrl(url, baseUrl) {
  const lower = url.toLowerCase();
  const ignoredPaths = [
    '/?s=', '/category/', '/page/', '/tag/', '/dmca', '/all-games', 
    '/faq', '/how-to-run-games', '/contact', '/privacy-policy', 
    '/support', '/#', '/updates', 'facebook.com', 'twitter.com', 'discord.gg'
  ];
  return ignoredPaths.some(path => lower.includes(path)) || 
         lower === `${baseUrl}/` || 
         lower === baseUrl;
}

function cleanTitleFromUrl(url) {
  try {
    const pathName = new URL(url).pathname.replace(/\/$/, '');
    const slug = pathName.split('/').pop() || '';
    return slug
      .replace(/-free-download/g, '')
      .replace(/-rip/g, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch (e) {
    return 'Unknown Game';
  }
}

/**
 * UploadHaven Resolver utilizing instant timer zeroing (`window.seconds = 0`)
 */
function resolveUploadHavenViaBrowser(uploadHavenUrl) {
  return new Promise((resolve, reject) => {
    console.log(`[UploadHaven] Resolving: ${uploadHavenUrl}`);

    const win = new BrowserWindow({
      width: 1024,
      height: 700,
      show: false,
      title: 'Muncher - Resolving Download Link',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    });

    let resolved = false;

    const cleanup = () => {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('UploadHaven resolution timed out. Cloudflare verification may be required.'));
      }
    }, 45000);

    function attachDownloadInterceptor(contents) {
      contents.session.once('will-download', (event, item) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const downloadUrl = item.getURL();
          event.preventDefault();
          cleanup();
          console.log(`[UploadHaven] Captured Direct URL: ${downloadUrl}`);
          resolve(downloadUrl);
        }
      });
    }

    attachDownloadInterceptor(win.webContents);

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.includes('uploadhaven.com') || url.includes('/file/')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            show: false,
            webPreferences: { backgroundThrottling: false }
          }
        };
      }
      return { action: 'deny' };
    });

    win.webContents.on('did-create-window', (childWindow) => {
      attachDownloadInterceptor(childWindow.webContents);
    });

    win.loadURL(uploadHavenUrl, {
      userAgent: HEADERS['User-Agent'],
      httpReferrer: 'https://steamunlocked.org/'
    });

    win.webContents.on('did-finish-load', async () => {
      const title = win.getTitle();
      if (title.includes('Just a moment') || title.includes('Attention Required')) {
        console.log('[UploadHaven] Cloudflare challenge detected. Displaying window...');
        win.show();
        win.focus();
      }

      try {
        // Inject timer zeroing and auto-submit
        await win.webContents.executeJavaScript(`
          (function() {
            if (window.__muncherInjected) return;
            window.__muncherInjected = true;

            function bypassTimerAndSubmit() {
              // Override UploadHaven's global timer variable directly
              try { window.seconds = 0; } catch(e) {}

              const btn = document.querySelector('.btn-submit-free') || 
                          document.querySelector('button[type="submit"]') || 
                          document.querySelector('.btn-download') || 
                          document.querySelector('#downloadBtn');
              if (btn) {
                btn.disabled = false;
                btn.setAttribute('type', 'submit');
                btn.click();
                return true;
              }
              return false;
            }

            if (!bypassTimerAndSubmit()) {
              const timer = setInterval(() => {
                if (bypassTimerAndSubmit()) {
                  clearInterval(timer);
                }
              }, 500);
            }
          })();
        `);
      } catch (err) {
        // Context dynamic navigation safety
      }
    });
  });
}

/* ==========================================================================
   SteamUnlocked Module
   ========================================================================== */

async function searchSteamUnlocked(query) {
  const searchUrl = `${STEAMUNLOCKED_BASE}/?s=${encodeURIComponent(query)}`;
  const html = await fetchHtml(searchUrl, { 'Referer': `${STEAMUNLOCKED_BASE}/` });

  const results = [];
  const seenUrls = new Set();

  const containerRegex = /<div\b[^>]*class=["'][^"']*(?:cover-item|cover-box|blog-post)[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi;
  let match;

  while ((match = containerRegex.exec(html)) !== null) {
    const block = match[1];
    const linkMatch = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let url = null;
    let title = null;

    let aMatch;
    while ((aMatch = linkMatch.exec(block)) !== null) {
      const href = aMatch[1];
      const text = aMatch[2].replace(/<[^>]+>/g, '').trim();

      if ((href.includes('steamunlocked.org') || href.includes('steamunlocked.net')) && !isIgnoredUrl(href, STEAMUNLOCKED_BASE)) {
        url = href;
        if (text && text.length > 2) {
          title = text;
        }
      }
    }

    const imgMatch = /<img\b[^>]*src=["']([^"']+)["']/i.exec(block);
    const img = imgMatch ? imgMatch[1] : null;

    if (url && !seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({
        title: title || cleanTitleFromUrl(url),
        pageUrl: url,
        thumbnail: img,
        source: 'SteamUnlocked'
      });
    }
  }

  return results;
}

async function getSteamUnlockedDownloadLink(pageUrl) {
  const html = await fetchHtml(pageUrl, { 'Referer': `${STEAMUNLOCKED_BASE}/` });
  let hostUrl = null;

  const uploadHavenMatch = /href=["'](https?:\/\/(?:www\.)?uploadhaven\.com\/download\/[^"']+)["']/i.exec(html) ||
                             /href=["'](https?:\/\/(?:www\.)?uploadhaven\.com\/[^"']+)["']/i.exec(html);
  if (uploadHavenMatch) {
    hostUrl = uploadHavenMatch[1];
  }

  if (!hostUrl) {
    throw new Error('No UploadHaven link found on SteamUnlocked page.');
  }

  return await resolveUploadHavenViaBrowser(hostUrl);
}

/* ==========================================================================
   SteamRIP Module
   ========================================================================== */

async function searchSteamRIP(query) {
  const searchUrl = `${STEAMRIP_BASE}/?s=${encodeURIComponent(query)}`;
  const html = await fetchHtml(searchUrl, { 'Referer': `${STEAMRIP_BASE}/` });

  const results = [];
  const seenUrls = new Set();

  // Parse SteamRIP post cards
  const cardRegex = /<article\b[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const block = match[1];
    const linkMatch = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const imgMatch = /<img\b[^>]*src=["']([^"']+)["']/i.exec(block);

    if (linkMatch) {
      const url = linkMatch[1];
      const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();

      if (url && !isIgnoredUrl(url, STEAMRIP_BASE) && !seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({
          title: title || cleanTitleFromUrl(url),
          pageUrl: url,
          thumbnail: imgMatch ? imgMatch[1] : null,
          source: 'SteamRIP'
        });
      }
    }
  }

  return results;
}

async function getSteamRIPDownloadLink(pageUrl) {
  const html = await fetchHtml(pageUrl, { 'Referer': `${STEAMRIP_BASE}/` });

  // Priority hosts: GoFile, MegaDB, Buzzheavier, Qiwi, Rapidgator
  const hostRegex = /href=["'](https?:\/\/(?:www\.)?(?:gofile\.io|megadb\.net|buzzheavier\.com|qiwi\.gg|pixeldrain\.com|1fichier\.com)\/[^"']+)["']/gi;
  
  const links = [];
  let match;
  while ((match = hostRegex.exec(html)) !== null) {
    links.push(match[1]);
  }

  if (links.length === 0) {
    // General fallback for download links on page
    const fallbackRegex = /href=["'](https?:\/\/[^"']*(?:download|file|mega)[^"']*)["']/gi;
    while ((match = fallbackRegex.exec(html)) !== null) {
      if (!isIgnoredUrl(match[1], STEAMRIP_BASE)) {
        links.push(match[1]);
      }
    }
  }

  if (links.length === 0) {
    throw new Error('No download hosts found on SteamRIP page.');
  }

  // Returns the best available direct host link (GoFile / MegaDB preferred)
  return links[0];
}

/* ==========================================================================
   Unified Aggregator
   ========================================================================== */

async function searchAllSources(query) {
  const [steamunlockedResults, steamripResults] = await Promise.allSettled([
    searchSteamUnlocked(query),
    searchSteamRIP(query)
  ]);

  const results = [];
  if (steamripResults.status === 'fulfilled') {
    results.push(...steamripResults.value);
  }
  if (steamunlockedResults.status === 'fulfilled') {
    results.push(...steamunlockedResults.value);
  }

  return results;
}

async function getDownloadLink(pageUrl) {
  if (pageUrl.includes('steamrip.com')) {
    return await getSteamRIPDownloadLink(pageUrl);
  }
  if (pageUrl.includes('steamunlocked.org') || pageUrl.includes('steamunlocked.net')) {
    return await getSteamUnlockedDownloadLink(pageUrl);
  }
  if (pageUrl.includes('uploadhaven.com')) {
    return await resolveUploadHavenViaBrowser(pageUrl);
  }

  throw new Error('Unsupported source URL.');
}

module.exports = {
  searchSteamUnlocked,
  getSteamUnlockedDownloadLink,
  searchSteamRIP,
  getSteamRIPDownloadLink,
  searchAllSources,
  getDownloadLink,
  resolveUploadHavenViaBrowser
};