const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-resume-'));
const database = {
  getSettings: () => ({ downloadDirectory: tempRoot, maxChunks: 8, maxConcurrent: 4, webtorrentTrackers: '' }),
  addDownloadToHistory: () => {},
  updateDownloadHistory: () => {},
  removeDownloadFromHistory: () => {},
};
const axiosMock = Object.assign(async () => ({
  data: Readable.from([Buffer.from('tail')]),
  headers: { 'content-length': '4', 'content-range': 'bytes 6-9/10' },
  status: 206,
}), { get: async () => ({ status: 206, headers: { 'content-range': 'bytes 0-0/10' }, data: Readable.from([Buffer.from('x')]) }) });
const originalLoad = Module._load;

Module._load = function(request) {
  if (request === 'axios') return axiosMock;
  if (request === 'electron') return { app: {} };
  if (request === './database') return database;
  if (request === 'webtorrent') return class WebTorrent {};
  if (request === './proxyPool') return { hasProxies: () => false, getNextProxy: () => null, markFailed: () => {} };
  return originalLoad.apply(this, arguments);
};

const Downloader = require('../src/backend/downloader');
Module._load = originalLoad;

(async () => {
  try {
    const filePath = path.join(tempRoot, 'resume.bin');
    fs.writeFileSync(filePath, 'prefix');
    const downloader = new Downloader(null);
    downloader._scheduleAutoRemove = () => {};
    const item = {
      id: 'resume-test', url: 'https://example.invalid/file', filename: 'resume.bin', filePath,
      meta: {}, status: 'downloading', progress: 60, downloadedBytes: 6, totalBytes: 10,
      speed: 0, type: 'http',
    };
    const completed = new Promise((resolve) => {
      const markCompleted = downloader._markCompleted.bind(downloader);
      downloader._markCompleted = (downloadItem) => {
        markCompleted(downloadItem);
        resolve();
      };
    });

    await downloader._singleThreadDownload(item, item.url, filePath, 6);
    await completed;

    const actual = fs.readFileSync(filePath, 'utf8');
    if (actual !== 'prefixtail') {
      console.error(`FAIL: resumed bytes must append at offset 6; got ${JSON.stringify(actual)}`);
      process.exitCode = 1;
      return;
    }
    console.log('PASS: single-thread resume preserves the prefix and appends at the requested offset');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
