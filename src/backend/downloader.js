const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const db = require('./database');
const WebTorrent = require('webtorrent');
const proxyPool = require('./proxyPool');

const MAX_CHUNK_RETRIES = 5;
const MAX_REPAIR_PASSES = 2;
const COMPLETED_AUTO_REMOVE_MS = 30_000;
const SPEED_SAMPLE_INTERVAL_MS = 1000;

class Downloader {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.downloads = new Map();

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

  _processQueue() {
    const settings = this._getSettings();
    while (this._getActiveDownloadCount() < settings.maxConcurrent) {
      let found = false;
      for (const [, item] of this.downloads) {
        if (item.status === 'queued') {
          item.status = 'downloading';
          this._performHttpDownload(item.id, item._resumeUrl || item.url, item.filePath, item._resumeFrom || 0);
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

    if (item.type === 'torrent' && item.torrentInfo) {
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
    // Throttled persistence of partial progress so a half-downloaded file
    // can be resumed after an app restart (writes at most every 5s per item).
    const now = Date.now();
    for (const [, item] of this.downloads) {
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
      const downloadsArray = Array.from(this.downloads.values()).map(d => {
        const { torrentInfo, electronItem, ...safeData } = d;
        return safeData;
      });
      this.mainWindow.webContents.send('downloads-progress', downloadsArray);
    }
  }
}

module.exports = Downloader;
