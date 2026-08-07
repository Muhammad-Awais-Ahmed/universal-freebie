const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const serve = require('electron-serve');
const serveApp = serve.default || serve;

const { searchArchiveOrg, getArchiveOrgFiles } = require('../src/backend/providers/archiveOrg');
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
// Debug mode: shows the hidden automation windows (siteWindow,
// tflWindow, captchaWindow) so you can watch exactly which page the
// flow is stuck on. ON by default; disable by launching with
// UGC_DEBUG=0 or by changing this line to false.
// ---------------------------------------------------------------
const UGC_DEBUG = process.env.UGC_DEBUG !== '0';

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
    // The embedded ApunKaGames system: resolve the download chain server-side
    // (nothing on screen), then for each part open the app's own signature
    // screen - countdown timer + captcha + download button - and grab the file.
    const info = await getApunKaGamesDownload(gameUrl);

    if (info.error || !info.parts || !info.parts.length) {
      // Fallback: replay the recorded one-time flow for games the server-side
      // resolver cannot handle. (delete userData/apunkagames-flow.json to
      // re-record it.)
      console.warn('ApunKaGames provider could not resolve parts, falling back to replay:', info.error);
      let flow = loadRecordedFlow();
      if (!flow) {
        flow = await recordApunKaGamesFlow(gameUrl, gameData);
        if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) {
          return { error: 'ApunKaGames recording was cancelled before any clicks were captured. Start the download again to retry.' };
        }
        saveRecordedFlow(flow);
      }
      const replayResult = await replayApunKaGamesFlow(flow, gameUrl, gameData);
      if (replayResult.error) {
        return { error: replayResult.error };
      }
      return replayResult;
    }

    const ids = [];
    const totalParts = info.parts.length;

    for (let i = 0; i < totalParts; i++) {
      const part = info.parts[i];
      const partTitle = `${gameData.title || part.title} (Part ${i + 1} of ${totalParts})`;

      const partResult = await downloadTflPart(
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

      if (partResult.error) {
        return {
          error: partResult.error,
          partsCompleted: ids.length,
          totalParts
        };
      }
      ids.push(partResult.id);
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

// Self-contained auto-clicker injected into the TFL window on every page load.
// sessionStorage keeps cross-navigation state; short-lived window guards make
// each step retry-safe: if TFL interrupts with an ad navigation before a step's
// submit fires, the flag is still unset and the step restarts on the next page.
// IMPORTANT: keep this free of backticks and ${} - it is embedded via template
// literals in both the dom-ready and did-finish-load handlers below.
const tflAutoClickScript = `
  if (window.ugcTflInterval) clearInterval(window.ugcTflInterval);
  window.ugcTflInterval = setInterval(() => {
    try {
      const statusEl = document.getElementById('ugc-tfl-status');
      const subEl = document.getElementById('ugc-tfl-sub');
      const setStatus = (msg) => {
        if (statusEl) statusEl.innerText = msg;
        const t2 = document.getElementById('ugc-custom-timer');
        if (t2) t2.innerText = msg;
      };
      if (subEl) subEl.innerText = location.href;
      // Debug: live "where am I" line.
      const dbgLine = document.getElementById('ugc-debug-page');
      if (dbgLine) dbgLine.innerText = location.href + ' | ' + document.title;

      const dl1Done = sessionStorage.getItem('ugcTflDl1') === '1';
      const dl2Done = sessionStorage.getItem('ugcTflDl2') === '1';

      const opInput = document.querySelector('input[name="op"]');
      const opValue = opInput ? opInput.value : '';
      const isDlForm = /^download/i.test(opValue);

      // ---- Step 1: file page -> submit op=download1 ----
      // The flag is set ONLY when the submit actually fires. If TFL navigates
      // away before that (ad interstitial), the flag stays unset and this step
      // retries on the next page load.
      if (isDlForm && opValue === 'download1') {
        if (!window.ugcSubmitting) {
          window.ugcSubmitting = true;
          setStatus('Bypassing TheFilesLocker ads...');
          setTimeout(() => {
            try {
              sessionStorage.setItem('ugcTflDl1', '1');
              const form = opInput.closest('form');
              if (form) form.submit();
              else opInput.click();
            } catch (e) { /* page may have navigated */ }
            setTimeout(() => { window.ugcSubmitting = false; }, 4000);
          }, 300);
        }
        return;
      }

      // ---- Step 2: download2 page (countdown + captcha + create button) ----
      if (isDlForm && opValue !== 'download1') {
        const hasCaptcha = document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
        if (hasCaptcha) {
          document.title = 'SHOW_ME';
          setStatus('Please solve the captcha to continue');
          if (window.ugcShieldCaptcha) window.ugcShieldCaptcha();
        }

        const btn = document.getElementById('downloadbtn')
          || document.querySelector('.download-btn')
          || document.querySelector('input[value*="Create"], input[value*="Download"], button[id*="download"], button[class*="download"]')
          || (opInput && opInput.closest('form')
              ? opInput.closest('form').querySelector('input[type="submit"], button[type="submit"]')
              : null);

        // The countdown element shows text like "Wait 10" - extract digits only.
        const cdEl = document.querySelector('#countdown, .countdown, [id*="countdown"], [class*="countdown"], [id*="timer"], [class*="timer"]');
        const cdVal = cdEl ? parseInt((cdEl.innerText || '').replace(/[^0-9]/g, ''), 10) : NaN;
        const bodyMatch = document.body ? document.body.innerText.match(/(\\d+)\\s*(seconds|secs)/i) : null;

        if (!btn || btn.disabled || btn.style.display === 'none') {
          if (!isNaN(cdVal) && cdVal > 0) setStatus('Please wait ' + cdVal + 's...');
          else if (bodyMatch) setStatus('Please wait ' + bodyMatch[1] + 's...');
          else setStatus('Waiting for the download button...');
          return;
        }
        if (!isNaN(cdVal) && cdVal > 0) {
          setStatus('Please wait ' + cdVal + 's...');
          return;
        }

        // Only submit once the button is enabled AND the captcha is solved (or not required).
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
            try {
              sessionStorage.setItem('ugcTflDl2', '1');
              const form = btn.closest('form');
              if (form) form.submit();
              else btn.click();
            } catch (e) { /* page may have navigated */ }
            document.title = 'HIDE_ME';
            setTimeout(() => { window.ugcCreating = false; }, 5000);
          }, 500);
        }
        return;
      }

      // ---- Final direct link: only on pages with no op form left ----
      // (gated on dl1Done so ad links on the create page can't hijack the flow)
      if (!isDlForm && dl1Done && !window.ugcFinalClicked) {
        const finalLink = document.querySelector('a#download_link, a.btn-primary[href*="/d/"], a.btn-download, a[href*="/d/"], a[href*="/file/"]');
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
`;

// Injected into the TheFilesLocker window on every page load. This is the
// app's OWN signature screen: it takes over the window completely, paints the
// Universal Freebie theme (dark navy gradient + orange/amber branding) and
// hides EVERY piece of the real site, keeping only the reCAPTCHA widget, the
// live countdown timer and the download button - moved into the branded UI.
// Mirrors apunkagames_downloader.py's theme_page(). The window stays hidden
// until the captcha screen is ready (document.title = 'SHOW_ME'), so nothing
// of the real site ever appears.
// IMPORTANT: keep the returned script free of backticks and ${} - it is
// embedded via template literals below (only partIndex/totalParts/title are
// interpolated from the outer template).
function buildTflThemeScript(partIndex, totalParts, title) {
  const titleJson = JSON.stringify(title || '');
  return `
(function () {
  if (!window.__ugcThemeApplied) {
    window.__ugcThemeApplied = true;
    const bg = document.createElement('div');
    bg.id = 'ugc-themed';
    bg.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483645; background: linear-gradient(135deg, #0f172a 0%, #16213e 50%, #111827 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: Arial, Helvetica, sans-serif;';
    bg.innerHTML =
      '<div style="font-size: 30px; font-weight: 800; letter-spacing: .5px; background: linear-gradient(135deg, #f97316 0%, #eab308 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px;">Universal Freebie</div>' +
      '<div style="color: #fbbf24; font-size: 13px; font-weight: 700; letter-spacing: 2px; margin-bottom: 8px;">PART ${partIndex} OF ${totalParts}</div>' +
      '<div style="color: #94a3b8; font-size: 15px; margin-bottom: 26px; max-width: 430px; text-align: center; padding: 0 14px;">' + ${titleJson} + '</div>' +
      '<div style="background: rgba(15,23,42,.55); border: 1px solid rgba(249,115,22,.4); border-radius: 16px; padding: 16px 42px; margin-bottom: 26px; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.35);">' +
        '<div style="color: #fbbf24; font-size: 12px; font-weight: 700; letter-spacing: 2px; margin-bottom: 6px;">DOWNLOAD TIMER</div>' +
        '<div id="ugc-timer-sec" style="font-size: 46px; font-weight: 800; color: #22c55e; line-height: 1;">--</div>' +
        '<div style="color: #94a3b8; font-size: 11px; margin-top: 6px;">seconds remaining</div>' +
      '</div>' +
      '<div id="ugc-captcha-holder" style="position: relative; z-index: 2147483647; transform: scale(1.08); min-height: 78px; margin-bottom: 24px; display: flex; align-items: center; justify-content: center;"></div>' +
      '<div id="ugc-btn-holder" style="position: relative; z-index: 2147483647; min-height: 50px;"></div>' +
      '<div id="ugc-tfl-status" style="color: #22c55e; font-size: 14px; font-weight: 700; margin-top: 18px; min-height: 20px;"></div>' +
      '<div style="color: #475569; font-size: 11px; margin-top: 24px;">Universal Freebie - automatic download assistant</div>';
    document.body.appendChild(bg);
  }
  setInterval(function () {
    try {
      // Hide every piece of the real page; keep only our signature screen.
      Array.prototype.forEach.call(document.body.children, function (el) {
        if (el.id !== 'ugc-themed' && el.style) el.style.visibility = 'hidden';
      });
      document.documentElement.style.background = '#0f172a';
      document.body.style.background = '#0f172a';
      document.body.style.overflow = 'hidden';

      // Move the reCAPTCHA widget into our screen (it was rendered by the
      // real page on the TFL origin, so Google's domain check still passes).
      const cap = document.querySelector('.g-recaptcha, #recaptcha, [data-sitekey]');
      if (cap && cap.parentNode.id !== 'ugc-captcha-holder') {
        const holder = document.getElementById('ugc-captcha-holder');
        if (holder) holder.appendChild(cap);
      }

      // Move the download button into our screen and style it in app colors.
      const btn = document.querySelector('#downloadbtn, .download-btn, input[value*="Create"], input[value*="Download"], button[id*="download"], button[class*="download"]');
      if (btn && btn.parentNode.id !== 'ugc-btn-holder') {
        const holder = document.getElementById('ugc-btn-holder');
        if (holder) holder.appendChild(btn);
        btn.style.cssText = 'background: linear-gradient(135deg, #f97316 0%, #eab308 100%); color: #ffffff; border: 0; border-radius: 10px; padding: 13px 34px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 18px rgba(249,115,22,.45); letter-spacing: .3px;';
      }

      // Mirror the real countdown into our timer display.
      const cd = document.querySelector('#countdown, .countdown, [id*="countdown"], [id*="timer"]');
      const secEl = document.getElementById('ugc-timer-sec');
      if (cd && secEl) {
        const d = parseInt((cd.innerText || '').replace(/[^0-9]/g, ''), 10);
        if (!isNaN(d)) secEl.textContent = d > 0 ? String(d) : 'GO';
      }

      // The captcha screen is ready - surface the window (nothing was
      // visible before this point).
      if (cap) document.title = 'SHOW_ME';
    } catch (e) { /* ignore */ }
  }, 500);
})();
`;
}

/**
 * Downloads one TheFilesLocker part:
 *   file page (auto-submit op=download1, hidden)
 *   -> download2 page: the app's signature screen takes over (countdown +
 *      captcha + download button); auto-submit once solved + countdown done
 *   -> final /d/ link (intercepted via will-download -> downloader)
 */
function downloadTflPart(part, gameData, partIndex, totalParts) {
  return new Promise((resolve) => {
    const tflWindow = new BrowserWindow({
      width: UGC_DEBUG ? 1000 : 680,
      height: UGC_DEBUG ? 750 : 600,
      title: 'Universal Freebie',
      show: UGC_DEBUG,
      backgroundColor: '#0f172a',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    tflWindow.setMenu(null);

    let partDone = false;

    tflWindow.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (UGC_DEBUG) tflWindow.setTitle('UGC-DEBUG [TFL]: ' + title);
      // The captcha screen is ready - surface the window (nothing of the
      // real site was visible before this point).
      if (title === 'SHOW_ME') {
        tflWindow.show();
        tflWindow.focus();
      }
      if (title === 'HIDE_ME') {
        tflWindow.hide();
      }
    });

    tflWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // The window is hidden until the captcha screen is ready. Every load
    // replaces the raw site with OUR signature page (theme + timer + captcha +
    // download button); the auto-clicker drives the real flow underneath.
    tflWindow.webContents.on('dom-ready', () => {
      tflWindow.webContents.executeJavaScript(`
        ${buildTflThemeScript(partIndex, totalParts, gameData && gameData.title)}

        // Register the auto-clicker here too: dom-ready fires before
        // did-finish-load, and executeJavaScript can be dropped silently if a
        // navigation races it. The window.ugcTflInterval guard keeps exactly
        // one interval per page even if both handlers land on the same load.
        ${tflAutoClickScript}
      `).catch(() => {});
    });

    tflWindow.webContents.on('did-finish-load', () => {
      tflWindow.webContents.executeJavaScript(`
        ${buildTflThemeScript(partIndex, totalParts, gameData && gameData.title)}
        ${tflAutoClickScript}
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

// ---------------------------------------------------------------
// ApunKaGames one-time flow recorder + replayer
// ---------------------------------------------------------------
// The FIRST ApunKaGames download opens a visible window where the user clicks
// through the real site flow once (shortener chooser, vlink hops, part pages,
// up to TheFilesLocker). Those clicks are recorded as robust selectors + the
// resulting URLs, saved to userData/apunkagames-flow.json, and the recording
// UI is removed. Every later ApunKaGames game then replays the recorded flow
// automatically in a hidden window; if the replay cannot find the elements,
// it falls back to the server-side provider (getApunKaGamesDownload).

function apunkaFlowPath() {
  return path.join(app.getPath('userData'), 'apunkagames-flow.json');
}

function loadRecordedFlow() {
  try {
    const raw = fs.readFileSync(apunkaFlowPath(), 'utf8');
    const flow = JSON.parse(raw);
    if (flow && Array.isArray(flow.steps) && flow.steps.length) return flow;
  } catch (e) { /* no flow recorded yet */ }
  return null;
}

function saveRecordedFlow(flow) {
  try {
    fs.mkdirSync(path.dirname(apunkaFlowPath()), { recursive: true });
    fs.writeFileSync(apunkaFlowPath(), JSON.stringify(flow, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save ApunKaGames flow:', e.message);
    return false;
  }
}

// Shared page-side helpers: selector building, element finding, text matching.
const ugcReplayHelpers = `
function ugcEsc(v) { return String(v).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"'); }
function buildSelectors(el) {
  const sels = [];
  try { if (el.id) sels.push('#' + CSS.escape(el.id)); } catch (e) {}
  const href = el.getAttribute && el.getAttribute('href');
  if (href) sels.push('a[href="' + ugcEsc(href) + '"]');
  const action = el.getAttribute && el.getAttribute('action');
  if (action) sels.push('form[action="' + ugcEsc(action) + '"]');
  const cls = Array.from(el.classList || []).filter(function (c) { return /download|host|proceed|primary|dlink|gip|btn/i.test(c); }).slice(0, 3).join('.');
  if (cls) sels.push(el.tagName.toLowerCase() + '.' + cls);
  const text = (el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim();
  if (text && text.length <= 80) sels.push('text:' + text);
  sels.push(el.tagName.toLowerCase());
  return sels;
}
function buildRec(el) {
  const sels = buildSelectors(el);
  if (!sels.length) return null;
  return { type: 'click', selectors: sels.slice(0, 6), url: (el.getAttribute('href') || el.getAttribute('action') || '') };
}
function findEls(sel) {
  if (sel.indexOf('text:') === 0) {
    const needle = sel.slice(5).toLowerCase();
    const out = [];
    try {
      document.querySelectorAll('a, button, input[type="submit"], input[type="button"]').forEach(function (el) {
        const t = (el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        if (t.indexOf(needle) !== -1) out.push(el);
      });
    } catch (e) {}
    return out;
  }
  try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; }
}
`;

// Recorder UI + click catcher (injected into the visible recording window).
const ugcRecorderScript = `
(function () {
  if (document.getElementById('ugc-rec-panel')) return;
  window.__ugcRecStop = false;
  window.__ugcRecQueue = [];
  try {
    const saved = sessionStorage.getItem('ugcRecQueue');
    if (saved) { window.__ugcRecQueue = JSON.parse(saved); sessionStorage.removeItem('ugcRecQueue'); }
  } catch (e) {}
  const panel = document.createElement('div');
  panel.id = 'ugc-rec-panel';
  panel.style.cssText = 'position: fixed; top: 12px; right: 12px; z-index: 2147483647; background: #7f1d1d; color: #fff; padding: 12px 16px; border-radius: 10px; font-family: Arial, sans-serif; font-size: 13px; line-height: 1.5; box-shadow: 0 6px 24px rgba(0,0,0,.55); max-width: 300px;';
  panel.innerHTML = '<div style="font-weight: bold; font-size: 14px; margin-bottom: 6px;">🎬 REC — ApunKaGames flow recorder</div>' +
    '<div style="opacity: .92; margin-bottom: 10px;">Perform your download clicks once. Recording stops automatically when TheFilesLocker loads, or press Stop &amp; Save.</div>' +
    '<button id="ugc-rec-stop-btn" style="background:#ef4444; color:#fff; border:0; border-radius:6px; padding:6px 12px; font-weight:bold; cursor:pointer;">■ Stop &amp; Save</button>';
  document.body.appendChild(panel);
  document.getElementById('ugc-rec-stop-btn').addEventListener('click', function () { window.__ugcRecStop = true; });
  document.addEventListener('click', function (e) {
    const el = e.target && e.target.closest ? e.target.closest('a, button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]') : e.target;
    if (!el || el.id === 'ugc-rec-stop-btn') return;
    const rec = buildRec(el);
    if (!rec) return;
    const form = el.closest('form');
    if (form && form.target === '_blank' && /download-process\\.php/i.test(form.getAttribute('action') || '')) {
      e.preventDefault();
      e.stopPropagation();
      const file = form.querySelector('input[name="file"]');
      const go = (file && file.value) || form.getAttribute('action');
      if (go) {
        let saved = [];
        try { saved = JSON.parse(sessionStorage.getItem('ugcRecQueue') || '[]'); } catch (err) {}
        saved.push(rec);
        try { sessionStorage.setItem('ugcRecQueue', JSON.stringify(saved)); } catch (err) {}
        setTimeout(function () { window.location.href = go; }, 250);
      }
      return;
    }
    window.__ugcRecQueue.push(rec);
  }, true);
})();
`;

// Opens a visible window on the game page and records every user click until
// TheFilesLocker is reached (or the user presses Stop). Returns the flow.
function recordApunKaGamesFlow(gameUrl, gameData) {
  return new Promise((resolve) => {
    const steps = [];
    let lastUrl = '';
    let stepStart = Date.now();
    let finalized = false;
    let pollTimer = null;

    const recWindow = new BrowserWindow({
      width: 1100,
      height: 800,
      title: 'UGC REC - ApunKaGames (click through once)',
      show: true,
      backgroundColor: '#0f172a',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    recWindow.setMenu(null);

    // Keep every hop in the same window (target=_blank forms and links).
    recWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (url && /^https?:/i.test(url)) recWindow.loadURL(url);
      } catch (e) {}
      return { action: 'deny' };
    });

    recWindow.on('page-title-updated', (e, title) => {
      e.preventDefault();
      recWindow.setTitle('UGC REC [ApunKaGames]: ' + title);
    });

    const finish = (flow) => {
      if (finalized) return;
      finalized = true;
      if (pollTimer) clearInterval(pollTimer);
      try { if (!recWindow.isDestroyed()) recWindow.destroy(); } catch (e) {}
      resolve(flow);
    };

    recWindow.on('closed', () => { finish(null); });

    pollTimer = setInterval(async () => {
      if (recWindow.isDestroyed()) { finish(null); return; }
      try {
        const url = recWindow.webContents.getURL();
        const newSteps = await recWindow.webContents.executeJavaScript('(window.__ugcRecQueue || []).splice(0)', true).catch(() => []);
        const stopFlag = await recWindow.webContents.executeJavaScript('!!window.__ugcRecStop', true).catch(() => false);
        if (Array.isArray(newSteps) && newSteps.length) {
          const now = Date.now();
          for (const s of newSteps) {
            s.waitMs = Math.max(0, now - stepStart);
            steps.push(s);
          }
          stepStart = now;
        }
        if (url && url !== lastUrl) {
          const last = steps[steps.length - 1];
          if (last && last.type === 'click' && !last.navUrl) last.navUrl = url;
          lastUrl = url;
          stepStart = Date.now();
        }
        let host = '';
        try { host = url ? new URL(url).hostname : ''; } catch (e) {}
        if (stopFlag || (host && host.includes('thefileslocker'))) {
          if (!steps.length) { finish(null); return; }
          finish({
            version: 1,
            recordedAt: new Date().toISOString(),
            gameTitle: (gameData && gameData.title) || '',
            steps
          });
          return;
        }
      } catch (e) { /* window destroyed */ }
    }, 400);

    recWindow.webContents.on('did-finish-load', () => {
      recWindow.webContents.executeJavaScript(ugcReplayHelpers + ugcRecorderScript).catch(() => {});
    });

    recWindow.loadURL(gameUrl).catch((e) => {
      console.warn('ApunKaGames recording load failed:', e.message);
      finish(null);
    });
  });
}

// ---- Replay engine ----

function ugcSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSelector(win, selectors, matchIdx, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (win.isDestroyed()) return false;
    try {
      const found = await win.webContents.executeJavaScript(`(function () {
        const sels = ${JSON.stringify(selectors)};
        const idx = ${matchIdx};
        for (const sel of sels) {
          const els = findEls(sel);
          if (idx < els.length) {
            const el = els[idx];
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
          }
        }
        return false;
      })()`);
      if (found) return true;
    } catch (e) {}
    await ugcSleep(350);
  }
  return false;
}

async function clickFound(win, step, matchIdx) {
  try {
    await win.webContents.executeJavaScript(`(function () {
      const sels = ${JSON.stringify(step.selectors)};
      const idx = ${matchIdx};
      let el = null;
      for (const sel of sels) {
        const els = findEls(sel);
        if (idx < els.length) { el = els[idx]; break; }
      }
      if (!el) return;
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      if (el.tagName === 'A' && el.href) { window.location.href = el.href; return; }
      const form = el.closest('form');
      if (form && /download-process\\.php/i.test(form.getAttribute('action') || '')) {
        const file = form.querySelector('input[name="file"]');
        if (file && file.value) { window.location.href = file.value; return; }
      }
      if (form) { form.submit(); return; }
      el.click();
    })()`);
  } catch (e) {}
}

// Replays recorded steps until the page reaches TheFilesLocker (where the
// tflAutoClickScript takes over) or all steps are consumed.
function replayChain(win, flow, partIndex) {
  return new Promise((resolve) => {
    const steps = flow.steps || [];
    if (!steps.length) { resolve('done'); return; }
    let idx = 0;
    let done = false;
    let navTimer = null;

    const finish = (r) => {
      if (done) return;
      done = true;
      if (navTimer) clearTimeout(navTimer);
      win.webContents.removeListener('did-finish-load', onLoad);
      resolve(r);
    };

    const runStep = async () => {
      if (done) return;
      if (idx >= steps.length) { finish('done'); return; }
      const step = steps[idx];
      const matchIdx = idx === 0 ? (partIndex - 1) : 0;
      const found = await waitForSelector(win, step.selectors, matchIdx, 15000);
      if (done) return;
      if (!found) {
        // Fallback: navigate directly to the recorded URL (skip step 0, which
        // is game-specific).
        if (idx > 0 && step.url && /^https?:/i.test(step.url)) {
          idx++;
          try { await win.loadURL(step.url); } catch (e) { finish('error'); }
        } else {
          finish('error');
        }
        return;
      }
      await clickFound(win, step, matchIdx);
      if (done) return;
      idx++;
      // If the click does not trigger navigation, continue after a grace period.
      navTimer = setTimeout(() => {
        navTimer = null;
        if (!done) runStep();
      }, 18000);
    };

    const onLoad = () => {
      if (done) return;
      if (navTimer) { clearTimeout(navTimer); navTimer = null; }
      const url = win.webContents.getURL();
      let host = '';
      try { host = url ? new URL(url).hostname : ''; } catch (e) {}
      if (host.includes('thefileslocker')) { finish('tfl'); return; }
      if (idx >= steps.length) { finish('done'); return; }
      runStep();
    };

    win.webContents.on('did-finish-load', onLoad);
    onLoad();
  });
}

function replayApunKaGamesPart(flow, gameUrl, gameData, partIndex, totalParts) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: UGC_DEBUG ? 1000 : 680,
      height: UGC_DEBUG ? 750 : 600,
      title: 'Universal Freebie',
      show: UGC_DEBUG,
      backgroundColor: '#0f172a',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    win.setMenu(null);
    let partDone = false;
    let matchCount = 1;

    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (UGC_DEBUG) win.setTitle('UGC-REPLAY [ApunKaGames]: ' + title);
      if (title === 'SHOW_ME') win.show();
      if (title === 'HIDE_ME') win.hide();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Dark overlay while hidden + captcha shield (same pattern as TFL window).
    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(`
        (function () {
          if (document.getElementById('ugc-replay-overlay')) return;
          const overlay = document.createElement('div');
          overlay.id = 'ugc-replay-overlay';
          overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #0f172a; z-index: 2147483640; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;';
          const titleNode = document.createElement('h2');
          titleNode.innerText = 'Universal Freebie';
          titleNode.style.cssText = 'color: #fff; margin-bottom: 20px; font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #f97316 0%, #eab308 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;';
          overlay.appendChild(titleNode);
          const partText = document.createElement('div');
          partText.innerText = 'Part ${partIndex} of ${totalParts} (ApunKaGames)';
          partText.style.cssText = 'color: #94a3b8; font-size: 14px; margin-bottom: 10px;';
          overlay.appendChild(partText);
          const statusText = document.createElement('div');
          statusText.id = 'ugc-replay-status';
          statusText.innerText = 'Replaying recorded flow...';
          statusText.style.cssText = 'color: #22c55e; font-size: 20px; font-weight: bold; margin-bottom: 10px;';
          overlay.appendChild(statusText);
          document.body.appendChild(overlay);

          window.ugcShieldCaptcha = function () {
            try {
              const captchaEl = document.querySelector('iframe[src*="recaptcha/api2/bframe"]') ||
                                document.querySelector('.g-recaptcha') ||
                                document.querySelector('iframe[src*="recaptcha"]');
              const overlayEl = document.getElementById('ugc-replay-overlay') || document.getElementById('ugc-clean-overlay');
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
            } catch (e) {}
          };
        })();

        // On TheFilesLocker the app's own signature screen takes over the
        // replay window too (countdown + captcha + download button), exactly
        // like the dedicated TFL window.
        if (location.hostname.indexOf('thefileslocker') !== -1) {
          ${buildTflThemeScript(partIndex, totalParts, gameData && gameData.title)}
        }

        ${tflAutoClickScript}
      `).catch(() => {});
    });

    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(ugcReplayHelpers).catch(() => {});
      win.webContents.executeJavaScript(`
        if (location.hostname.indexOf('thefileslocker') !== -1) {
          ${buildTflThemeScript(partIndex, totalParts, gameData && gameData.title)}
        }
      `).catch(() => {});
      win.webContents.executeJavaScript(tflAutoClickScript).catch(() => {});
    });

    // Start replaying on the first successful load, and count how many part
    // links exist on the game page (multi-part games replay each one).
    win.webContents.once('did-finish-load', async () => {
      const step0 = (flow.steps || [])[0];
      if (step0 && Array.isArray(step0.selectors) && step0.selectors.length) {
        try {
          const count = await win.webContents.executeJavaScript(`(function () {
            try {
              const sels = ${JSON.stringify(step0.selectors)};
              let max = 0;
              for (const sel of sels) {
                let els = [];
                if (sel.indexOf('text:') === 0) {
                  const needle = sel.slice(5).toLowerCase();
                  document.querySelectorAll('a, button').forEach(function (el) {
                    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                    if (t.indexOf(needle) !== -1) els.push(el);
                  });
                } else {
                  els = Array.prototype.slice.call(document.querySelectorAll(sel));
                }
                if (els.length > max) max = els.length;
              }
              return max;
            } catch (e) { return 1; }
          })()`);
          matchCount = Math.min(Math.max(1, parseInt(count, 10) || 1), 8);
        } catch (e) {}
      }
      replayChain(win, flow, partIndex).then((res) => {
        if (res === 'error') {
          if (!win.isDestroyed()) win.close();
        }
        // 'tfl' / 'done': the tflAutoClickScript handles TheFilesLocker now.
      });
    });

    const session = win.webContents.session;

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
        userAgent = win.webContents.getUserAgent();
        refererUrl = webContents.getURL();
      } catch (err) { /* window closed */ }

      const cookies = await session.cookies.get({ url: finalUrl });
      const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      partDone = true;
      session.removeListener('will-download', downloadHandler);
      if (!win.isDestroyed()) win.close();

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
        resolve({ success: true, id, matchCount });
      } else {
        resolve({ error: 'Downloader not initialized' });
      }
    };

    session.on('will-download', downloadHandler);

    const replayTimeout = setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, 240000);

    win.on('closed', () => {
      clearTimeout(replayTimeout);
      if (!partDone) {
        session.removeListener('will-download', downloadHandler);
        resolve({ error: 'Window closed before download started (timeout or manual close).' });
      }
    });

    win.loadURL(gameUrl).catch((err) => {
      console.warn('Replay window load failed:', err.message);
      if (!win.isDestroyed()) win.close();
    });
  });
}

async function replayApunKaGamesFlow(flow, gameUrl, gameData) {
  const ids = [];
  const first = await replayApunKaGamesPart(flow, gameUrl, gameData, 1, 1);
  if (first.error) {
    return { error: first.error, partsCompleted: 0, totalParts: 1 };
  }
  ids.push(first.id);
  const totalParts = Math.min(first.matchCount || 1, 8);
  for (let i = 2; i <= totalParts; i++) {
    const r = await replayApunKaGamesPart(flow, gameUrl, gameData, i, totalParts);
    if (r.error) {
      return { error: r.error, partsCompleted: ids.length, totalParts };
    }
    ids.push(r.id);
  }
  return { success: true, ids, count: ids.length };
}

// Lets the user re-record the flow (deletes the saved flow file).
ipcMain.handle('reset-apunkagames-flow', () => {
  try {
    if (fs.existsSync(apunkaFlowPath())) fs.unlinkSync(apunkaFlowPath());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

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
    // Correct Archive.org flow: resolve EVERY game payload file (all disc
    // images, all split/part archives, installers) and download them all.
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
    const archiveInfo = await getArchiveOrgFiles(identifier);

    if (archiveInfo.error || !archiveInfo.files || !archiveInfo.files.length) {
      return { error: archiveInfo.error || 'No downloadable game files found on this Archive.org item.' };
    }

    const ids = [];
    const totalFiles = archiveInfo.files.length;
    for (let i = 0; i < totalFiles; i++) {
      const file = archiveInfo.files[i];
      const id = globalDownloader.startHttpDownload(file.url, file.filename, {
        ...gameData,
        totalSize: archiveInfo.totalSize,
        part: i + 1,
        totalParts: totalFiles,
        customHeaders: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      ids.push(id);
    }
    return { success: true, ids, count: ids.length };
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
        width: UGC_DEBUG ? 1100 : 600,
        height: UGC_DEBUG ? 800 : 450,
        title: 'Universal Freebie',
        show: UGC_DEBUG,
        backgroundColor: '#0f172a',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      
      siteWindow.setMenu(null);
      
      siteWindow.on('page-title-updated', (e, title) => {
        e.preventDefault();
        if (UGC_DEBUG) siteWindow.setTitle('UGC-DEBUG [site]: ' + title);
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
            const UGC_DEBUG = ${UGC_DEBUG};
            if (!document.getElementById('ugc-clean-overlay')) {
              const overlay = document.createElement('div');
              overlay.id = 'ugc-clean-overlay';
              overlay.style.cssText = UGC_DEBUG
                ? 'position: fixed; top: 0; left: 0; z-index: 2147483640; background: rgba(2,6,23,0.88); padding: 10px 14px; border-radius: 0 0 12px 0; font-family: sans-serif; max-width: 75vw; pointer-events: none;'
                : 'position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #0f172a; z-index: 2147483640; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;';
              
              const titleNode = document.createElement('h2');
              titleNode.innerText = 'Universal Freebie';
              titleNode.style.cssText = UGC_DEBUG
                ? 'color: #f97316; font-size: 13px; font-weight: bold; margin: 0 0 4px 0;'
                : 'color: #fff; margin-bottom: 20px; font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #f97316 0%, #eab308 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;';
              overlay.appendChild(titleNode);

              const statusText = document.createElement('div');
              statusText.id = 'ugc-custom-timer';
              statusText.innerText = 'Bypassing ads & fetching download...';
              statusText.style.cssText = UGC_DEBUG
                ? 'color: #22c55e; font-size: 12px; font-weight: bold; margin-bottom: 4px; font-family: monospace;'
                : 'color: #22c55e; font-size: 20px; font-weight: bold; margin-bottom: 10px;';
              overlay.appendChild(statusText);

              const subText = document.createElement('div');
              subText.id = 'ugc-debug-page';
              subText.innerText = UGC_DEBUG ? (location.href + ' | ' + document.title) : 'Please wait up to 15 seconds.';
              subText.style.cssText = 'color: #94a3b8; font-size: 12px; font-family: monospace; word-break: break-all;';
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

              // Debug: always show the exact page this window is sitting on.
              const dbgLine = document.getElementById('ugc-debug-page');
              if (dbgLine) dbgLine.innerText = location.href + ' | ' + document.title;

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

              // TheFilesLocker pages are handled entirely by the retry-safe
              // tflAutoClickScript appended below (auto-submit download1 ->
              // download2 with countdown/captcha -> final /d/ link). Skip all
              // generic handling on TFL pages so ad links can't hijack the flow.
              const isTflPage = window.location.hostname.includes('thefileslocker');

              if (!isTflPage) {
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

                // ---- ApunKaGames-style shortener / vlink chain ----
                // The same chain appears under akglinks.com and apunkasoftware.net:
                //   chooser page  a.download-btn.primary-host        (TheFilesLocker)
                //   intermediate  a[href*=".../vlink/"]              ("Setup install")
                //   part page     form[action*="download-process.php"] with hidden
                //                 input[name="file"] = thefileslocker.net URL
                //   part page     a#dlink -> thefileslocker.net file page
                // The hidden file input is the most reliable hop: navigating
                // straight to it equals what the ApunKaGames provider does
                // server-side (no POST through download-process.php needed).
                if (!window.ugcChainBusy) {
                  // (a) part page: gip_form hidden file input
                  const partForm = document.querySelector('form[action*="download-process.php"]');
                  if (partForm) {
                    const fileInput = partForm.querySelector('input[name="file"]');
                    const tflUrl = fileInput && fileInput.value;
                    if (tflUrl && /thefileslocker\.net/i.test(tflUrl)) {
                      window.ugcChainBusy = true;
                      setStatus('Opening TheFilesLocker file page...');
                      setTimeout(() => {
                        setStatus('Proceeding...');
                        window.location.href = tflUrl;
                        setTimeout(() => { window.ugcChainBusy = false; }, 4000);
                      }, 800);
                      return;
                    }
                  }
                  // (b) part page: a#dlink proceed link
                  const dlinkEl = document.getElementById('dlink');
                  if (dlinkEl && dlinkEl.href) {
                    window.ugcChainBusy = true;
                    setStatus('Opening TheFilesLocker file page...');
                    setTimeout(() => {
                      setStatus('Proceeding...');
                      window.location.href = dlinkEl.href;
                      setTimeout(() => { window.ugcChainBusy = false; }, 4000);
                    }, 800);
                    return;
                  }
                  // (c) hoster chooser: primary host button (TheFilesLocker)
                  const hostBtn = document.querySelector('a.download-btn.primary-host') ||
                                  document.querySelector('a.download-btn[href]');
                  if (hostBtn && hostBtn.href) {
                    window.ugcChainBusy = true;
                    setStatus('Picking download host (TheFilesLocker)...');
                    setTimeout(() => {
                      setStatus('Proceeding...');
                      window.location.href = hostBtn.href;
                      setTimeout(() => { window.ugcChainBusy = false; }, 4000);
                    }, 800);
                    return;
                  }
                  // (d) intermediate vlink page: follow the first remaining
                  // vlink link to reach the part page that has the form.
                  if (/akglinks|apunkasoftware/i.test(window.location.hostname)) {
                    const vlinkEl = document.querySelector('a[href*="apunkasoftware.net/vlink/"], a[href*="akglinks.com/vlink/"]');
                    if (vlinkEl && vlinkEl.href) {
                      window.ugcChainBusy = true;
                      setStatus('Following download page link...');
                      setTimeout(() => {
                        setStatus('Proceeding...');
                        window.location.href = vlinkEl.href;
                        setTimeout(() => { window.ugcChainBusy = false; }, 4000);
                      }, 800);
                      return;
                    }
                  }
                }
              }
            } catch (e) {
               console.error('Auto-clicker error:', e);
            }
          }, 1000);

          // TheFilesLocker pages: reuse the same retry-safe auto-clicker that
          // the dedicated TFL download window uses (download1 auto-submit ->
          // download2 countdown/captcha -> final /d/ link). The window-guard
          // pattern keeps it safe across TFL ad-interstitial navigations.
          ${tflAutoClickScript}
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
      
      // Timeout: auto-close after 180s to prevent hanging forever.
      // The full chain (shortener -> host page -> TheFilesLocker forms ->
      // countdown -> optional captcha -> final link) can legitimately take
      // more than 90 seconds, especially when a captcha needs solving.
      const siteTimeout = setTimeout(() => {
        if (!siteWindow.isDestroyed()) {
          siteWindow.close();
        }
      }, 180000);

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
        width: UGC_DEBUG ? 1000 : 600,
        height: UGC_DEBUG ? 750 : 450,
        title: 'Universal Freebie',
        show: UGC_DEBUG,
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

    // If no sources selected, search all
    if (promises.length === 0) {
      promises.push(searchArchiveOrg(query), searchFitGirl(query), searchSteamUnlocked(query));
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
