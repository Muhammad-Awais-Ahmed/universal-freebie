const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const serve = require('electron-serve');
const serveApp = serve.default || serve;
const { autoUpdater } = require('electron-updater');

const Downloader = require('../src/backend/downloader');
const db = require('../src/backend/database');
const proxyPool = require('../src/backend/proxyPool');
const { discoverInstalledGames, lookupWebIcon } = require('../src/backend/gameLibrary');
const { planInstall, runInstaller, installMissingDependencies, cleanupDownloadArtifacts, pruneEmptyStaging, findGameExecutable, STAGING_DIR_NAME, INSTALLED_DIR_NAME } = require('../src/backend/aiInstaller');
const { AutoInstaller } = require('../src/backend/autoInstall');
const { getFolderContents } = require('../src/backend/storageExplorer');
const {
  getStandaloneGames,
  getStandaloneGame,
  getInstalledStandaloneGame,
  installStandaloneGameArchive,
} = require('../src/backend/standaloneGames');

let globalDownloader = null;
let autoInstaller = null;
const standaloneGameInstallStates = new Map();

let updateDownloaded = false;
let updateCheckInProgress = false;
let latestGitHubRelease = null;
let pendingUpdatePath = null;
let skippedVersion = null;
let updateAbortController = null;

function sendUpdateEvent(channel, payload = {}) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath !== '' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath);
}

function isLaunchableGameFile(filePath) {
  return ['.exe', '.bat', '.cmd', '.lnk'].includes(path.extname(filePath).toLowerCase());
}

function getStandaloneGamesRoot() {
  return path.join(app.getPath('userData'), 'standalone-games');
}

function setStandaloneGameInstallState(gameId, phase, extra = {}) {
  const state = { gameId, phase, ...extra, updatedAt: Date.now() };
  standaloneGameInstallStates.set(gameId, state);
  sendUpdateEvent('standalone-game-state', state);
  return state;
}

function ensureStandaloneGameInLibrary(game, installed) {
  const executablePath = installed.executablePath;
  const normalizedPath = path.resolve(executablePath).toLowerCase();
  const existing = db.getInstalledGames().find((entry) => (
    path.resolve(String(entry.executablePath || '')).toLowerCase() === normalizedPath
  ));
  if (existing) return existing;
  return db.addInstalledGame({
    name: game.title,
    executablePath,
    source: 'Official standalone download',
  });
}

async function completeStandaloneGameDownload(item) {
  const gameId = item && item.meta && item.meta.standaloneGameId;
  const game = getStandaloneGame(gameId);
  if (!game) throw new Error('The completed download is not an approved standalone game.');

  setStandaloneGameInstallState(game.id, 'installing', { downloadId: item.id });
  try {
    const installed = await installStandaloneGameArchive(game, item.filePath, getStandaloneGamesRoot());
    const libraryGame = ensureStandaloneGameInLibrary(game, installed);
    setStandaloneGameInstallState(game.id, 'installed', { downloadId: item.id, libraryGame });
    return { ok: true, game: libraryGame };
  } catch (error) {
    console.error(`[standalone-games] Could not install ${game.title}:`, error);
    setStandaloneGameInstallState(game.id, 'error', { downloadId: item.id, error: error.message });
    return { ok: false, error: error.message };
  }
}

// Turns "1.0.17", "v1.0.17" or "1.0.17-beta.2" into [1,0,17] so two
// releases can be compared. Returns null when the string is not a version.
function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// True when `candidate` is strictly newer than `current`. Compared
// numerically, not lexically, so 1.0.10 correctly beats 1.0.9. An
// unparseable candidate is treated as newer so a renamed or unusual tag
// is surfaced rather than silently hidden.
function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next) return true;
  if (!now) return true;

  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}

async function fetchLatestGitHubRelease() {
  const response = await fetch('https://api.github.com/repos/Muhammad-Awais-Ahmed/universal-freebie/releases/latest', {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Universal-Freebie-Updater',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const asset = (data.assets || []).find((item) => /\.(exe|msi)$/i.test(item.name)) || data.assets?.[0];

  if (!asset) {
    throw new Error('No installer asset found in the latest GitHub release.');
  }

  return {
    version: (data.tag_name || data.name || 'latest').replace(/^v/i, ''),
    fileName: asset.name,
    url: asset.browser_download_url,
    releaseNotes: data.body || '',
  };
}

async function downloadGitHubReleaseAsset(assetUrl, fileName, signal) {
  const tempDir = path.join(app.getPath('temp'), 'universal-freebie-updates');
  const finalPath = path.join(tempDir, fileName);

  fs.mkdirSync(tempDir, { recursive: true });

  const response = await fetch(assetUrl, {
    headers: {
      'User-Agent': 'Universal-Freebie-Updater',
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(finalPath, buffer);
  return finalPath;
}

// True when the user already pressed "Later" on this exact release. The
// comparison is against the version being offered, not the running build,
// so dismissing 1.0.17 keeps it quiet for 1.0.17 but a genuine 1.0.18
// release still shows the dialog.
function isUpdateSkipped(releaseVersion) {
  const target = parseVersion(releaseVersion);
  const candidates = [skippedVersion];

  try {
    candidates.push(db.getSettings().updateSkippedVersion);
  } catch (error) {
    // Settings unavailable; the in-memory value above is still usable.
  }

  return candidates.some((candidate) => {
    const skipped = parseVersion(candidate);
    if (!skipped || !target) return false;
    return skipped[0] === target[0] && skipped[1] === target[1] && skipped[2] === target[2];
  });
}

// Marks a version as dismissed so the dialog stops coming back for it.
function skipUpdate(version) {
  skippedVersion = version;
  try {
    db.updateSettings({ updateSkippedVersion: version });
  } catch (error) {
    console.error('[updater] could not remember skipped version:', error);
  }
}

async function checkLatestRelease() {
  try {
    updateCheckInProgress = true;
    sendUpdateEvent('update-checking');

    const release = await fetchLatestGitHubRelease();
    latestGitHubRelease = release;
    updateCheckInProgress = false;

    // A fresh install is exactly when this dialog is most annoying. Only
    // mention an update when the published release really is newer than
    // the running build, otherwise every new install is told to "update"
    // to the version it already has.
    if (!isNewerVersion(release.version, app.getVersion())) {
      sendUpdateEvent('update-not-available');
      return { status: 'not-available' };
    }

    // Respect a "Later" the user already clicked for this same version.
    if (isUpdateSkipped(release.version)) {
      sendUpdateEvent('update-not-available');
      return { status: 'skipped' };
    }

    sendUpdateEvent('update-available', {
      version: release.version,
      currentVersion: app.getVersion(),
      releaseNotes: release.releaseNotes || '',
    });

    return { status: 'available', version: release.version };
  } catch (error) {
    updateCheckInProgress = false;
    console.error('[updater] latest release check failed:', error);
    sendUpdateEvent('update-error', { message: error.message || String(error) });
    return { status: 'error', message: error.message || String(error) };
  }
}

function initAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = true;

  autoUpdater.on('checking-for-update', () => {
    updateCheckInProgress = true;
    sendUpdateEvent('update-checking');
  });

  autoUpdater.on('update-available', (info) => {
    updateCheckInProgress = false;
    sendUpdateEvent('update-available', {
      version: info.version,
      currentVersion: app.getVersion(),
      releaseNotes: info.releaseNotes || '',
    });
  });

  autoUpdater.on('update-not-available', () => {
    updateCheckInProgress = false;
    sendUpdateEvent('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent('update-download-progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateCheckInProgress = false;
    updateDownloaded = true;
    sendUpdateEvent('update-downloaded', { version: info.version });
  });

  autoUpdater.on('error', (error) => {
    updateCheckInProgress = false;
    console.error('[updater]', error);
    sendUpdateEvent('update-error', { message: error.message || String(error) });
  });

  // Updates are deliberately NOT checked automatically. This used to run a
  // lookup four seconds after launch, which meant every single start raised
  // the update screen even when the running build already was the newest
  // release. Nothing here triggers a check any more: the only way to reach
  // the update screen is the explicit "Check for Updates" button in
  // Settings, and even that stays quiet unless the published release is
  // genuinely newer than this build.
}

// ---------------------------------------------------------------
// App startup
// ---------------------------------------------------------------
const isDev = !app.isPackaged;
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

  // Any completed download kicks off the AI auto-install pipeline when the
  // feature is enabled in Settings.
  autoInstaller = new AutoInstaller(
    () => db.getSettings(),
    (states) => db.setAutoInstallStates(Object.fromEntries(states.map((state) => [state.downloadId, state])))
  );
  autoInstaller.restoreStates(db.getAutoInstallStates());
  autoInstaller.on('progress', (state) => {
    sendUpdateEvent('auto-install-progress', state);
  });
  globalDownloader.onCompleted = (item) => (
    item && item.meta && item.meta.standaloneGameId
      ? completeStandaloneGameDownload(item)
      : autoInstaller.handleCompleted(item)
  );
  globalDownloader.isInstallPending = (downloadId) => {
    const standaloneInstall = [...standaloneGameInstallStates.values()].find(
      (state) => state.downloadId === downloadId && state.phase === 'installing'
    );
    if (standaloneInstall) return true;
    const state = autoInstaller.getState(downloadId);
    return autoInstaller.active.has(downloadId)
      || ['error', 'skipped', 'interrupted', 'prerequisite-failed', 'installer-cancelled', 'cleanup-skipped', 'awaiting-manual-install'].includes(state && state.phase)
      || (state && state.phase === 'installed' && !state.library);
  };
  // An installed game is registered in the library so it can be launched from
  // there. Best-effort by design: a duplicate or an unreadable path must not
  // break the install that just succeeded.
  autoInstaller.onRegisterGame = (game) => {
    try {
      const existing = db.getInstalledGames().find(
        (entry) => entry.executablePath === game.executablePath
      );
      if (existing) return existing;
      db.addInstalledGame(game);
      return db.getInstalledGames().find((entry) => entry.executablePath === game.executablePath) || null;
    } catch (err) {
      console.warn('Could not add installed game to library:', err.message);
      return null;
    }
  };

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

  if (!isDev) initAutoUpdater();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => {
  console.error('Startup Error:', err);
  dialog.showErrorBox('Startup Error', err.stack || err.toString());
  app.quit();
});

ipcMain.handle('update:start-download', async () => {
  if (updateDownloaded && pendingUpdatePath) return { status: 'downloaded' };
  if (updateCheckInProgress) return { status: 'checking' };

  updateCheckInProgress = true;
  updateAbortController = new AbortController();
  try {
    const release = latestGitHubRelease || await fetchLatestGitHubRelease();
    latestGitHubRelease = release;
    pendingUpdatePath = await downloadGitHubReleaseAsset(release.url, release.fileName, updateAbortController.signal);
    updateDownloaded = true;
    updateCheckInProgress = false;
    updateAbortController = null;
    sendUpdateEvent('update-downloaded', { version: release.version });
    return { status: 'downloaded' };
  } catch (error) {
    updateCheckInProgress = false;
    updateAbortController = null;
    if (error && error.name === 'AbortError') {
      sendUpdateEvent('update-cancelled');
      return { status: 'cancelled' };
    }
    return { status: 'error', message: error.message || String(error) };
  }
});

ipcMain.handle('update:cancel', async () => {
  updateCheckInProgress = false;
  if (updateAbortController) {
    updateAbortController.abort();
    updateAbortController = null;
  }
  pendingUpdatePath = null;
  updateDownloaded = false;
  sendUpdateEvent('update-cancelled');
  return { status: 'cancelled' };
});

ipcMain.handle('update:install', () => {
  if (!updateDownloaded || !pendingUpdatePath) return { status: 'not-downloaded' };

  const installer = pendingUpdatePath;
  const child = spawn(installer, ['/S'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  setTimeout(() => app.quit(), 300);
  return { status: 'installing' };
});

ipcMain.handle('update:check', async () => {
  if (isDev || updateCheckInProgress) return { status: 'checking' };
  return checkLatestRelease();
});

// Lets the Settings page show which build is actually running. Without this
// the user cannot tell that they are already on the newest release.
ipcMain.handle('app:version', () => ({
  version: app.getVersion(),
}));

ipcMain.handle('update:check-latest', async () => {
  if (updateCheckInProgress) return { status: 'checking' };
  return checkLatestRelease();
});

ipcMain.handle('update:skip', async (_event, version) => {
  const target = version || (latestGitHubRelease && latestGitHubRelease.version) || app.getVersion();
  skipUpdate(target);
  return { status: 'skipped', version: target };
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Gracefully cancel all downloads and destroy the torrent client before
// quitting so the app never hangs in a "Not Responding" state.
app.on('before-quit', () => {
  if (globalDownloader && typeof globalDownloader.shutdown === 'function') {
    globalDownloader.shutdown();
  }
});

ipcMain.handle('ping', () => 'pong');

// ---------------------------------------------------------------
// Download IPC
ipcMain.handle('start-download', async () => ({
  ok: false,
  error: 'Provider-based game downloads are no longer supported. Use the direct-link downloader instead.',
}));

// ---------------------------------------------------------------
// Download by direct link: user pastes any file URL or YouTube link
// and the app fetches it through the resumable HTTP downloader or
// yt-dlp. The user supplies the URL, so this is separate from the verified
// standalone game catalog.
// ---------------------------------------------------------------
ipcMain.handle('download-link', async (event, rawUrl, opts) => {
  if (!globalDownloader) return { error: 'Downloader not initialized' };

  const url = (rawUrl || '').toString().trim();
  if (!url) return { error: 'No URL provided.' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'Invalid URL. Include the full link (https://...).' };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { error: 'Only http(s) links are supported.' };
  }

  // First-time directory prompt (mirrors start-download flow).
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

  // YouTube / media link detection: route through yt-dlp
  if (globalDownloader.isYtDlpUrl(url)) {
    const customFilename = (opts && opts.filename ? opts.filename.trim() : '');
    const quality = (opts && opts.quality ? opts.quality : '1080');
    const meta = {
      id: 'ytdlp-' + Date.now(),
      title: customFilename || 'YouTube Video',
      source: 'YouTube (yt-dlp)',
      description: url,
      url,
      quality
    };
    const res = globalDownloader.startYtDlpDownload(url, customFilename, meta);
    if (res && res.error) {
      return { error: res.error };
    }
    return { success: true, id: res.id, filename: res.filename || 'YouTube Video' };
  }

  // Derive a safe filename from the URL (strip query/hash, fall back).
  const pathname = decodeURIComponent(parsed.pathname);
  let filename = pathname.split('/').filter(Boolean).pop() || '';
  if (!filename || filename.includes('.') === false || /[\\/:*?"<>|]/.test(filename)) {
    filename = 'download-' + Date.now();
  }
  if (opts && opts.filename) {
    const safe = opts.filename.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (safe) filename = safe;
  }

  const meta = {
    id: 'link-' + Date.now(),
    title: (opts && opts.filename) || filename,
    source: 'Direct Link',
    description: url,
    url
  };

  const id = globalDownloader.startHttpDownload(url, filename, meta);
  return { success: true, id, filename };
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
  // When the proxy pool is turned on (or changed), refresh it in the
  // background so downloads can immediately use faster parallel peers.
  if (newSettings && typeof newSettings.proxyPoolEnabled === 'boolean') {
    proxyPool.refreshProxyPool().catch((err) => {
      console.warn('Proxy pool refresh failed:', err.message);
    });
  }
  return updated;
});

// Proxy pool IPC
ipcMain.handle('get-proxy-status', () => proxyPool.getStatus());

ipcMain.handle('refresh-proxy-pool', async () => {
  return await proxyPool.refreshProxyPool();
});

ipcMain.handle('validate-proxy-pool', async () => {
  return await proxyPool.validateProxies();
});

// --- Automatic installation -------------------------------------------
// Read-only view of the pipeline so the UI can re-hydrate after a reload.
ipcMain.handle('get-auto-install-state', (event, downloadId) => {
  if (!autoInstaller) return null;
  return downloadId ? autoInstaller.getState(downloadId) : autoInstaller.getAllStates();
});

// Let the user start the pipeline by hand for a download that already
// finished, and cancel a queued one that is only waiting on dependencies.
ipcMain.handle('run-auto-install', async (event, downloadId) => {
  if (!autoInstaller) return { ok: false, error: 'Automatic installation is unavailable.' };
  if (!globalDownloader) return { ok: false, error: 'No downloader is running.' };
  const item = globalDownloader.downloads.get(downloadId);
  if (!item) return { ok: false, error: 'That download is no longer in the list.' };
  // `force` lets the user start the pipeline manually even when the
  // automatic trigger is switched off.
  await autoInstaller.handleCompleted(item, { force: true });
  return { ok: true };
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
  const dir = path.resolve(db.getSettings().downloadDirectory);
  if (!fs.existsSync(dir)) return { entries: [], errors: [] };
  return getFolderContents(dir);
});

ipcMain.handle('open-folder', (event, itemPath) => {
  shell.showItemInFolder(itemPath);
});

ipcMain.handle('delete-file', (event, itemPath) => {
  try {
    const downloadRoot = path.resolve(db.getSettings().downloadDirectory);
    if (typeof itemPath !== 'string' || !isPathInside(downloadRoot, itemPath)) {
      return { ok: false, error: 'Only items inside the downloads directory can be deleted.' };
    }
    if (fs.existsSync(itemPath)) {
      const stat = fs.lstatSync(itemPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(itemPath);
        return { ok: true };
      }
      const realPath = fs.realpathSync(itemPath);
      if (!isPathInside(fs.realpathSync(downloadRoot), realPath)) {
        return { ok: false, error: 'The selected item resolves outside the downloads directory.' };
      }
      if (stat.isDirectory()) {
        fs.rmSync(itemPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(itemPath);
      }
      return { ok: true };
    }
  } catch (err) {
    console.error('Delete error:', err);
    return { ok: false, error: err.message || 'Could not delete the selected item.' };
  }
  return { ok: false, error: 'The selected item no longer exists.' };
});

// Library: Installed Games IPC
ipcMain.handle('get-installed-games', () => db.getInstalledGames());

// Add a game manually: opens a file picker for the .exe, then stores it.
ipcMain.handle('add-installed-game', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Game Executable',
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe', 'bat', 'cmd', 'lnk'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const exePath = result.filePaths[0];
    if (!isLaunchableGameFile(exePath) || !fs.statSync(exePath).isFile()) {
      return { ok: false, error: 'Choose a game executable, batch file, or shortcut.' };
    }
    const name = path.basename(exePath, path.extname(exePath));
    let thumbnail = null;
    try {
      thumbnail = await lookupWebIcon(name);
    } catch (error) {
      console.warn(`[library] Web artwork lookup failed for "${name}":`, error.message);
    }
    const game = db.addInstalledGame({ name, executablePath: exePath, thumbnail });
    return { ok: true, game };
  }
  return { ok: false };
});

ipcMain.handle('select-game-executable', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Game Executable',
    properties: ['openFile'],
    filters: [
      { name: 'Game Launchers', extensions: ['exe', 'bat', 'cmd', 'lnk'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };

  const executablePath = result.filePaths[0];
  if (!isLaunchableGameFile(executablePath) || !fs.statSync(executablePath).isFile()) {
    return { ok: false, error: 'Choose a game executable, batch file, or shortcut.' };
  }
  return {
    ok: true,
    executablePath,
    name: path.basename(executablePath, path.extname(executablePath))
  };
});

// Add a game with full metadata (used by "Add Game" form in Library).
ipcMain.handle('add-game-entry', (event, gameData) => {
  try {
    const name = String(gameData?.name || '').trim();
    const executablePath = String(gameData?.executablePath || '').trim();
    if (!name || !executablePath) {
      return { ok: false, error: 'Name and executable path are required.' };
    }
    if (!isLaunchableGameFile(executablePath) || !fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
      return { ok: false, error: 'Choose an existing game executable, batch file, or shortcut.' };
    }
    const thumbnail = String(gameData?.thumbnail || '').trim();
    if (thumbnail) {
      let iconUrl;
      try {
        iconUrl = new URL(thumbnail);
      } catch {
        return { ok: false, error: 'Game icon must be a valid HTTPS image URL.' };
      }
      if (iconUrl.protocol !== 'https:') {
        return { ok: false, error: 'Game icon must use a secure HTTPS URL.' };
      }
    }
    const game = {
      name,
      executablePath,
      size: String(gameData?.size || '').trim() || null,
      year: String(gameData?.year || '').trim() || null,
      source: String(gameData?.source || '').trim() || 'Manual',
      thumbnail: thumbnail || null
    };
    return { ok: true, game: db.addInstalledGame(game) };
  } catch (err) {
    console.error('add-game-entry error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('lookup-game-icon', async (event, gameName) => {
  const name = String(gameName || '').trim();
  if (!name) return { ok: false, error: 'Enter a game name before searching for artwork.' };
  if (name.length > 120) return { ok: false, error: 'Game name is too long to search for artwork.' };
  try {
    const thumbnail = await lookupWebIcon(name);
    if (!thumbnail) return { ok: false, error: 'No matching artwork was found in the web catalog.' };
    return { ok: true, thumbnail };
  } catch (error) {
    console.error('[library] web icon lookup failed:', error);
    return { ok: false, error: error.message || 'Could not search for game artwork.' };
  }
});

ipcMain.handle('detect-installed-games', async () => {
  try {
    const detected = discoverInstalledGames();
    const existingPaths = new Set(db.getInstalledGames().map((game) => path.resolve(game.executablePath).toLowerCase()));
    let added = 0;
    let iconsMissing = 0;
    const failures = [];
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < detected.length) {
        const game = detected[nextIndex];
        nextIndex += 1;
        let thumbnail = db.getInstalledGames().find(
          (entry) => path.resolve(entry.executablePath).toLowerCase() === path.resolve(game.executablePath).toLowerCase()
        )?.thumbnail || null;
        if (!thumbnail) {
          try {
            thumbnail = await lookupWebIcon(game.name);
          } catch (error) {
            console.warn(`[library-detect] Could not fetch web artwork for "${game.name}":`, error.message);
            failures.push(game.name);
          }
        }
        if (!thumbnail) iconsMissing += 1;
        const normalizedPath = path.resolve(game.executablePath).toLowerCase();
        const wasInstalled = existingPaths.has(normalizedPath);
        db.addInstalledGame({ ...game, thumbnail });
        if (!wasInstalled) {
          added += 1;
          existingPaths.add(normalizedPath);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, detected.length) }, worker));
    const games = db.getInstalledGames();
    return {
      ok: true,
      detected: detected.length,
      added,
      alreadyInLibrary: detected.length - added,
      iconsMissing,
      iconLookupFailures: failures,
      games
    };
  } catch (error) {
    console.error('[library-detect] Detection failed:', error);
    return { ok: false, error: error.message || 'Could not detect installed games.' };
  }
});

ipcMain.handle('remove-installed-game', (event, id) => {
  db.removeInstalledGame(id);
  return true;
});

// Register a finished download in the library without re-running its
// installer. The game executable is located on disk (never guessed from the
// filename) so the entry can actually be launched, and an already-registered
// path is reported as a no-op rather than duplicated.
ipcMain.handle('add-download-to-library', async (event, downloadId) => {
  try {
    const history = db.getDownloadHistory().find((item) => item.id === downloadId);
    const live = globalDownloader && globalDownloader.downloads.get(downloadId);
    if (!history && !live) {
      return { ok: false, error: 'That download is no longer in the list.' };
    }

    const downloadDirectory = db.getSettings().downloadDirectory;
    const filename = (live && live.filename) || (history && history.filename);
    const filePath = (live && live.filePath) || (filename ? path.join(downloadDirectory, filename) : null);
    if (!filePath) {
      return { ok: false, error: 'The downloaded file could not be located.' };
    }

    // An extracted .zip lives in the per-game staging folder; a plain
    // installer or an already-unpacked folder is searched in place.
    const gameTitle = path.basename(filename || path.basename(filePath), path.extname(filename || filePath));
    const stagingCandidate = path.join(downloadDirectory, STAGING_DIR_NAME, gameTitle);
    const roots = [
      fs.existsSync(stagingCandidate) ? stagingCandidate : null,
      filePath
    ].filter(Boolean);

    let found = null;
    for (const root of roots) {
      try {
        found = findGameExecutable(root);
      } catch (err) {
        found = null;
      }
      if (found) break;
    }

    if (!found) {
      return {
        ok: false,
        error: 'No game executable was found in this download. Install it first, then add it from the Library page.'
      };
    }

    const existing = db.getInstalledGames().find((entry) => entry.executablePath === found.absolutePath);
    if (existing) {
      return { ok: true, game: existing, alreadyAdded: true };
    }

    const name = gameTitle
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
      .replace(/[._]+/g, ' ')
      .trim()
      .slice(0, 80)
      || path.basename(found.absolutePath, path.extname(found.absolutePath));

    let thumbnail = null;
    try {
      thumbnail = await lookupWebIcon(name);
    } catch (error) {
      console.warn(`[library] Web artwork lookup failed for "${name}":`, error.message);
    }
    const game = db.addInstalledGame({
      name,
      executablePath: found.absolutePath,
      size: String(found.size),
      source: (history && history.source) || (live && live.meta && live.meta.source) || 'Installed',
      thumbnail
    });

    return { ok: true, game };
  } catch (err) {
    console.error('add-download-to-library error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('launch-game', (event, exePath) => {
  try {
    if (!exePath || !fs.existsSync(exePath)) {
      return { ok: false, error: 'Executable not found on disk.' };
    }
    const gameDir = path.dirname(exePath);
    const child = spawn(exePath, [], {
      cwd: gameDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    console.error('Launch error:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ai-install-plan', async (event, downloadId) => {
  try {
    const historyItem = db.getDownloadHistory().find((item) => item.id === downloadId);
    if (!historyItem) return { error: 'Download history entry not found.' };
    if (historyItem.status !== 'completed') return { error: 'Only completed downloads can be installed.' };
    const downloadDirectory = db.getSettings().downloadDirectory;
    const filePath = path.join(downloadDirectory, historyItem.filename);
    const relativePath = path.relative(path.resolve(downloadDirectory), path.resolve(filePath));
    if (relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) {
      return { error: 'The selected download is outside the configured download directory.' };
    }
    return await planInstall({
      filePath,
      gameTitle: historyItem.filename,
      source: historyItem.source
    });
  } catch (error) {
    console.error('AI install planning error:', error);
    return { error: error.message || 'AI install planning failed.' };
  }
});

ipcMain.handle('ai-install-run', async (event, installerPath) => {
  try {
    const launched = runInstaller(installerPath, db.getSettings().downloadDirectory);
    if (!launched.ok) return launched;
    const outcome = await launched.result;
    return outcome;
  } catch (error) {
    console.error('AI installer launch error:', error);
    return { ok: false, error: error.message || 'Installer could not be started.' };
  }
});

// Game Search IPC
ipcMain.handle('get-standalone-games', () => getStandaloneGames());

ipcMain.handle('get-standalone-game-status', (_event, gameIds) => {
  if (!Array.isArray(gameIds) || gameIds.length > 100) {
    return { error: 'A list of up to 100 standalone game IDs is required.' };
  }
  const games = {};
  for (const gameId of gameIds) {
    const game = getStandaloneGame(gameId);
    if (!game) continue;
    const installState = standaloneGameInstallStates.get(game.id);
    try {
      const installed = getInstalledStandaloneGame(game.id, getStandaloneGamesRoot());
      if (installed) ensureStandaloneGameInLibrary(game, installed);
      const activeDownload = globalDownloader && [...globalDownloader.downloads.values()].find((item) => (
        item.meta &&
        item.meta.standaloneGameId === game.id &&
        ['downloading', 'queued', 'interrupted'].includes(item.status)
      ));
      const trackedDownload = globalDownloader && installState && installState.downloadId
        ? globalDownloader.downloads.get(installState.downloadId)
        : null;
      const downloadFailed = trackedDownload && ['error', 'cancelled'].includes(trackedDownload.status);
      games[game.id] = {
        installed: Boolean(installed),
        phase: installed ? 'installed' : activeDownload?.status || (downloadFailed ? 'error' : installState?.phase || null),
        downloadId: activeDownload?.id || installState?.downloadId,
        error: installState?.error || (downloadFailed ? trackedDownload.error : undefined),
      };
    } catch (error) {
      games[game.id] = { installed: false, phase: 'error', error: error.message };
    }
  }
  return { games };
});

ipcMain.handle('install-standalone-game', (_event, gameId) => {
  const game = getStandaloneGame(gameId);
  if (!game) return { ok: false, error: 'Choose a game from the official standalone catalog.' };
  if (!globalDownloader) return { ok: false, error: 'The download service is not ready yet.' };

  try {
    const installed = getInstalledStandaloneGame(game.id, getStandaloneGamesRoot());
    if (installed) {
      ensureStandaloneGameInLibrary(game, installed);
      return { ok: true, alreadyInstalled: true };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const activeDownload = [...globalDownloader.downloads.values()].find((item) => (
    item.meta &&
    item.meta.standaloneGameId === game.id &&
    ['downloading', 'queued', 'interrupted'].includes(item.status)
  ));
  if (activeDownload) {
    setStandaloneGameInstallState(game.id, activeDownload.status, { downloadId: activeDownload.id });
    return { ok: true, downloadId: activeDownload.id, phase: activeDownload.status };
  }
  const installState = standaloneGameInstallStates.get(game.id);
  if (installState?.phase === 'installing') {
    return { ok: true, downloadId: installState.downloadId, phase: 'installing' };
  }

  try {
    const meta = {
      id: `standalone-${game.id}-${Date.now()}`,
      title: game.title,
      source: 'Official standalone download',
      description: game.description,
      standaloneGameId: game.id,
    };
    const downloadId = globalDownloader.startHttpDownload(game.downloadUrl, game.filename, meta);
    const download = globalDownloader.downloads.get(downloadId);
    const phase = download?.status || 'downloading';
    setStandaloneGameInstallState(game.id, phase, { downloadId });
    return { ok: true, downloadId, phase };
  } catch (error) {
    console.error(`[standalone-games] Could not start ${game.title} download:`, error);
    return { ok: false, error: error.message || `Could not download ${game.title}.` };
  }
});

ipcMain.handle('play-standalone-game', async (_event, gameId) => {
  try {
    const installed = getInstalledStandaloneGame(gameId, getStandaloneGamesRoot());
    if (!installed) return { ok: false, error: 'Install this game before launching it.' };
    const child = spawn(installed.executablePath, [], {
      cwd: installed.installDirectory,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    return await new Promise((resolve) => {
      child.once('error', (error) => {
        console.error(`[standalone-games] Could not launch ${installed.title}:`, error);
        resolve({ ok: false, error: error.message || `Could not launch ${installed.title}.` });
      });
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    });
  } catch (error) {
    console.error('[standalone-games] Could not launch game:', error);
    return { ok: false, error: error.message || 'Could not launch this game.' };
  }
});
