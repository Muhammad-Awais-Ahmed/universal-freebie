const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-protocol-resume-'));
const history = [{
  id: 'torrent-history-id',
  type: 'torrent',
  url: 'magnet:?xt=urn:btih:abcdef',
  filename: 'Test Game',
  source: 'Test Source',
  status: 'interrupted',
  downloadedBytes: 100,
  totalBytes: 1000,
  meta: { source: 'Test Source' },
}];
const historyUpdates = [];
const database = {
  getSettings: () => ({ downloadDirectory: tempRoot, maxChunks: 8, maxConcurrent: 4, webtorrentTrackers: '' }),
  getDownloadHistory: () => history,
  addDownloadToHistory: () => {},
  updateDownloadHistory: (id, patch) => historyUpdates.push({ id, patch }),
  removeDownloadFromHistory: () => {},
};
let torrentRequest = null;
let paused = 0;
let cancelled = 0;
class FakeTorrent extends EventEmitter {
  constructor() {
    super();
    this.name = 'Test Game';
    this.length = 1000;
    this.downloaded = 100;
    this.progress = 0.1;
  }
  destroy() {}
}
class FakeWebTorrent {
  add(uri, options, callback) {
    torrentRequest = { uri, options };
    callback(new FakeTorrent());
  }
  destroy() {}
}
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'axios') return { get: async () => ({}), default: null };
  if (request === 'electron') return { app: {} };
  if (request === './database') return database;
  if (request === 'webtorrent') return FakeWebTorrent;
  if (request === './proxyPool') return { hasProxies: () => false, getNextProxy: () => null, markFailed: () => {} };
  return originalLoad.apply(this, arguments);
};

const Downloader = require('../src/backend/downloader');
Module._load = originalLoad;

try {
  const downloader = new Downloader(null);
  const resumed = downloader.resumeFromHistory('torrent-history-id');
  if (!resumed.success || !torrentRequest || !torrentRequest.uri.startsWith('magnet:?')
    || downloader.downloads.get('torrent-history-id')?.type !== 'torrent') {
    throw new Error('torrent history was not resumed through WebTorrent with its original id');
  }

  const electronDownloader = new Downloader(null);
  const downloadItem = Object.assign(new EventEmitter(), {
    getFilename: () => 'partial.zip',
    getURL: () => 'https://example.invalid/partial.zip',
    getTotalBytes: () => 1000,
    getReceivedBytes: () => 250,
    setSavePath: () => {},
    isPaused: () => false,
    pause: () => { paused++; },
    resume: () => {},
    cancel: () => { cancelled++; },
  });
  electronDownloader.interceptElectronDownload(downloadItem);
  const electronId = [...electronDownloader.downloads.keys()][0];
  electronDownloader.cancelDownload(electronId);
  const electronState = electronDownloader.downloads.get(electronId);
  if (paused !== 1 || cancelled !== 0 || electronState.status !== 'interrupted'
    || electronState.downloadedBytes !== 250) {
    throw new Error('Electron stop did not pause and preserve a resumable byte offset');
  }

  console.log('PASS: torrent history resumes by magnet and Electron stop preserves a resumable partial');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  Module._load = originalLoad;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
