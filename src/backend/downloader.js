const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const db = require('./database');
const WebTorrent = require('webtorrent');

const MAX_CHUNK_RETRIES = 5;
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
      maxChunks: s.maxChunks || 32,
      maxConcurrent: s.maxConcurrent || 3,
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
          timeout: 8000 
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
      const CHUNKS = settings.maxChunks;
      const fd = fs.openSync(filePath, resumeFrom > 0 ? 'r+' : 'w');
      const chunkSize = Math.ceil(totalBytes / CHUNKS);
      let totalDownloaded = resumeFrom || 0;
      let lastTime = Date.now();
      let lastBytes = totalDownloaded;

      const downloadChunk = (start, end, retryCount) => {
        return new Promise(async (resolve) => {
          const attempt = async () => {
            try {
              const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                headers: { 
                  ...baseHeaders,
                  'Range': `bytes=${start}-${end}`
                }
              });

              let currentPos = start;

              response.data.on('data', (chunk) => {
                if (downloadItem.status === 'cancelled') {
                  response.data.destroy();
                  return resolve();
                }

                fs.writeSync(fd, chunk, 0, chunk.length, currentPos);
                currentPos += chunk.length;
                totalDownloaded += chunk.length;

                downloadItem.downloadedBytes = totalDownloaded;
                downloadItem.progress = (totalDownloaded / totalBytes) * 100;

                const currentTime = Date.now();
                const timeDiff = (currentTime - lastTime) / SPEED_SAMPLE_INTERVAL_MS;
                if (timeDiff >= 1) {
                  downloadItem.speed = (totalDownloaded - lastBytes) / timeDiff;
                  lastBytes = totalDownloaded;
                  lastTime = currentTime;
                  this._emitProgress();
                }
              });

              response.data.on('end', resolve);
              
              response.data.on('error', (err) => {
                if (downloadItem.status === 'cancelled') return resolve();
                console.warn(`Chunk stream error, attempt ${retryCount + 1}/${MAX_CHUNK_RETRIES} for bytes ${start}-${end}:`, err.message);
                if (retryCount < MAX_CHUNK_RETRIES) {
                  setTimeout(() => attempt(), 2000 * (retryCount + 1));
                } else {
                  resolve(); // Give up on this chunk, let completion check catch it
                }
              });

            } catch (err) {
              if (downloadItem.status === 'cancelled') return resolve();
              console.warn(`Chunk connection error, attempt ${retryCount + 1}/${MAX_CHUNK_RETRIES} for bytes ${start}-${end}:`, err.message);
              if (retryCount < MAX_CHUNK_RETRIES) {
                setTimeout(() => attempt(), 2000 * (retryCount + 1));
              } else {
                resolve();
              }
            }
          };
          
          attempt();
        });
      };

      const promises = [];
      for (let i = 0; i < CHUNKS; i++) {
        const start = i * chunkSize;
        const end = i === CHUNKS - 1 ? totalBytes - 1 : (i + 1) * chunkSize - 1;
        promises.push(downloadChunk(start, end, 0));
      }

      await Promise.all(promises);
      fs.closeSync(fd);

      if (downloadItem.status !== 'cancelled') {
        downloadItem.status = 'completed';
        downloadItem.progress = 100;
        downloadItem.speed = 0;
        db.addDownloadToHistory(downloadItem);
        this._emitProgress();
        this._processQueue();
        this._scheduleAutoRemove(id);
      }
    } catch (err) {
      if (downloadItem && downloadItem.status !== 'cancelled') {
        downloadItem.status = 'error';
        downloadItem.error = err.message;
        downloadItem.speed = 0;
        // Save partial progress so it can be resumed
        db.updateDownloadHistoryStatus(id, 'error');
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

    try {
      const { data, headers, status } = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: baseHeaders
      });

      const isResume = status === 206;
      const totalLength = headers['content-length'];
      if (totalLength) {
        downloadItem.totalBytes = isResume ? parseInt(totalLength, 10) + resumeFrom : parseInt(totalLength, 10);
      }

      const writer = fs.createWriteStream(filePath, { flags: isResume ? 'r+' : 'w', highWaterMark: 1024 * 1024 * 4 });
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
        if (downloadItem.status !== 'cancelled' && downloadItem.status !== 'error') {
          downloadItem.status = 'completed';
          downloadItem.progress = 100;
          downloadItem.speed = 0;
          db.addDownloadToHistory(downloadItem);
          this._emitProgress();
          this._processQueue();
          this._scheduleAutoRemove(downloadItem.id);
        }
      });

      data.on('error', (err) => {
        if (downloadItem.status !== 'cancelled') {
          downloadItem.status = 'error';
          downloadItem.error = err.message;
          downloadItem.speed = 0;
          db.updateDownloadHistoryStatus(downloadItem.id, 'error');
          this._emitProgress();
          this._processQueue();
        }
      });

      writer.on('error', (err) => {
        if (downloadItem.status !== 'cancelled') {
          downloadItem.status = 'error';
          downloadItem.error = err.message;
          downloadItem.speed = 0;
          this._emitProgress();
          this._processQueue();
        }
      });
    } catch (err) {
      downloadItem.status = 'error';
      downloadItem.error = err.message;
      downloadItem.speed = 0;
      db.updateDownloadHistoryStatus(downloadItem.id, 'error');
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
      this._emitProgress();
      this._performHttpDownload(item.id, item.url, item.filePath, resumeFrom);
      return;
    }

    if (item.status === 'queued') {
      item.status = 'downloading';
      this._emitProgress();
      this._performHttpDownload(item.id, item._resumeUrl || item.url, item.filePath, item._resumeFrom || 0);
    }
  }

  retryDownload(id) {
    const item = this.downloads.get(id);
    if (!item || item.status !== 'error') return;
    this.resumeDownload(id);
  }

  removeDownload(id) {
    const item = this.downloads.get(id);
    if (!item) return;
    if (item.status === 'downloading') this.cancelDownload(id);
    this.downloads.delete(id);
    this._emitProgress();
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
        this._scheduleAutoRemove(downloadItem.id);
      } else if (state === 'cancelled') {
        downloadItem.status = 'cancelled';
      } else {
        downloadItem.status = 'error';
        downloadItem.error = `Failed: ${state}`;
        downloadItem.speed = 0;
      }
      this._emitProgress();
      this._processQueue();
    });
  }

  _emitProgress() {
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
