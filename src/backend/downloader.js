const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { app } = require('electron');
const db = require('./database');
const WebTorrent = require('webtorrent');
const proxyPool = require('./proxyPool');

let cachedYtDlpPath = null;
function findYtDlpBinary() {
  if (cachedYtDlpPath && fs.existsSync(cachedYtDlpPath)) return cachedYtDlpPath;

  try {
    const cmd = process.platform === 'win32' ? 'where.exe yt-dlp' : 'which yt-dlp';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const firstLine = out.split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      cachedYtDlpPath = firstLine;
      return firstLine;
    }
  } catch (e) {}

  if (process.platform === 'win32') {
    const pythonDirs = ['Python314', 'Python313', 'Python312', 'Python311', 'Python310', 'Python'];
    for (const pDir of pythonDirs) {
      const p1 = path.join(process.env.APPDATA || '', 'Python', pDir, 'Scripts', 'yt-dlp.exe');
      if (fs.existsSync(p1)) {
        cachedYtDlpPath = p1;
        return p1;
      }
      const p2 = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', pDir, 'Scripts', 'yt-dlp.exe');
      if (fs.existsSync(p2)) {
        cachedYtDlpPath = p2;
        return p2;
      }
    }
  }

  return 'yt-dlp';
}

let cachedNodePath = null;
function findNodeBinary() {
  if (cachedNodePath && fs.existsSync(cachedNodePath)) return cachedNodePath;
  try {
    const cmd = process.platform === 'win32' ? 'where.exe node' : 'which node';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const firstLine = out.split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      cachedNodePath = firstLine;
      return firstLine;
    }
  } catch (e) {}
  return 'node';
}

let cachedFfmpegPath = null;
function findFfmpegBinary() {
  if (cachedFfmpegPath && fs.existsSync(cachedFfmpegPath)) return cachedFfmpegPath;

  try {
    const cmd = process.platform === 'win32' ? 'where.exe ffmpeg' : 'which ffmpeg';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const firstLine = out.split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      cachedFfmpegPath = firstLine;
      return firstLine;
    }
  } catch (e) {}

  if (process.platform === 'win32') {
    const pythonDirs = ['Python314', 'Python313', 'Python312', 'Python311', 'Python310', 'Python'];
    for (const pDir of pythonDirs) {
      const candidates = [
        path.join(process.env.APPDATA || '', 'Python', pDir, 'site-packages', 'imageio_ffmpeg', 'binaries'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', pDir, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
        path.join(process.env.APPDATA || '', 'Python', pDir, 'Scripts'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', pDir, 'Scripts'),
      ];
      for (const dir of candidates) {
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir);
            const ffmpegFile = files.find(f => f.toLowerCase().startsWith('ffmpeg') && f.toLowerCase().endsWith('.exe'));
            if (ffmpegFile) {
              const fullPath = path.join(dir, ffmpegFile);
              cachedFfmpegPath = fullPath;
              return fullPath;
            }
          } catch (e) {}
        }
      }
    }
  }

  try {
    const pyCmd = 'python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"';
    const out = execSync(pyCmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const firstLine = out.split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) {
      cachedFfmpegPath = firstLine;
      return firstLine;
    }
  } catch (e) {}

  return null;
}

function buildFormatArgs(quality, ffmpegBin) {
  const args = [];
  const q = (quality || '1080').toString().toLowerCase().replace('p', '');

  if (ffmpegBin) {
    args.push('--ffmpeg-location', ffmpegBin);
    if (q === 'audio') {
      args.push('-f', 'ba/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (q === 'best' || q === 'max') {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
    } else {
      const height = parseInt(q, 10);
      if (!isNaN(height) && height > 0) {
        args.push('-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`, '--merge-output-format', 'mp4');
      } else {
        args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best', '--merge-output-format', 'mp4');
      }
    }
  } else {
    if (q === 'audio') {
      args.push('-f', 'ba/best');
    } else if (q === 'best' || q === 'max') {
      args.push('-f', 'bestvideo+bestaudio/b/best');
    } else {
      const height = parseInt(q, 10);
      if (!isNaN(height) && height > 0) {
        args.push('-f', `bestvideo[height<=${height}]+bestaudio/b[height<=${height}]/best[height<=${height}]/b/best`);
      } else {
        args.push('-f', 'bestvideo[height<=1080]+bestaudio/b[height<=1080]/best[height<=1080]/b/best');
      }
    }
  }
  return args;
}

const MAX_CHUNK_RETRIES = 5;
const MAX_REPAIR_PASSES = 2;
const COMPLETED_AUTO_REMOVE_MS = 30_000;
const SPEED_SAMPLE_INTERVAL_MS = 1000;

class Downloader {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.downloads = new Map();
    this._childProcesses = new Map();

    try {
      this.torrentClient = new WebTorrent({
        maxConns: 200,
        dht: true,
        tracker: true
      });
    } catch (err) {
      console.error('Failed to load WebTorrent:', err);
    }

    this.downloadsDir = db.getSettings().downloadDirectory;

    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }
  }

  _getSettings() {
    const s = db.getSettings();
    return {
      // Downloads now run fully in parallel by default (no queueing
      // until far beyond realistic usage), with many chunks per file
      // for maximum speed. Users can still tune both in Settings.
      maxChunks: Math.min(parseInt(s.maxChunks, 10) || 64, 128),
      maxConcurrent: Math.min(parseInt(s.maxConcurrent, 10) || 50, 200),
      webtorrentTrackers: s.webtorrentTrackers || ''
    };
  }

  _getActiveDownloadCount() {
    let count = 0;
    for (const d of this.downloads.values()) {
      if (d.status === 'downloading') count++;
    }
    return count;
  }

  generateId() {
    return Math.random().toString(36).substr(2, 9);
  }

  startHttpDownload(url, filename, meta, resumeFrom) {
    const id = (meta && meta.id) || this.generateId();
    const filePath = path.join(this.downloadsDir, filename);

    const item = {
      id,
      url,
      filename,
      filePath,
      meta,
      status: 'downloading',
      progress: 0,
      downloadedBytes: resumeFrom || 0,
      totalBytes: 0,
      speed: 0,
      type: 'http'
    };
    this.downloads.set(id, item);

    // Persist immediately so every started download appears in the
    // home-page Downloads section, even before it finishes.
    db.addDownloadToHistory(item);

    // Concurrency check
    const settings = this._getSettings();
    if (this._getActiveDownloadCount() > settings.maxConcurrent) {
      item.status = 'queued';
      item._resumeUrl = url;
      item._resumeFrom = resumeFrom || 0;
      this._emitProgress();
      return id;
    }

    this._performHttpDownload(id, url, filePath, resumeFrom);
    return id;
  }

  isYtDlpUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url.trim());
      const h = u.hostname.toLowerCase();
      return (
        h === 'youtube.com' ||
        h.endsWith('.youtube.com') ||
        h === 'youtu.be' ||
        h.endsWith('.youtu.be') ||
        h.includes('youtube') ||
        h.includes('youtu.be') ||
        h.includes('vimeo.com') ||
        h.includes('tiktok.com') ||
        h.includes('twitch.tv') ||
        h.includes('dailymotion.com')
      );
    } catch {
      return false;
    }
  }

  startYtDlpDownload(url, customFilename, meta, existingId) {
    const ytDlpBin = findYtDlpBinary();
    const nodeBin = findNodeBinary();
    const ffmpegBin = findFfmpegBinary();
    const id = existingId || (meta && meta.id) || this.generateId();

    const quality = (meta && meta.quality) || '1080';
    const isAudio = quality.toString().toLowerCase().includes('audio');
    const defaultExt = isAudio ? '.mp3' : '.mp4';

    const rawSafeName = (customFilename || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    const initialFilename = rawSafeName || `YouTube_${id}${defaultExt}`;
    const initialTitle = (meta && meta.title && meta.title !== url) ? meta.title : (rawSafeName || 'YouTube Video');
    const initialFilePath = path.join(this.downloadsDir, initialFilename);

    let item = this.downloads.get(id);
    if (!item) {
      item = {
        id,
        url,
        filename: initialFilename,
        filePath: initialFilePath,
        meta: {
          ...meta,
          title: initialTitle,
          quality,
          source: (meta && meta.source) || 'YouTube (yt-dlp)'
        },
        status: 'downloading',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speed: 0,
        type: 'ytdlp'
      };
      this.downloads.set(id, item);
    } else {
      item.status = 'downloading';
      item.speed = 0;
      item.error = undefined;
      item.type = 'ytdlp';
      if (item.meta) item.meta.quality = quality;
    }

    db.addDownloadToHistory(item);
    this._emitProgress();

    const settings = this._getSettings();
    if (this._getActiveDownloadCount() > settings.maxConcurrent) {
      item.status = 'queued';
      this._emitProgress();
      return { success: true, id, filename: item.filename };
    }

    const formatArgs = buildFormatArgs(quality, ffmpegBin);

    const args = [
      '--no-playlist',
      '--js-runtimes', `node:${nodeBin}`,
      '--remote-components', 'ejs:github',
      '--extractor-args', 'youtube:player_client=web_embedded',
      '--retries', '10',
      '--fragment-retries', '10',
      '--file-access-retries', '5',
      ...formatArgs,
      '--newline',
      '--progress-template', 'download:PROG:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s',
      '--paths', `home:${this.downloadsDir}`
    ];

    if (rawSafeName) {
      if (!path.extname(rawSafeName)) {
        args.push('-o', `${rawSafeName}.%(ext)s`);
      } else {
        args.push('-o', rawSafeName);
      }
    } else {
      args.push('-o', '%(title)s [%(id)s].%(ext)s');
    }

    args.push(url);

    let proc;
    try {
      proc = spawn(ytDlpBin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this._childProcesses.set(id, proc);
    } catch (err) {
      item.status = 'error';
      item.error = `Failed to launch yt-dlp: ${err.message}`;
      item.speed = 0;
      db.updateDownloadHistory(item.id, {
        status: 'error',
        error: item.error
      });
      this._emitProgress();
      return { error: item.error };
    }

    // Fast background title resolver so UI gets real title in 1-2s
    if (!rawSafeName) {
      try {
        const titleProc = spawn(ytDlpBin, [
          '--no-playlist',
          '--js-runtimes', `node:${nodeBin}`,
          '--extractor-args', 'youtube:player_client=web_embedded',
          '--print', '%(title)s',
          url
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

        let titleBuf = '';
        titleProc.stdout.on('data', (d) => { titleBuf += d.toString(); });
        titleProc.on('close', (code) => {
          const foundTitle = titleBuf.trim().split(/\r?\n/)[0];
          if (code === 0 && foundTitle && item.filename.startsWith('YouTube_ytdlp-')) {
            const safeTitle = foundTitle.replace(/[\\/:*?"<>|]/g, '_').trim();
            item.filename = `${safeTitle}${defaultExt}`;
            if (item.meta) item.meta.title = foundTitle;
            db.updateDownloadHistory(item.id, { filename: item.filename });
            this._emitProgress();
          }
        });
      } catch (e) {}
    }

    let lastEmitTime = 0;
    let stdoutBuf = '';
    let stderrBuf = '';
    let lastErrorMsg = '';

    const unitMult = (u) => {
      if (!u) return 1;
      const up = u.toUpperCase();
      if (up.startsWith('G')) return 1024 * 1024 * 1024;
      if (up.startsWith('M')) return 1024 * 1024;
      if (up.startsWith('K')) return 1024;
      return 1;
    };

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Merger match: [Merger] Merging formats into "D:\path\to\video.mp4"
        const mergerMatch = trimmed.match(/\[Merger\]\s+Merging formats into\s+["']?(.+?)["']?$/i);
        if (mergerMatch) {
          const rawDest = mergerMatch[1].trim().replace(/^["']|["']$/g, '');
          const cleanDest = path.isAbsolute(rawDest) ? rawDest : path.join(this.downloadsDir, rawDest);
          item.filePath = cleanDest;
          item.filename = path.basename(cleanDest);
          if (!rawSafeName && item.meta) {
            item.meta.title = path.basename(cleanDest, path.extname(cleanDest));
          }
          db.updateDownloadHistory(item.id, {
            filename: item.filename,
            filePath: item.filePath
          });
          this._emitProgress();
          continue;
        }

        // Destination match: [download] Destination: D:\path\to\video.mp4
        const destMatch = trimmed.match(/Destination:\s+(.+)$/i);
        if (destMatch) {
          const rawDest = destMatch[1].trim().replace(/^["']|["']$/g, '');
          const cleanDest = path.isAbsolute(rawDest) ? rawDest : path.join(this.downloadsDir, rawDest);
          const isComponent = /\.(?:f\d+|temp\w*)\.[^.]+$/i.test(cleanDest);
          const cleanName = isComponent ? cleanDest.replace(/\.(?:f\d+|temp\w*)\./i, '.') : cleanDest;
          item.filePath = cleanDest;
          item.filename = path.basename(cleanName);
          if (!rawSafeName && item.meta) {
            item.meta.title = path.basename(cleanName, path.extname(cleanName));
          }
          db.updateDownloadHistory(item.id, {
            filename: item.filename,
            filePath: item.filePath
          });
          this._emitProgress();
        }

        // Already downloaded match: [download] D:\path\to\video.mp4 has already been downloaded
        const alreadyMatch = trimmed.match(/\[download\]\s+(.+?)\s+has already been downloaded/i);
        if (alreadyMatch) {
          const rawDest = alreadyMatch[1].trim().replace(/^["']|["']$/g, '');
          const cleanDest = path.isAbsolute(rawDest) ? rawDest : path.join(this.downloadsDir, rawDest);
          item.filePath = cleanDest;
          item.filename = path.basename(cleanDest);
          item.progress = 100;
          try {
            if (fs.existsSync(cleanDest)) {
              const stat = fs.statSync(cleanDest);
              item.totalBytes = stat.size;
              item.downloadedBytes = stat.size;
            }
          } catch (e) {}
          db.updateDownloadHistory(item.id, {
            filename: item.filename,
            filePath: item.filePath
          });
          this._emitProgress();
        }

        // 1. PROG template match: PROG:  0.0%|1024|10751910|NA
        if (trimmed.startsWith('PROG:')) {
          const parts = trimmed.slice(5).split('|');
          const percent = parseFloat(parts[0]);
          const downloaded = parseInt(parts[1], 10);
          const total = parseInt(parts[2], 10);
          const speed = parseFloat(parts[3]);

          if (!isNaN(percent)) item.progress = Math.min(100, Math.max(0, percent));
          if (!isNaN(downloaded)) item.downloadedBytes = downloaded;
          if (!isNaN(total) && total > 0) item.totalBytes = total;
          item.speed = !isNaN(speed) ? speed : 0;

          const now = Date.now();
          if (now - lastEmitTime > 250) {
            lastEmitTime = now;
            this._emitProgress();
          }
          continue;
        }

        // 2. Standard yt-dlp progress line fallback:
        // [download]   5.2% of   11.28MiB at    1.50MiB/s ETA 00:07
        const stdMatch = trimmed.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)\s*([KMGT]?i?B)(?:\s+at\s+([\d.]+)\s*([KMGT]?i?B\/s))?/i);
        if (stdMatch) {
          const pct = parseFloat(stdMatch[1]);
          const sizeVal = parseFloat(stdMatch[2]);
          const sizeUnit = stdMatch[3] || 'MiB';
          const speedVal = stdMatch[4] ? parseFloat(stdMatch[4]) : null;
          const speedUnit = stdMatch[5] || 'MiB/s';

          if (!isNaN(pct)) item.progress = Math.min(100, Math.max(0, pct));
          if (!isNaN(sizeVal)) {
            const tot = Math.round(sizeVal * unitMult(sizeUnit));
            item.totalBytes = tot;
            item.downloadedBytes = Math.round(tot * (pct / 100));
          }
          if (speedVal) {
            item.speed = Math.round(speedVal * unitMult(speedUnit));
          }

          const now = Date.now();
          if (now - lastEmitTime > 250) {
            lastEmitTime = now;
            this._emitProgress();
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('ERROR:')) {
          lastErrorMsg = trimmed.replace(/^ERROR:\s*/, '');
        }
      }
    });

    proc.on('close', (code) => {
      this._childProcesses.delete(id);
      if (item.status === 'cancelled') return;

      if (code === 0) {
        item.status = 'completed';
        item.progress = 100;
        item.speed = 0;
        try {
          if (!fs.existsSync(item.filePath)) {
            const possibleMerged = item.filePath.replace(/\.(?:f\d+|temp\w*)\./i, '.');
            if (fs.existsSync(possibleMerged)) {
              item.filePath = possibleMerged;
              item.filename = path.basename(possibleMerged);
            } else {
              const candidate = path.join(this.downloadsDir, item.filename);
              if (fs.existsSync(candidate)) {
                item.filePath = candidate;
              }
            }
          }
          if (fs.existsSync(item.filePath)) {
            const stat = fs.statSync(item.filePath);
            item.totalBytes = stat.size;
            item.downloadedBytes = stat.size;
          } else if (item.totalBytes) {
            item.downloadedBytes = item.totalBytes;
          }
        } catch (e) {}

        db.addDownloadToHistory(item);
        db.updateDownloadHistory(item.id, {
          status: 'completed',
          downloadedBytes: item.downloadedBytes,
          totalBytes: item.totalBytes,
          filename: item.filename
        });
        this._emitProgress();
        this._processQueue();
        this._scheduleAutoRemove(item.id);
      } else {
        item.status = 'error';
        item.error = lastErrorMsg || `yt-dlp download process exited with code ${code}`;
        item.speed = 0;
        db.updateDownloadHistory(item.id, {
          status: 'error',
          downloadedBytes: item.downloadedBytes || 0,
          totalBytes: item.totalBytes || 0,
          error: item.error
        });
        this._emitProgress();
        this._processQueue();
      }
    });

    return { success: true, id, filename: item.filename };
  }

  _processQueue() {
    const settings = this._getSettings();
    while (this._getActiveDownloadCount() < settings.maxConcurrent) {
      let found = false;
      for (const [, item] of this.downloads) {
        if (item.status === 'queued') {
          item.status = 'downloading';
          if (item.type === 'ytdlp') {
            this.startYtDlpDownload(item.url, item.filename, item.meta, item.id);
          } else {
            this._performHttpDownload(item.id, item._resumeUrl || item.url, item.filePath, item._resumeFrom || 0);
          }
          found = true;
          break;
        }
      }
      if (!found) break;
    }
  }

  async _performHttpDownload(id, url, filePath, resumeFrom) {
    const downloadItem = this.downloads.get(id);
    if (!downloadItem) return;
    const customHeaders = downloadItem.meta?.customHeaders || {};
    const baseHeaders = { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...customHeaders
    };

    // Abort controller + writer registry: lets cancel/quit stop this
    // download instantly without blocking the main process.
    downloadItem._abortController = new AbortController();
    downloadItem._writers = new Set();

    try {
      let totalBytes = 0;
      let acceptRanges = false;

      try {
        const rangeHeaders = { ...baseHeaders };
        if (resumeFrom > 0) {
          rangeHeaders['Range'] = `bytes=${resumeFrom}-`;
        } else {
          rangeHeaders['Range'] = 'bytes=0-0';
        }
        const rangeRes = await axios.get(url, { 
          headers: rangeHeaders,
          timeout: 8000,
          signal: downloadItem._abortController ? downloadItem._abortController.signal : undefined
        });
        
        if (rangeRes.status === 206) {
          acceptRanges = true;
          const contentRange = rangeRes.headers['content-range'];
          if (contentRange) {
            totalBytes = parseInt(contentRange.split('/')[1], 10);
          }
        }
      } catch (e) {
        console.warn('Range request failed, falling back to single thread:', e.message);
        return await this._singleThreadDownload(downloadItem, url, filePath, resumeFrom);
      }

      if (!totalBytes) {
        return await this._singleThreadDownload(downloadItem, url, filePath, resumeFrom);
      }
      
      downloadItem.totalBytes = totalBytes;

      if (totalBytes < 1024 * 1024 * 5) {
        return await this._singleThreadDownload(downloadItem, url, filePath, resumeFrom);
      }

      const settings = this._getSettings();
      const CHUNKS = Math.min(settings.maxChunks, 128);
      const chunkSize = Math.ceil(totalBytes / CHUNKS);
      const chunkBytes = new Array(CHUNKS).fill(0);

      // Preallocate the file asynchronously (sparse full-size file).
      // Never blocks the UI — the old fs.writeSync approach froze the
      // app into a "Not Responding" state during big downloads.
      if (!resumeFrom) {
        try {
          const fh = await fs.promises.open(filePath, 'w');
          await fh.truncate(totalBytes);
          await fh.close();
        } catch (err) {
          console.warn('Failed to preallocate file, continuing anyway:', err.message);
        }
      }

      let lastTime = Date.now();
      let lastBytes = 0;

      const updateProgress = () => {
        const downloaded = Math.min(totalBytes, (resumeFrom || 0) + chunkBytes.reduce((a, b) => a + b, 0));
        downloadItem.downloadedBytes = downloaded;
        downloadItem.progress = (downloaded / totalBytes) * 100;
        const now = Date.now();
        const td = (now - lastTime) / SPEED_SAMPLE_INTERVAL_MS;
        if (td >= 1) {
          downloadItem.speed = (downloaded - lastBytes) / td;
          lastBytes = downloaded;
          lastTime = now;
          this._emitProgress();
        }
      };

      const downloadChunk = (start, end, chunkIndex, retryCount) => {
        return new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (!settled) { settled = true; resolve(); }
          };
          const attempt = async () => {
            if (downloadItem.status === 'cancelled') return finish();
            const proxy = proxyPool.hasProxies() ? proxyPool.getNextProxy() : null;
            try {
              const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                headers: { ...baseHeaders, 'Range': `bytes=${start}-${end}` },
                proxy: proxy || undefined,
                signal: downloadItem._abortController ? downloadItem._abortController.signal : undefined,
                maxRedirects: 5
              });
              if (downloadItem.status === 'cancelled') {
                response.data.destroy();
                return finish();
              }

              let received = 0;
              const writer = fs.createWriteStream(filePath, { flags: 'r+', start, highWaterMark: 1024 * 1024 * 4 });
              if (downloadItem._writers) downloadItem._writers.add(writer);

              response.data.on('data', (chunk) => {
                if (downloadItem.status === 'cancelled') {
                  response.data.destroy();
                  writer.destroy();
                  return;
                }
                received += chunk.length;
                chunkBytes[chunkIndex] = received;
                updateProgress();
              });

              response.data.pipe(writer);

              const fail = (err) => {
                if (downloadItem.status === 'cancelled') return finish();
                if (proxy) proxyPool.markFailed(proxy.host, proxy.port);
                if (downloadItem._writers) downloadItem._writers.delete(writer);
                if (retryCount < MAX_CHUNK_RETRIES) {
                  console.warn(`Chunk retry ${retryCount + 1}/${MAX_CHUNK_RETRIES} for bytes ${start}-${end}:`, err ? err.message : 'incomplete');
                  setTimeout(() => attempt(), 1500 * (retryCount + 1));
                } else {
                  finish(); // Repair pass will re-fetch this range
                }
              };

              writer.on('finish', () => {
                if (downloadItem._writers) downloadItem._writers.delete(writer);
                if (received < (end - start + 1)) fail(new Error('incomplete chunk'));
                else finish();
              });
              writer.on('error', fail);
              response.data.on('error', fail);
              response.data.on('aborted', () => fail(new Error('aborted')));
            } catch (err) {
              if (downloadItem.status === 'cancelled') return finish();
              if (proxy) proxyPool.markFailed(proxy.host, proxy.port);
              if (retryCount < MAX_CHUNK_RETRIES) {
                console.warn(`Chunk retry ${retryCount + 1}/${MAX_CHUNK_RETRIES} for bytes ${start}-${end}:`, err.message);
                setTimeout(() => attempt(), 1500 * (retryCount + 1));
              } else {
                finish();
              }
            }
          };
          attempt();
        });
      };

      // Pass 1: download every chunk in parallel (proxy-assisted).
      let promises = [];
      for (let i = 0; i < CHUNKS; i++) {
        const start = i * chunkSize;
        const end = i === CHUNKS - 1 ? totalBytes - 1 : (i + 1) * chunkSize - 1;
        promises.push(downloadChunk(start, end, i, 0));
      }
      await Promise.all(promises);

      // Repair passes: re-fetch any ranges still incomplete so a few
      // flaky connections can never corrupt the final file.
      for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
        if (downloadItem.status === 'cancelled') break;
        const missing = [];
        for (let i = 0; i < CHUNKS; i++) {
          const start = i * chunkSize;
          const end = i === CHUNKS - 1 ? totalBytes - 1 : (i + 1) * chunkSize - 1;
          if (chunkBytes[i] < (end - start + 1)) missing.push([start, end, i]);
        }
        if (!missing.length) break;
        console.warn(`Repair pass ${pass + 1}: re-downloading ${missing.length} incomplete range(s).`);
        await Promise.all(missing.map(([s, e, i]) => downloadChunk(s, e, i, 0)));
      }

      if (downloadItem.status !== 'cancelled') {
        // Verify every byte made it to disk (some chunks may have given
        // up even after repair passes) — never mark a corrupt file done.
        let allBytesPresent = true;
        for (let i = 0; i < CHUNKS; i++) {
          const start = i * chunkSize;
          const end = i === CHUNKS - 1 ? totalBytes - 1 : (i + 1) * chunkSize - 1;
          if (chunkBytes[i] < (end - start + 1)) { allBytesPresent = false; break; }
        }
        if (!allBytesPresent) {
          downloadItem.status = 'error';
          downloadItem.error = 'Some chunks could not be downloaded after multiple retries. Resume to continue.';
          downloadItem.speed = 0;
          db.updateDownloadHistory(downloadItem.id, {
            status: 'error',
            downloadedBytes: downloadItem.downloadedBytes || 0,
            totalBytes: downloadItem.totalBytes || 0,
            error: downloadItem.error
          });
          this._emitProgress();
          this._processQueue();
        } else {
          downloadItem.status = 'completed';
          downloadItem.progress = 100;
          downloadItem.speed = 0;
          db.addDownloadToHistory(downloadItem);
          db.updateDownloadHistory(downloadItem.id, {
            status: 'completed',
            downloadedBytes: downloadItem.downloadedBytes || downloadItem.totalBytes,
            totalBytes: downloadItem.totalBytes
          });
          this._emitProgress();
          this._processQueue();
          this._scheduleAutoRemove(id);
        }
      }
    } catch (err) {
      if (downloadItem && downloadItem.status !== 'cancelled') {
        downloadItem.status = 'error';
        downloadItem.error = err.message;
        downloadItem.speed = 0;
        // Save partial progress so it can be resumed
        db.updateDownloadHistory(downloadItem.id, {
          status: 'error',
          downloadedBytes: downloadItem.downloadedBytes || 0,
          totalBytes: downloadItem.totalBytes || 0,
          error: err.message
        });
        this._emitProgress();
        this._processQueue();
      }
    }
  }

  async _singleThreadDownload(downloadItem, url, filePath, resumeFrom) {
    const customHeaders = downloadItem.meta?.customHeaders || {};
    const baseHeaders = { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...customHeaders
    };
    if (resumeFrom > 0) {
      baseHeaders['Range'] = `bytes=${resumeFrom}-`;
    }

    // Abort support for instant cancel/quit.
    if (!downloadItem._abortController) downloadItem._abortController = new AbortController();
    if (!downloadItem._writers) downloadItem._writers = new Set();

    const proxy = proxyPool.hasProxies() ? proxyPool.getNextProxy() : null;

    try {
      const { data, headers, status } = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: baseHeaders,
        proxy: proxy || undefined,
        signal: downloadItem._abortController.signal,
        maxRedirects: 5
      });

      const isResume = status === 206;
      const totalLength = headers['content-length'];
      if (totalLength) {
        downloadItem.totalBytes = isResume ? parseInt(totalLength, 10) + resumeFrom : parseInt(totalLength, 10);
      }

      const writer = fs.createWriteStream(filePath, { flags: isResume ? 'r+' : 'w', highWaterMark: 1024 * 1024 * 4 });
      downloadItem._writers.add(writer);
      let downloadedBytes = resumeFrom || 0;
      let lastTime = Date.now();
      let lastBytes = downloadedBytes;

      data.on('data', (chunk) => {
        if (downloadItem.status === 'cancelled') {
          writer.destroy();
          data.destroy();
          return;
        }

        downloadedBytes += chunk.length;
        downloadItem.downloadedBytes = downloadedBytes;
        downloadItem.progress = downloadItem.totalBytes ? (downloadedBytes / downloadItem.totalBytes) * 100 : 0;

        const currentTime = Date.now();
        const timeDiff = (currentTime - lastTime) / SPEED_SAMPLE_INTERVAL_MS;
        if (timeDiff >= 1) {
          downloadItem.speed = (downloadedBytes - lastBytes) / timeDiff;
          lastBytes = downloadedBytes;
          lastTime = currentTime;
          this._emitProgress();
        }
      });

      data.pipe(writer);

      data.on('end', () => {
        if (downloadItem._writers) downloadItem._writers.delete(writer);
        if (downloadItem.status !== 'cancelled' && downloadItem.status !== 'error') {
          downloadItem.status = 'completed';
          downloadItem.progress = 100;
          downloadItem.speed = 0;
          db.addDownloadToHistory(downloadItem);
          db.updateDownloadHistory(downloadItem.id, {
            status: 'completed',
            downloadedBytes: downloadItem.downloadedBytes || downloadItem.totalBytes,
            totalBytes: downloadItem.totalBytes
          });
          this._emitProgress();
          this._processQueue();
          this._scheduleAutoRemove(downloadItem.id);
        }
      });

      data.on('error', (err) => {
        if (downloadItem._writers) downloadItem._writers.delete(writer);
        if (downloadItem.status !== 'cancelled') {
          downloadItem.status = 'error';
          downloadItem.error = err.message;
          downloadItem.speed = 0;
          db.updateDownloadHistory(downloadItem.id, {
            status: 'error',
            downloadedBytes: downloadItem.downloadedBytes || 0,
            totalBytes: downloadItem.totalBytes || 0,
            error: err.message
          });
          this._emitProgress();
          this._processQueue();
        }
      });

      writer.on('error', (err) => {
        if (downloadItem._writers) downloadItem._writers.delete(writer);
        if (downloadItem.status !== 'cancelled') {
          downloadItem.status = 'error';
          downloadItem.error = err.message;
          downloadItem.speed = 0;
          db.updateDownloadHistory(downloadItem.id, {
            status: 'error',
            downloadedBytes: downloadItem.downloadedBytes || 0,
            totalBytes: downloadItem.totalBytes || 0,
            error: err.message
          });
          this._emitProgress();
          this._processQueue();
        }
      });
    } catch (err) {
      downloadItem.status = 'error';
      downloadItem.error = err.message;
      downloadItem.speed = 0;
      db.updateDownloadHistory(downloadItem.id, {
        status: 'error',
        downloadedBytes: downloadItem.downloadedBytes || 0,
        totalBytes: downloadItem.totalBytes || 0,
        error: err.message
      });
      this._emitProgress();
      this._processQueue();
    }
  }

  startTorrentDownload(magnetURI, meta) {
    const id = this.generateId();
    
    const settings = this._getSettings();
    const defaultTrackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'udp://exodus.desync.com:6969/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'wss://tracker.btorrent.xyz',
      'wss://tracker.openwebtorrent.com'
    ];

    // Merge user-provided trackers
    const customTrackers = settings.webtorrentTrackers
      .split('\n')
      .map(t => t.trim())
      .filter(t => t.length > 0);
    
    const allTrackers = [...new Set([...defaultTrackers, ...customTrackers])];
    
    let enhancedMagnet = magnetURI;
    allTrackers.forEach(t => {
      if (!enhancedMagnet.includes(encodeURIComponent(t))) {
        enhancedMagnet += `&tr=${encodeURIComponent(t)}`;
      }
    });
    
    const downloadItem = {
      id,
      url: enhancedMagnet,
      filename: 'Fetching Metadata...',
      filePath: this.downloadsDir,
      meta,
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      type: 'torrent',
      torrentInfo: null
    };
    
    this.downloads.set(id, downloadItem);

    db.addDownloadToHistory(downloadItem);

    if (!this.torrentClient) {
      downloadItem.status = 'error';
      downloadItem.error = 'WebTorrent failed to initialize';
      this._emitProgress();
      return id;
    }

    this.torrentClient.add(enhancedMagnet, { path: this.downloadsDir }, (torrent) => {
      downloadItem.filename = torrent.name;
      downloadItem.totalBytes = torrent.length;
      downloadItem.torrentInfo = torrent;
      
      this._emitProgress();

      let lastTime = Date.now();
      let lastBytes = 0;

      torrent.on('download', (bytes) => {
        downloadItem.downloadedBytes = torrent.downloaded;
        downloadItem.progress = torrent.progress * 100;

        const currentTime = Date.now();
        const timeDiff = (currentTime - lastTime) / 1000;
        if (timeDiff >= 1) {
          downloadItem.speed = (torrent.downloaded - lastBytes) / timeDiff;
          lastBytes = torrent.downloaded;
          lastTime = currentTime;
          
          this._emitProgress();
        }
      });

      torrent.on('done', () => {
        downloadItem.status = 'completed';
        downloadItem.progress = 100;
        downloadItem.speed = 0;
        db.addDownloadToHistory(downloadItem);
        db.updateDownloadHistory(downloadItem.id, {
          status: 'completed',
          downloadedBytes: downloadItem.totalBytes,
          totalBytes: downloadItem.totalBytes
        });
        this._emitProgress();
        this._processQueue();
        this._scheduleAutoRemove(id);
      });
      
      torrent.on('error', (err) => {
        downloadItem.status = 'error';
        downloadItem.error = err.message;
        downloadItem.speed = 0;
        this._emitProgress();
        this._processQueue();
      });
    });

    return id;
  }

  cancelDownload(id) {
    const item = this.downloads.get(id);
    if (!item) return;

    item.status = 'cancelled';

    // Abort any in-flight HTTP requests and close chunk writers so the
    // download stops immediately without blocking the main process.
    if (item._abortController) {
      try { item._abortController.abort(); } catch (err) {}
    }
    if (item._writers) {
      for (const w of item._writers) {
        try { w.destroy(); } catch (err) {}
      }
      item._writers.clear();
    }

    // Keep the partial file in history so the user can Continue it later.
    db.updateDownloadHistory(id, {
      status: 'interrupted',
      downloadedBytes: item.downloadedBytes || 0,
      totalBytes: item.totalBytes || 0
    });

    const proc = this._childProcesses.get(id);
    if (proc) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {}
      this._childProcesses.delete(id);
    } else if (item.type === 'torrent' && item.torrentInfo) {
      item.torrentInfo.destroy();
    } else if (item.type === 'electron' && item.electronItem) {
      item.electronItem.cancel();
    }

    this._emitProgress();
    this._processQueue();
  }

  resumeDownload(id) {
    const item = this.downloads.get(id);
    if (!item) return;

    if (item.type === 'ytdlp' || (item.url && this.isYtDlpUrl(item.url))) {
      item.status = 'downloading';
      item.speed = 0;
      item.error = undefined;
      db.updateDownloadHistory(id, { status: 'downloading' });
      this._emitProgress();
      this.startYtDlpDownload(item.url, item.filename, item.meta, item.id);
      return;
    }

    if (item.status === 'error' || item.status === 'cancelled') {
      const resumeFrom = item.downloadedBytes || 0;
      item.status = 'downloading';
      item.speed = 0;
      item.error = undefined;
      db.updateDownloadHistory(id, { status: 'downloading' });
      this._emitProgress();
      this._performHttpDownload(item.id, item.url, item.filePath, resumeFrom);
      return;
    }

    if (item.status === 'queued') {
      item.status = 'downloading';
      db.updateDownloadHistory(id, { status: 'downloading' });
      this._emitProgress();
      this._performHttpDownload(item.id, item._resumeUrl || item.url, item.filePath, item._resumeFrom || 0);
    }
  }

  /**
   * Continues a download that was persisted to history (e.g. after app restart).
   * Re-creates the in-memory item from the history entry and resumes from the
   * last saved byte offset.
   */
  resumeFromHistory(id) {
    const history = db.getDownloadHistory().find(d => d.id === id);
    if (!history) return { error: 'Download not found in history.' };
    if (!history.url) return { error: 'No download URL available for this item.' };

    // Already in memory → just resume it.
    if (this.downloads.has(id)) {
      this.resumeDownload(id);
      return { success: true };
    }

    if (history.status === 'completed') return { error: 'Download is already complete.' };

    if (history.type === 'ytdlp' || this.isYtDlpUrl(history.url)) {
      this.startYtDlpDownload(history.url, history.filename, {
        source: history.source || 'YouTube (yt-dlp)',
        quality: (history.meta && history.meta.quality) || history.quality || '1080'
      }, id);
      return { success: true };
    }

    const filePath = path.join(this.downloadsDir, history.filename);
    const resumeFrom = history.downloadedBytes || 0;

    const item = {
      id,
      url: history.url,
      filename: history.filename,
      filePath,
      meta: { source: history.source || 'Unknown' },
      status: 'downloading',
      progress: history.totalBytes ? Math.min(100, (resumeFrom / history.totalBytes) * 100) : 0,
      downloadedBytes: resumeFrom,
      totalBytes: history.totalBytes || 0,
      speed: 0,
      type: history.type || 'http'
    };
    this.downloads.set(id, item);
    db.updateDownloadHistory(id, { status: 'downloading' });
    this._emitProgress();
    this._performHttpDownload(id, item.url, filePath, resumeFrom);
    return { success: true };
  }

  retryDownload(id) {
    const item = this.downloads.get(id);
    if (!item || item.status !== 'error') return;
    this.resumeDownload(id);
  }

  removeDownload(id) {
    const item = this.downloads.get(id);
    if (item) {
      if (item.status === 'downloading') this.cancelDownload(id);
      if (item.type === 'torrent' && item.torrentInfo) {
        try { item.torrentInfo.destroy(); } catch (e) {}
      }
      const proc = this._childProcesses.get(id);
      if (proc) {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
          else proc.kill('SIGKILL');
        } catch (e) {}
        this._childProcesses.delete(id);
      }
      this.downloads.delete(id);
    }
    db.removeDownloadFromHistory(id);
    this._emitProgress();
  }

  /**
   * Graceful shutdown for app quit: cancels every active download,
   * aborts in-flight requests, closes file writers and destroys the
   * torrent client so the process can exit cleanly (no lingering
   * sockets, no frozen "Not Responding" window).
   */
  shutdown() {
    for (const [, proc] of this._childProcesses) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        } else {
          proc.kill('SIGKILL');
        }
      } catch (err) {}
    }
    this._childProcesses.clear();

    for (const [, item] of this.downloads) {
      if (item.status === 'downloading' || item.status === 'queued') {
        this.cancelDownload(item.id);
      } else if (item._abortController) {
        try { item._abortController.abort(); } catch (err) {}
      }
      if (item._writers) {
        for (const w of item._writers) {
          try { w.destroy(); } catch (err) {}
        }
        item._writers.clear();
      }
    }
    if (this.torrentClient) {
      try { this.torrentClient.destroy(() => {}); } catch (err) {}
      this.torrentClient = null;
    }
  }

  _scheduleAutoRemove(id) {
    setTimeout(() => {
      const item = this.downloads.get(id);
      if (item && (item.status === 'completed' || item.status === 'cancelled')) {
        if (item.type === 'torrent' && item.torrentInfo) {
          try { item.torrentInfo.destroy(); } catch (e) {}
        }
        if (item._writers) {
          for (const w of item._writers) {
            try { w.destroy(); } catch (e) {}
          }
          item._writers.clear();
        }
        this._childProcesses.delete(id);
        this.downloads.delete(id);
        this._emitProgress();
      }
    }, COMPLETED_AUTO_REMOVE_MS);
  }

  interceptElectronDownload(item) {
    const id = this.generateId();
    const filePath = path.join(this.downloadsDir, item.getFilename());
    
    item.setSavePath(filePath);

    const downloadItem = {
      id,
      url: item.getURL(),
      filename: item.getFilename(),
      filePath,
      meta: { source: 'Mod Browser' },
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: item.getTotalBytes(),
      speed: 0,
      type: 'electron',
      electronItem: item
    };
    
    this.downloads.set(id, downloadItem);
    db.addDownloadToHistory(downloadItem);
    this._emitProgress();

    let lastTime = Date.now();
    let lastBytes = 0;

    item.on('updated', (event, state) => {
      if (state === 'interrupted') {
        downloadItem.status = 'error';
        downloadItem.error = 'Download interrupted';
      } else if (state === 'progressing') {
        if (item.isPaused()) {
          downloadItem.status = 'paused';
        } else {
          downloadItem.status = 'downloading';
          downloadItem.downloadedBytes = item.getReceivedBytes();
          if (downloadItem.totalBytes > 0) {
            downloadItem.progress = (item.getReceivedBytes() / downloadItem.totalBytes) * 100;
          }

          const currentTime = Date.now();
          const timeDiff = (currentTime - lastTime) / 1000;
          if (timeDiff >= 1) {
            downloadItem.speed = (item.getReceivedBytes() - lastBytes) / timeDiff;
            lastBytes = item.getReceivedBytes();
            lastTime = currentTime;
          }
        }
      }
      this._emitProgress();
    });

    item.once('done', (event, state) => {
      if (state === 'completed') {
        downloadItem.status = 'completed';
        downloadItem.progress = 100;
        downloadItem.speed = 0;
        db.addDownloadToHistory(downloadItem);
        db.updateDownloadHistory(downloadItem.id, {
          status: 'completed',
          downloadedBytes: downloadItem.totalBytes,
          totalBytes: downloadItem.totalBytes
        });
        this._scheduleAutoRemove(downloadItem.id);
      } else if (state === 'cancelled') {
        downloadItem.status = 'cancelled';
        db.updateDownloadHistory(downloadItem.id, {
          status: 'interrupted',
          downloadedBytes: downloadItem.downloadedBytes || 0,
          totalBytes: downloadItem.totalBytes || 0
        });
      } else {
        downloadItem.status = 'error';
        downloadItem.error = `Failed: ${state}`;
        downloadItem.speed = 0;
        db.updateDownloadHistory(downloadItem.id, {
          status: 'error',
          downloadedBytes: downloadItem.downloadedBytes || 0,
          totalBytes: downloadItem.totalBytes || 0,
          error: `Failed: ${state}`
        });
      }
      this._emitProgress();
      this._processQueue();
    });
  }

  _emitProgress() {
    // Monotonic progress enforcement: some sources (yt-dlp fragment
    // restarts, torrent.downloaded, electron getReceivedBytes, chunk
    // retries) can report a LOWER byte count or percent mid-download,
    // which makes the meter jump backwards. Track the max ever seen per
    // item and never let the UI (or persisted history) see a decrease.
    const now = Date.now();
    for (const [, item] of this.downloads) {
      if (item.status === 'downloading' || item.status === 'queued') {
        const maxBytes = Math.max(item._maxDownloadedBytes || 0, item.downloadedBytes || 0);
        item._maxDownloadedBytes = maxBytes;
        // Never show more downloaded than total (totalBytes can shrink
        // mid-download on some sources); keep the raw max for monotonicity.
        item.downloadedBytes = item.totalBytes > 0 ? Math.min(maxBytes, item.totalBytes) : maxBytes;

        // Percent must never go backwards either. Prefer the higher of
        // the reported percent and the percent implied by the monotonic
        // byte count, then clamp to the all-time max percent.
        const reported = typeof item.progress === 'number' ? item.progress : 0;
        let nextProgress = reported;
        if (item.totalBytes > 0) {
          const pctFromBytes = (maxBytes / item.totalBytes) * 100;
          nextProgress = Math.max(reported, pctFromBytes);
        }
        item.progress = Math.min(100, Math.max(nextProgress, item._maxProgress || 0));
        item._maxProgress = item.progress;

        // Speed must never be negative (a decreasing byte count would
        // otherwise produce a negative "speed" that makes the meter
        // look like it's going backwards).
        if (typeof item.speed === 'number' && item.speed < 0) item.speed = 0;
      }

      // Throttled persistence of partial progress so a half-downloaded file
      // can be resumed after an app restart (writes at most every 5s per item).
      if (item.status === 'downloading' && (item._lastHistSave || 0) + 5000 < now) {
        item._lastHistSave = now;
        db.updateDownloadHistory(item.id, {
          status: 'downloading',
          downloadedBytes: item.downloadedBytes || 0,
          totalBytes: item.totalBytes || 0
        });
      }
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const downloadsArray = Array.from(this.downloads.values()).map(d => ({
        id: d.id,
        url: d.url,
        filename: d.filename,
        filePath: d.filePath,
        status: d.status,
        progress: typeof d.progress === 'number' ? Math.min(100, Math.max(0, d.progress)) : 0,
        downloadedBytes: typeof d.downloadedBytes === 'number' ? d.downloadedBytes : 0,
        totalBytes: typeof d.totalBytes === 'number' ? d.totalBytes : 0,
        speed: typeof d.speed === 'number' ? d.speed : 0,
        type: d.type || 'http',
        error: d.error,
        meta: d.meta ? {
          id: d.meta.id,
          title: d.meta.title,
          source: d.meta.source,
          description: d.meta.description
        } : undefined
      }));

      try {
        this.mainWindow.webContents.send('downloads-progress', downloadsArray);
      } catch (err) {
        console.error('Failed to send downloads-progress over IPC:', err.message);
      }
    }
  }
}

module.exports = Downloader;
