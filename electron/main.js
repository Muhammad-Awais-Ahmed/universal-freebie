const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const serve = require('electron-serve');
const serveApp = serve.default || serve;

const { searchArchiveOrg, getArchiveOrgDownload } = require('../src/backend/providers/archiveOrg');
const { searchFitGirl, getFitGirlDownload } = require('../src/backend/providers/fitGirl');
const { searchSteamUnlocked, getSteamUnlockedDownload } = require('../src/backend/providers/steamUnlocked');
const { searchApunKaGames, getApunKaGamesDownload } = require('../src/backend/providers/apunKaGames');
const { searchFileCR } = require('../src/backend/providers/fileCR');
const { searchModDB } = require('../src/backend/providers/moddb');
const { searchTheMovieBox, getTheMovieBoxEpisodes, getTheMovieBoxVideoUrl, getTheMovieBoxDownload } = require('../src/backend/providers/theMovieBox');
const Downloader = require('../src/backend/downloader');
const db = require('../src/backend/database');

let globalDownloader = null;

// ---------------------------------------------------------------
// Screen monitoring (consent-based, transparent)
// ---------------------------------------------------------------
// Captures ONLY this app's own window and sends low-frequency JPEG
// snapshots to an admin server. It never runs unless the user has
// explicitly consented at first launch, a visible "REC" indicator
// is shown while active, and the user can disable/revoke at any
// time from Settings. No desktop capture, no keylogging, no audio.
// ---------------------------------------------------------------
let monitorTimer = null;
let monitorLastSentAt = null;

function getMonitorConfig() {
  const settings = db.getSettings();
  return Object.assign(
    {
      consentAsked: false,
      consented: false,
      consentedAt: null,
      enabled: false,
      serverUrl: '',
      token: '',
      intervalMs: 15000,
      deviceId: '',
    },
    settings.monitoring || {}
  );
}

function saveMonitorConfig(patch) {
  const next = { ...getMonitorConfig(), ...patch };
  db.updateSettings({ monitoring: next });
  return next;
}

function getDeviceId() {
  const cfg = getMonitorConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  saveMonitorConfig({ deviceId: id });
  return id;
}

function broadcastMonitorStatus() {
  const cfg = getMonitorConfig();
  const status = {
    active: monitorTimer !== null,
    consentAsked: !!cfg.consentAsked,
    consented: !!cfg.consented,
    enabled: !!cfg.enabled,
    serverUrl: cfg.serverUrl || '',
    intervalMs: cfg.intervalMs || 15000,
    lastSentAt: monitorLastSentAt,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('monitor-status', status);
    }
  }
  return status;
}

function stopMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  broadcastMonitorStatus();
}

async function captureAndSendFrame() {
  if (!monitorTimer || !BrowserWindow.getAllWindows().length) return;
  const cfg = getMonitorConfig();
  if (!cfg.consented || !cfg.enabled || !cfg.serverUrl) return;

  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isDestroyed() || win.isMinimized()) return;
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return;
    const jpeg = image.toJPEG(70); // 70% quality, small frames

    const payload = {
      deviceId: getDeviceId(),
      app: 'universal-freebie',
      version: app.getVersion(),
      ts: new Date().toISOString(),
      frame: jpeg.toString('base64'),
    };

    const res = await fetch(cfg.serverUrl.replace(/\/+$/, '') + '/api/frames', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (cfg.token || ''),
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      monitorLastSentAt = new Date().toISOString();
      broadcastMonitorStatus();
    }
  } catch (err) {
    console.error('Monitor frame send failed:', err.message);
  }
}

function startMonitor() {
  const cfg = getMonitorConfig();
  if (!cfg.consented || !cfg.enabled || !cfg.serverUrl) return;
  stopMonitor();
  monitorTimer = setInterval(captureAndSendFrame, Math.max(5000, cfg.intervalMs || 15000));
  captureAndSendFrame();
  broadcastMonitorStatus();
}

// Monitor IPC -----------------------------------------------------
ipcMain.handle('get-monitor-status', () => broadcastMonitorStatus());

ipcMain.handle('set-monitor-consent', (event, consented) => {
  const cfg = saveMonitorConfig({
    consentAsked: true,
    consented: !!consented,
    consentedAt: consented ? new Date().toISOString() : null,
    enabled: consented ? cfg.enabled : false,
  });
  if (!consented) stopMonitor();
  else startMonitor();
  return broadcastMonitorStatus();
});

ipcMain.handle('set-monitoring', (event, patch) => {
  const clean = {};
  if ('enabled' in patch) clean.enabled = !!patch.enabled;
  if ('serverUrl' in patch) clean.serverUrl = String(patch.serverUrl || '').trim();
  if ('token' in patch) clean.token = String(patch.token || '').trim();
  if ('intervalMs' in patch) clean.intervalMs = Math.max(5000, parseInt(patch.intervalMs, 10) || 15000);
  saveMonitorConfig(clean);
  const cfg = getMonitorConfig();
  if (cfg.consented && cfg.enabled && cfg.serverUrl) startMonitor();
  else stopMonitor();
  return broadcastMonitorStatus();
});

// ---------------------------------------------------------------
// App startup
// ---------------------------------------------------------------
const isDev = process.env.NODE_ENV === 'development';
const loadURL = serveApp({ directory: 'out' });

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f172a',
      symbolColor: '#ffffff'
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  globalDownloader = new Downloader(mainWindow);

  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    if (globalDownloader) {
      globalDownloader.interceptElectronDownload(item);
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    loadURL(mainWindow);
  }

  // Start monitoring automatically only when the user has consented and enabled it
  mainWindow.webContents.on('did-finish-load', () => {
    const cfg = getMonitorConfig();
    if (cfg.consented && cfg.enabled && cfg.serverUrl) {
      startMonitor();
    }
    broadcastMonitorStatus();
  });
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showErrorBox('Uncaught Exception', error.stack || error.toString());
  app.quit();
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  dialog.showErrorBox('Unhandled Rejection', error.stack || error.toString());
  app.quit();
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => {
  console.error('Startup Error:', err);
  dialog.showErrorBox('Startup Error', err.stack || err.toString());
  app.quit();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('ping', () => 'pong');

// ---------------------------------------------------------------
// ApunKaGames automation (TheFilesLocker)
// ---------------------------------------------------------------

/**
 * Resolves the game page to TheFilesLocker parts, then downloads each part
 * sequentially. Only a small captcha window is shown to the user when
 * reCAPTCHA is required; everything else runs hidden.
 */
async function handleApunKaGamesDownload(gameUrl, gameData) {
  try {
    const info = await getApunKaGamesDownload(gameUrl);

    if (info.error || !info.parts || !info.parts.length) {
      return { error: info.error || 'No download parts found.' };
    }

    const totalParts = info.parts.length;
    const ids = [];

    for (let i = 0; i < totalParts; i++) {
      const part = info.parts[i];
      const partTitle = `${gameData.title || part.title} (Part ${i + 1} of ${totalParts})`;

      const result = await downloadTflPart(
        part,
        {
          ...gameData,
          title: partTitle,
          totalSize: info.totalSize,
          totalParts
        },
        i + 1,
        totalParts
      );

      if (result.error) {
        return {
          error: result.error,
          partsCompleted: ids.length,
          totalParts
        };
      }
      ids.push(result.id);
    }

    return { success: true, ids, count: ids.length };
  } catch (error) {
    console.error('ApunKaGames download error:', error.message);
    return { error: `ApunKaGames automation failed: ${error.message}` };
  }
}

/**
 * Downloads one TheFilesLocker part:
 *   file page (auto-submit op=download1, hidden)
 *   -> download2 page (show window if captcha; auto-submit once solved + countdown done)
 *   -> final /d/ link (intercepted via will-download -> downloader)
 */
function downloadTflPart(part, gameData, partIndex, totalParts) {
  return new Promise((resolve) => {
    const tflWindow = new BrowserWindow({
      width: 680,
      height: 600,
      title: 'Universal Freebie',
      show: false,
      backgroundColor: '#0f172a',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    tflWindow.setMenu(null);

    let partDone = false;

    tflWindow.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (title === 'SHOW_ME') {
        tflWindow.show();
      }
      if (title === 'HIDE_ME') {
        tflWindow.hide();
      }
    });

    tflWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Clean dark overlay while the window is hidden (progress only)
    tflWindow.webContents.on('dom-ready', () => {
      tflWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('ugc-tfl-overlay')) return;
          const overlay = document.createElement('div');
          overlay.id = 'ugc-tfl-overlay';
          overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #0f172a; z-index: 2147483640; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;';
          const titleNode = document.createElement('h2');
          titleNode.innerText = 'Universal Freebie';
          titleNode.style.cssText = 'color: #fff; margin-bottom: 20px; font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #f97316 0%, #eab308 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;';
          overlay.appendChild(titleNode);
          const partText = document.createElement('div');
          partText.innerText = 'Part ${partIndex} of ${totalParts}';
          partText.style.cssText = 'color: #94a3b8; font-size: 14px; margin-bottom: 10px;';
          overlay.appendChild(partText);
          const statusText = document.createElement('div');
          statusText.id = 'ugc-tfl-status';
          statusText.innerText = 'Connecting to TheFilesLocker...';
          statusText.style.cssText = 'color: #22c55e; font-size: 20px; font-weight: bold; margin-bottom: 10px;';
          overlay.appendChild(statusText);
          const subText = document.createElement('div');
          subText.id = 'ugc-tfl-sub';
          subText.innerText = 'Please wait.';
          subText.style.cssText = 'color: #94a3b8; font-size: 14px;';
          overlay.appendChild(subText);
          document.body.appendChild(overlay);

          const shieldCss = document.createElement('style');
          shieldCss.textContent = '.g-recaptcha, iframe[src*="recaptcha"] { position: relative !important; z-index: 2147483641 !important; }';
          document.head.appendChild(shieldCss);

          // Keep the branded overlay ALWAYS visible. Never remove it: expose ONLY
          // the captcha widget by punching a click-hole around it and blocking
          // clicks on the raw website behind the overlay.
          window.ugcShieldCaptcha = function() {
            try {
              const captchaEl = document.querySelector('iframe[src*="recaptcha/api2/bframe"]') ||
                                document.querySelector('.g-recaptcha') ||
                                document.querySelector('iframe[src*="recaptcha"]');
              const overlayEl = document.getElementById('ugc-tfl-overlay') || document.getElementById('ugc-clean-overlay');
              if (!captchaEl || (captchaEl.offsetWidth === 0 && captchaEl.offsetHeight === 0)) return;
              if (overlayEl) overlayEl.style.pointerEvents = 'none';
              const r = captchaEl.getBoundingClientRect();
              const pad = 8;
              const x1 = Math.max(0, r.left - pad);
              const y1 = Math.max(0, r.top - pad);
              const x2 = Math.min(window.innerWidth, r.right + pad);
              const y2 = Math.min(window.innerHeight, r.bottom + pad);
              const W = window.innerWidth, H = window.innerHeight;
              let wrap = document.getElementById('ugc-shield-strips');
              if (!wrap) {
                wrap = document.createElement('div');
                wrap.id = 'ugc-shield-strips';
                wrap.style.cssText = 'position: fixed; inset: 0; z-index: 2147483640; pointer-events: none;';
                document.body.appendChild(wrap);
              }
              wrap.innerHTML = '';
              const mk = (top, left, w, h) => {
                if (w <= 0 || h <= 0) return;
                const d = document.createElement('div');
                d.style.cssText = 'position: fixed; top:' + top + 'px; left:' + left + 'px; width:' + w + 'px; height:' + h + 'px; background: transparent; pointer-events: auto;';
                wrap.appendChild(d);
              };
              mk(0, 0, W, y1);
              mk(y2, 0, W, H - y2);
              mk(y1, 0, x1, y2 - y1);
              mk(y1, x2, W - x2, y2 - y1);
            } catch (e) { /* ignore */ }
          };
        })();
      `).catch(() => {});
    });

    tflWindow.webContents.on('did-finish-load', () => {
      tflWindow.webContents.executeJavaScript(`
        setInterval(() => {
          try {
            const statusEl = document.getElementById('ugc-tfl-status');
            const setStatus = (msg) => { if (statusEl) statusEl.innerText = msg; };

            // ---- Step 1: file page -> submit op=download1 (hidden) ----
            const dl1 = document.querySelector('input[name="op"][value="download1"]');
            if (dl1 && !window.ugcSubmitted) {
              window.ugcSubmitted = true;
              setStatus('Bypassing TheFilesLocker ads...');
              setTimeout(() => {
                const form = dl1.closest('form');
                if (form) form.submit();
                else dl1.click();
              }, 800);
              return;
            }

            // ---- Step 2: download2 page (captcha + create button) ----
            const dl2 = document.querySelector('input[name="op"][value="download2"]');

            if (dl2) {
              const hasCaptcha = document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
              if (hasCaptcha) {
                document.title = 'SHOW_ME';
                setStatus('Please solve the captcha to continue');
                if (window.ugcShieldCaptcha) window.ugcShieldCaptcha();
              }

              const btn = document.getElementById('downloadbtn') || document.querySelector('.download-btn') || document.querySelector('input[value*="Create"]');
              if (!btn || btn.disabled || btn.style.display === 'none') return;

              // The page disables the button during the countdown; only submit once
              // the button is enabled AND the captcha is solved (or not required).
              const captchaOk = !hasCaptcha || (window.grecaptcha && window.grecaptcha.getResponse && window.grecaptcha.getResponse().length > 0);
              if (!captchaOk) return;

              if (!window.ugcCreateAt) {
                window.ugcCreateAt = Date.now();
                setStatus('Finalizing download link...');
                return;
              }
              if (Date.now() - window.ugcCreateAt < 5000) return;

              if (!window.ugcCreating) {
                window.ugcCreating = true;
                setStatus('Creating download link...');
                setTimeout(() => {
                  const form = btn.closest('form');
                  if (form) form.submit();
                  else btn.click();
                  window.ugcSubmittedDl2 = true;
                  document.title = 'HIDE_ME';
                  setTimeout(() => { window.ugcCreating = false; }, 5000);
                }, 500);
              }
              return;
            }

            // ---- Final direct link: ONLY looked for after download2 was submitted ----
            if (window.ugcSubmittedDl2 && !window.ugcFinalClicked) {
              const finalLink = document.querySelector('a#download_link, a.btn-primary[href*="/d/"], a.btn-download, a[href*="/d/"]');
              if (finalLink && finalLink.href) {
                window.ugcFinalClicked = true;
                setStatus('Intercepting secure download link...');
                setTimeout(() => { window.location.href = finalLink.href; }, 600);
              }
            }
          } catch (e) {
            console.error('TFL auto-clicker error:', e);
          }
        }, 800);
      `).catch(() => {});
    });

    const session = tflWindow.webContents.session;

    const downloadHandler = async (e, item, webContents) => {
      const finalUrl = item.getURL();
      const finalFilename = item.getFilename();
      const lowerFilename = finalFilename.toLowerCase();

      const isValidGameArchive = lowerFilename.endsWith('.zip') || lowerFilename.endsWith('.rar') || lowerFilename.endsWith('.7z') || lowerFilename.endsWith('.iso') || lowerFilename.endsWith('.exe') || /\.part\d+\./i.test(lowerFilename) || lowerFilename.endsWith('.001');

      if (!isValidGameArchive) {
        console.warn('Blocked non-archive payload:', finalFilename);
        item.cancel();
        return;
      }

      e.preventDefault();

      let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
      let refererUrl = '';
      try {
        userAgent = tflWindow.webContents.getUserAgent();
        refererUrl = webContents.getURL();
      } catch (err) {
        console.warn('Window closed before capturing headers, using defaults.');
      }

      const cookies = await session.cookies.get({ url: finalUrl });
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      partDone = true;
      clearTimeout(tflTimeout);
      session.removeListener('will-download', downloadHandler);
      if (!tflWindow.isDestroyed()) tflWindow.close();

      if (globalDownloader) {
        const meta = {
          ...gameData,
          customHeaders: {
            'Cookie': cookieString,
            'User-Agent': userAgent,
            'Referer': refererUrl
          }
        };
        const id = globalDownloader.startHttpDownload(finalUrl, finalFilename, meta);
        resolve({ success: true, id });
      } else {
        resolve({ error: 'Downloader not initialized' });
      }
    };

    session.on('will-download', downloadHandler);

    // Timeout: auto-close after 120s to prevent hanging forever
    const tflTimeout = setTimeout(() => {
      if (!tflWindow.isDestroyed()) {
        tflWindow.close();
      }
    }, 120000);

    tflWindow.on('closed', () => {
      clearTimeout(tflTimeout);
      if (!partDone) {
        session.removeListener('will-download', downloadHandler);
        resolve({ error: 'Window closed before download started (timeout or manual close).' });
      }
    });

    tflWindow.loadURL(part.url).catch((err) => {
      console.warn('TFL window load failed:', err.message);
      if (!tflWindow.isDestroyed()) tflWindow.close();
    });
  });
}

// Download IPC
ipcMain.handle('start-download', async (event, gameOrUrl, source, gameData) => {
  // Support single object format from frontend: ipcRenderer.send('start-download', game)
  if (typeof gameOrUrl === 'object' && gameOrUrl !== null) {
    const game = gameOrUrl;
    source = game.source;
    gameData = game;
    gameOrUrl = game.url || game.id;
  }

  if (!globalDownloader) return { error: 'Downloader not initialized' };

  const settings = db.getSettings();
  if (!settings.hasPromptedForDirectory) {
    const result = await dialog.showOpenDialog({
      title: 'First Time Setup: Select Download Directory',
      defaultPath: settings.downloadDirectory,
      properties: ['openDirectory']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      settings.downloadDirectory = result.filePaths[0];
    }
    settings.hasPromptedForDirectory = true;
    db.updateSettings(settings);
    
    if (globalDownloader) {
      globalDownloader.downloadsDir = settings.downloadDirectory;
      if (!fs.existsSync(globalDownloader.downloadsDir)) {
        fs.mkdirSync(globalDownloader.downloadsDir, { recursive: true });
      }
    }
  }

  let downloadInfo = null;

  if (source === 'Archive.org') {
    // gameOrUrl might be a URL or just an identifier string
    let identifier = gameData.id;
    try {
      const parsed = new URL(gameOrUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      // URL like https://archive.org/details/IDENTIFIER => parts = ['details', 'IDENTIFIER']
      identifier = parts[1] || parts[0] || gameData.id;
    } catch {
      // gameOrUrl is not a URL, use it as identifier
      identifier = gameOrUrl || gameData.id;
    }
    downloadInfo = await getArchiveOrgDownload(identifier);
  } else if (source === 'FitGirl') {
    downloadInfo = await getFitGirlDownload(gameOrUrl);
  } else if (source === 'SteamUnlocked') {
    downloadInfo = await getSteamUnlockedDownload(gameOrUrl);
  } else if (source === 'TheMovieBox') {
    const startEpisode = gameData.startEpisode || 1;
    const endEpisode = gameData.endEpisode || null;
    const result = await getTheMovieBoxDownload(gameOrUrl, startEpisode, endEpisode);
    
    if (result.error) {
      return { error: result.error };
    }
    
    if (result.episodes && result.episodes.length > 0) {
      const downloadIds = [];
      for (const ep of result.episodes) {
        const id = globalDownloader.startHttpDownload(ep.url, ep.filename, {
          ...gameData,
          customHeaders: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': ep.url
          }
        });
        downloadIds.push(id);
      }
      return { success: true, ids: downloadIds, count: downloadIds.length };
    }
    
    return { error: 'No downloadable episodes found' };
  } else if (source === 'ApunKaGames') {
    return await handleApunKaGamesDownload(gameOrUrl, gameData);
  } else if (source === 'FileCR' || source === 'ModDB') {
    return new Promise((resolve) => {
      const siteWindow = new BrowserWindow({
        width: 600,
        height: 450,
        title: 'Universal Freebie',
        show: false,
        backgroundColor: '#0f172a',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      
      siteWindow.setMenu(null);
      
      siteWindow.on('page-title-updated', (e, title) => {
        e.preventDefault();
        if (title === 'SHOW_ME') {
          siteWindow.show();
        }
      });

      siteWindow.webContents.setWindowOpenHandler(({ url }) => {
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('thefileslocker') || lowerUrl.includes('apunkagames') || lowerUrl.includes('akglinks') || lowerUrl.includes('apunkasoftware') || lowerUrl.includes('uploadhaven') || lowerUrl.includes('send.cm')) {
           siteWindow.loadURL(url);
        }
        return { action: 'deny' };
      });

      siteWindow.loadURL(gameOrUrl);

      siteWindow.webContents.on('dom-ready', () => {
        siteWindow.webContents.executeJavaScript(`
          (function() {
            if (!document.getElementById('ugc-clean-overlay')) {
              const overlay = document.createElement('div');
              overlay.id = 'ugc-clean-overlay';
              overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #0f172a; z-index: 2147483640; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;';
              
              const titleNode = document.createElement('h2');
              titleNode.innerText = 'Universal Freebie';
              titleNode.style.cssText = 'color: #fff; margin-bottom: 20px; font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #f97316 0%, #eab308 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;';
              overlay.appendChild(titleNode);

              const statusText = document.createElement('div');
              statusText.id = 'ugc-custom-timer';
              statusText.innerText = 'Bypassing ads & fetching download...';
              statusText.style.cssText = 'color: #22c55e; font-size: 20px; font-weight: bold; margin-bottom: 10px;';
              overlay.appendChild(statusText);

              const subText = document.createElement('div');
              subText.innerText = 'Please wait up to 15 seconds.';
              subText.style.cssText = 'color: #94a3b8; font-size: 14px;';
              overlay.appendChild(subText);

              document.body.appendChild(overlay);

              const shieldCss = document.createElement('style');
              shieldCss.textContent = '.g-recaptcha, iframe[src*="recaptcha"] { position: relative !important; z-index: 2147483641 !important; }';
              document.head.appendChild(shieldCss);

              // Keep the branded overlay ALWAYS visible; expose ONLY the captcha
              // widget by punching a click-hole and blocking clicks on the site.
              window.ugcShieldCaptcha = function() {
                try {
                  const captchaEl = document.querySelector('iframe[src*="recaptcha/api2/bframe"]') ||
                                    document.querySelector('.g-recaptcha') ||
                                    document.querySelector('iframe[src*="recaptcha"]');
                  const overlayEl = document.getElementById('ugc-clean-overlay') || document.getElementById('ugc-tfl-overlay');
                  if (!captchaEl || (captchaEl.offsetWidth === 0 && captchaEl.offsetHeight === 0)) return;
                  if (overlayEl) overlayEl.style.pointerEvents = 'none';
                  const r = captchaEl.getBoundingClientRect();
                  const pad = 8;
                  const x1 = Math.max(0, r.left - pad);
                  const y1 = Math.max(0, r.top - pad);
                  const x2 = Math.min(window.innerWidth, r.right + pad);
                  const y2 = Math.min(window.innerHeight, r.bottom + pad);
                  const W = window.innerWidth, H = window.innerHeight;
                  let wrap = document.getElementById('ugc-shield-strips');
                  if (!wrap) {
                    wrap = document.createElement('div');
                    wrap.id = 'ugc-shield-strips';
                    wrap.style.cssText = 'position: fixed; inset: 0; z-index: 2147483640; pointer-events: none;';
                    document.body.appendChild(wrap);
                  }
                  wrap.innerHTML = '';
                  const mk = (top, left, w, h) => {
                    if (w <= 0 || h <= 0) return;
                    const d = document.createElement('div');
                    d.style.cssText = 'position: fixed; top:' + top + 'px; left:' + left + 'px; width:' + w + 'px; height:' + h + 'px; background: transparent; pointer-events: auto;';
                    wrap.appendChild(d);
                  };
                  mk(0, 0, W, y1);
                  mk(y2, 0, W, H - y2);
                  mk(y1, 0, x1, y2 - y1);
                  mk(y1, x2, W - x2, y2 - y1);
                } catch (e) { /* ignore */ }
              };

              document.title = 'SHOW_ME';
            }
          })();
        `).catch(err => console.error('Overlay injection failed:', err));
      });
      
      siteWindow.webContents.on('did-finish-load', () => {
        siteWindow.webContents.executeJavaScript(`
          setInterval(() => {
            try {
              const timerEl = document.getElementById('ugc-custom-timer');
              const setStatus = (msg) => { if (timerEl) timerEl.innerText = msg; };
              
              if (!window.ugcStatusSet) {
                 const host = window.location.hostname;
                 if (host.includes('apunkagames')) setStatus('Scanning ApunKaGames for download links...');
                 else if (host.includes('akglinks')) setStatus('Bypassing ad-link shortener...');
                 else if (host.includes('apunkasoftware')) setStatus('Navigating intermediate download pages...');
                 else if (host.includes('thefileslocker')) setStatus('Bypassing TheFilesLocker ads...');
                 window.ugcStatusSet = true;
              }

              const dynamicCaptcha = document.querySelector('#cf-please-wait, #challenge-stage, iframe[src*="recaptcha"], iframe[src*="turnstile"], .g-recaptcha');
              if (dynamicCaptcha) {
                const captchaSolved = window.grecaptcha && window.grecaptcha.getResponse && window.grecaptcha.getResponse().length > 0;
                if (!captchaSolved) {
                  document.title = 'SHOW_ME';
                  const timerEl = document.getElementById('ugc-custom-timer');
                  if (timerEl) timerEl.innerText = 'Please complete the captcha to continue';
                  if (window.ugcShieldCaptcha) window.ugcShieldCaptcha();
                  return;
                }
              }

              if (window.hasClicked) return;

              const apunLinks = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"], a#dlink')).filter(el => {
                const text = (el.innerText || el.textContent || el.value || '').toLowerCase();
                const hasProceedImg = el.querySelector ? el.querySelector('img[src*="proceed"]') : null;
                return text.includes('click here to download') || text.includes('proceed to download') || text.includes('download now') || text.includes('download this game') || hasProceedImg || el.id === 'dlink';
              });
              
              if (apunLinks.length > 0) {
                const target = apunLinks[0];
                if (!target.disabled && target.offsetWidth > 0 && target.offsetHeight > 0) {
                  setStatus('Found download link! Waiting 5s...');
                  window.hasClicked = true;
                  
                  setTimeout(() => {
                    setStatus('Proceeding...');
                    if (target.tagName.toLowerCase() === 'a' && target.href) {
                      window.location.href = target.href;
                    } else {
                      const form = target.closest('form');
                      if (form) {
                         form.submit();
                      } else {
                         target.removeAttribute('target');
                         target.click();
                      }
                    }
                    setTimeout(() => { window.hasClicked = false; }, 4000);
                  }, 5000);
                }
                return;
              }
              
              if (window.location.hostname.includes('thefileslocker')) {
                const methodFreeBtn = document.querySelector('input[name="method_free"], button[name="method_free"]');
                if (methodFreeBtn && !methodFreeBtn.disabled) {
                  setStatus('Bypassing clickjack overlay! Waiting 5s...');
                  window.hasClicked = true;
                  setTimeout(() => {
                    setStatus('Proceeding...');
                    const form = methodFreeBtn.closest('form');
                    if (form) form.submit();
                    else methodFreeBtn.click();
                    setTimeout(() => { window.hasClicked = false; }, 4000);
                  }, 5000);
                  return;
                }
                
                const createBtn = document.getElementById('download') || document.querySelector('.download-btn') || document.querySelector('#downloadbtn, input[value*="Create"]');
                const hasCaptcha = document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
                const captchaOk2 = !hasCaptcha || (window.grecaptcha && window.grecaptcha.getResponse && window.grecaptcha.getResponse().length > 0);
                
                if (createBtn && !createBtn.disabled && createBtn.style.display !== 'none' && captchaOk2) {
                  setStatus('Generating final download link! Waiting 5s...');
                  window.hasClicked = true;
                  setTimeout(() => {
                    setStatus('Proceeding...');
                    const form = createBtn.closest('form');
                    if (form) form.submit();
                    else createBtn.click();
                    window.ugcSgSubmitted = true;
                    setTimeout(() => { window.hasClicked = false; }, 4000);
                  }, 5000);
                  return;
                }
                
                // Final direct link: only look for it AFTER "Create" was submitted,
                // so ad links on the create page can't hijack the flow.
                if (window.ugcSgSubmitted) {
                  const finalLink = document.querySelector('a.btn-primary[href*="/d/"], a.download-link, a#download_link, a.btn-download, a[href*="/d/"]');
                  if (finalLink && !finalLink.disabled && finalLink.href) {
                    setStatus('Intercepting raw game file! Waiting 5s...');
                    window.hasClicked = true;
                    setTimeout(() => {
                      setStatus('Downloading...');
                      window.location.href = finalLink.href;
                      setTimeout(() => { window.hasClicked = false; }, 4000);
                    }, 5000);
                    return;
                  }
                }
              }
            } catch (e) {
               console.error('Auto-clicker error:', e);
            }
          }, 1000);
        `).catch(err => console.error('Script injection failed:', err));
      });
      
      const session = siteWindow.webContents.session;
      
      const downloadHandler = async (e, item, webContents) => {
        const finalUrl = item.getURL();
        const finalFilename = item.getFilename();
        const lowerFilename = finalFilename.toLowerCase();
        
        const isValidGameArchive = lowerFilename.endsWith('.zip') || lowerFilename.endsWith('.rar') || lowerFilename.endsWith('.7z') || lowerFilename.endsWith('.iso');
        
        if (!isValidGameArchive) {
          console.warn('Blocked malicious ad/tracker payload:', finalFilename);
          item.cancel();
          return;
        }

        e.preventDefault();
        
        let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        let refererUrl = '';
        try {
          userAgent = siteWindow.webContents.getUserAgent();
          refererUrl = webContents.getURL();
        } catch (e) {
          console.warn('Window closed before capturing headers, using defaults.');
        }

        const cookies = await session.cookies.get({ url: finalUrl });
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        if (globalDownloader) {
          const gameMetaWithHeaders = {
            ...gameData,
            customHeaders: {
              'Cookie': cookieString,
              'User-Agent': userAgent,
              'Referer': refererUrl
            }
          };
          const id = globalDownloader.startHttpDownload(finalUrl, finalFilename, gameMetaWithHeaders);
          clearTimeout(siteTimeout);
          resolve({ success: true, id });
        } else {
          resolve({ error: 'Downloader not initialized' });
        }
        
        session.removeListener('will-download', downloadHandler);
        siteWindow.close();
      };
      
      session.on('will-download', downloadHandler);
      
      // Timeout: auto-close after 90s to prevent hanging forever
      const siteTimeout = setTimeout(() => {
        if (!siteWindow.isDestroyed()) {
          siteWindow.close();
        }
      }, 90000);

      siteWindow.on('closed', () => {
        clearTimeout(siteTimeout);
        resolve({ error: 'Window closed before download started (timeout or manual close).' });
      });
    });
  }

  if (!downloadInfo) {
    return { error: 'Could not resolve download link.' };
  }

  if (downloadInfo.isUploadHaven) {
    return new Promise((resolve) => {
      const captchaWindow = new BrowserWindow({
        width: 600,
        height: 450,
        title: 'Universal Freebie',
        show: false,
        backgroundColor: '#0f172a',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      
      captchaWindow.setMenu(null);
      
      captchaWindow.on('page-title-updated', (e, title) => {
        e.preventDefault();
        if (title === 'SHOW_ME') {
          captchaWindow.show();
        }
      });
      
      captchaWindow.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
      });
      
      captchaWindow.webContents.on('dom-ready', () => {
        captchaWindow.webContents.executeJavaScript(`
          (function() {
            const cfWait = document.querySelector('#cf-please-wait, #challenge-stage, iframe');
            if (cfWait) {
              document.title = 'SHOW_ME';
            }
            
            const freeInput = document.querySelector('input[name="type"][value="free"]');
            if (freeInput) {
              freeInput.closest('form').submit();
              return;
            }
            
            if (!document.getElementById('ugc-clean-overlay')) {
              const overlay = document.createElement('div');
              overlay.id = 'ugc-clean-overlay';
              overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #0f172a; z-index: 2147483640; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;';
              
              const titleEl = document.querySelector('h1, h2, .h1, .h2');
              if (titleEl) {
                const titleClone = titleEl.cloneNode(true);
                titleClone.style.color = '#fff';
                titleClone.style.marginBottom = '40px';
                titleClone.style.fontSize = '2rem';
                titleClone.style.fontWeight = 'bold';
                overlay.appendChild(titleClone);
              }
              
              document.body.appendChild(overlay);
              
              const finalForm = document.querySelector('form[action*="/download/"]');
              const cfWait = document.querySelector('#cf-please-wait, #challenge-stage, iframe[src*="cloudflare"]');
              
              if (cfWait) {
                if (finalForm) {
                  finalForm.style.position = 'relative';
                  finalForm.style.zIndex = '2147483647';
                  finalForm.style.background = 'transparent';
                  const innerBg = finalForm.querySelector('.bg-white, .card');
                  if (innerBg) { innerBg.style.background = 'transparent'; innerBg.style.border = 'none'; innerBg.style.boxShadow = 'none'; }
                }
                cfWait.style.position = 'relative';
                cfWait.style.zIndex = '2147483647';
                document.title = 'SHOW_ME';
              } else if (finalForm) {
                finalForm.style.opacity = '0.001';
                finalForm.style.position = 'absolute';
                finalForm.style.top = '-9999px';
                finalForm.style.pointerEvents = 'none';
                
                const timerUI = document.createElement('div');
                timerUI.id = 'ugc-custom-timer';
                timerUI.style.fontSize = '1.8rem';
                timerUI.style.color = '#10b981';
                timerUI.style.fontWeight = 'bold';
                timerUI.style.marginTop = '10px';
                timerUI.innerText = 'Initializing...';
                
                const statusText = document.createElement('div');
                statusText.style.marginTop = '10px';
                statusText.style.fontSize = '1rem';
                statusText.style.color = '#94a3b8';
                statusText.innerText = 'Universal Freebie - Automatically preparing your download...';
                
                overlay.appendChild(timerUI);
                overlay.appendChild(statusText);
                
                document.title = 'SHOW_ME';
              }
            }
          })();
        `).catch(err => console.error('Overlay injection error:', err));
      });
      
      captchaWindow.webContents.on('did-finish-load', () => {
        captchaWindow.webContents.executeJavaScript(`
          setInterval(() => {
            const finalBtn = document.querySelector('form[action*="/download/"] button');
            const realTimer = document.querySelector('.download-timer, [id*="timer"]');
            const fakeTimer = document.getElementById('ugc-custom-timer');
            
            if (realTimer && fakeTimer && realTimer.innerText.toLowerCase().includes('wait')) {
               fakeTimer.innerText = realTimer.innerText.replace('seconds', 's');
            }
            
            if (finalBtn && !finalBtn.disabled) {
              if (fakeTimer) {
                 fakeTimer.innerText = 'Starting Download...';
                 fakeTimer.nextElementSibling.innerText = 'Intercepting secure URL...';
              }
              finalBtn.click();
            }
          }, 500);
        `).catch(err => console.error('Auto-clicker error:', err));
      });

      captchaWindow.loadURL(downloadInfo.url, {
        httpReferrer: gameOrUrl
      });

      const session = captchaWindow.webContents.session;
      
      const downloadHandler = async (e, item, webContents) => {
        e.preventDefault();
        const finalUrl = item.getURL();
        const finalFilename = item.getFilename();
        
        const cookies = await session.cookies.get({ url: finalUrl });
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const userAgent = captchaWindow.webContents.getUserAgent();
        
        if (globalDownloader) {
          const gameMetaWithHeaders = {
            ...gameData,
            customHeaders: {
              'Cookie': cookieString,
              'User-Agent': userAgent,
              'Referer': downloadInfo.url
            }
          };
          const id = globalDownloader.startHttpDownload(finalUrl, finalFilename, gameMetaWithHeaders);
          clearTimeout(captchaTimeout);
          resolve({ success: true, id });
        } else {
          resolve({ error: 'Downloader not initialized' });
        }
        
        session.removeListener('will-download', downloadHandler);
        captchaWindow.close();
      };
      
      session.on('will-download', downloadHandler);
      
      // Timeout: auto-close after 90s to prevent hanging forever
      const captchaTimeout = setTimeout(() => {
        if (!captchaWindow.isDestroyed()) {
          captchaWindow.close();
        }
      }, 90000);

      captchaWindow.on('closed', () => {
        clearTimeout(captchaTimeout);
        resolve({ error: 'Verification window closed before download started.' });
      });
    });
  }

  if (downloadInfo.isTorrent) {
    const id = globalDownloader.startTorrentDownload(downloadInfo.url, gameData);
    return { success: true, id };
  } else {
    const id = globalDownloader.startHttpDownload(downloadInfo.url, downloadInfo.filename, gameData);
    return { success: true, id };
  }
});

ipcMain.handle('cancel-download', (event, id) => {
  if (globalDownloader) {
    globalDownloader.cancelDownload(id);
  }
});

ipcMain.handle('resume-download', (event, id) => {
  if (globalDownloader) {
    globalDownloader.resumeDownload(id);
  }
});

ipcMain.handle('continue-download', (event, id) => {
  if (globalDownloader) {
    return globalDownloader.resumeFromHistory(id);
  }
  return { error: 'Downloader not initialized' };
});

ipcMain.handle('retry-download', (event, id) => {
  if (globalDownloader) {
    globalDownloader.retryDownload(id);
  }
});

ipcMain.handle('remove-download', (event, id) => {
  if (globalDownloader) {
    globalDownloader.removeDownload(id);
  }
});

ipcMain.handle('get-partial-downloads', () => {
  return db.getPartialDownloads();
});

// Settings IPC
ipcMain.handle('get-settings', () => db.getSettings());

ipcMain.handle('save-settings', (event, newSettings) => {
  const updated = db.updateSettings(newSettings);
  if (globalDownloader && newSettings.downloadDirectory) {
    globalDownloader.downloadsDir = newSettings.downloadDirectory;
    if (!fs.existsSync(globalDownloader.downloadsDir)) {
      fs.mkdirSync(globalDownloader.downloadsDir, { recursive: true });
    }
  }
  return updated;
});

ipcMain.handle('get-download-dir', () => {
  return db.getSettings().downloadDirectory;
});

ipcMain.handle('choose-download-dir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-download-dir', () => {
  const dir = db.getSettings().downloadDirectory;
  shell.openPath(dir);
});

// Library: Downloads IPC
ipcMain.handle('get-download-history', () => db.getDownloadHistory());

ipcMain.handle('get-folder-contents', () => {
  const dir = db.getSettings().downloadDirectory;
  if (!fs.existsSync(dir)) return [];
  
  try {
    const files = fs.readdirSync(dir);
    return files.map(filename => {
      const fullPath = path.join(dir, filename);
      const stat = fs.statSync(fullPath);
      return {
        name: filename,
        path: fullPath,
        isDirectory: stat.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
    });
  } catch (err) {
    console.error('Error reading download dir:', err);
    return [];
  }
});

ipcMain.handle('open-folder', (event, itemPath) => {
  shell.showItemInFolder(itemPath);
});

ipcMain.handle('delete-file', (event, itemPath) => {
  try {
    if (fs.existsSync(itemPath)) {
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) {
        fs.rmSync(itemPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(itemPath);
      }
      return true;
    }
  } catch (err) {
    console.error('Delete error:', err);
  }
  return false;
});

// Library: Installed Games IPC
ipcMain.handle('get-installed-games', () => db.getInstalledGames());

ipcMain.handle('add-installed-game', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Executables', extensions: ['exe'] }]
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const exePath = result.filePaths[0];
    const name = path.basename(exePath, '.exe');
    
    const game = { name, executablePath: exePath };
    db.addInstalledGame(game);
    return true;
  }
  return false;
});

ipcMain.handle('remove-installed-game', (event, id) => {
  db.removeInstalledGame(id);
  return true;
});

ipcMain.handle('launch-game', (event, exePath) => {
  try {
    const gameDir = path.dirname(exePath);
    spawn(exePath, [], { cwd: gameDir, detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (err) {
    console.error('Launch error:', err);
    return false;
  }
});

// Game Search IPC
ipcMain.handle('search-games', async (event, query, sources) => {
  try {
    // Support both array format ["archive", "fitgirl"] and object format { archive: true }
    const src = Array.isArray(sources)
      ? sources.reduce((acc, key) => ({ ...acc, [key]: true }), {})
      : (sources || {});

    const promises = [];
    
    if (src.archive) promises.push(searchArchiveOrg(query));
    if (src.fitgirl) promises.push(searchFitGirl(query));
    if (src.steamunlocked) promises.push(searchSteamUnlocked(query));
    if (src.apunkagames) promises.push(searchApunKaGames(query));
    if (src.filecr) promises.push(searchFileCR(query));

    // If no sources selected, search all
    if (promises.length === 0) {
      promises.push(searchArchiveOrg(query), searchFitGirl(query), searchSteamUnlocked(query), searchApunKaGames(query), searchFileCR(query));
    }

    const resultsArray = await Promise.all(promises);
    return resultsArray.flat();
  } catch (error) {
    console.error('Unified Game Search failed:', error);
    return [];
  }
});

// Mods Search IPC
ipcMain.handle('search-mods', async (event, query) => {
  try {
    return await searchModDB(query);
  } catch (error) {
    console.error('Mod Search failed:', error);
    return [];
  }
});
