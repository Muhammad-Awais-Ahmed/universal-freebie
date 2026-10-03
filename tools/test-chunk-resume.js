const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-chunk-resume-'));
const database = {
  getSettings: () => ({ downloadDirectory: tempRoot, maxChunks: 8, maxConcurrent: 4, webtorrentTrackers: '' }),
  addDownloadToHistory: () => {},
  updateDownloadHistory: () => {},
  removeDownloadFromHistory: () => {},
};
const originalLoad = Module._load;
const requestedRanges = [];
const totalBytes = 5 * 1024 * 1024 + 1;
const chunkSize = 1024 * 1024;
const axiosMock = Object.assign(async (config) => {
  const match = String(config.headers.Range).match(/^bytes=(\d+)-(\d+)$/);
  const start = Number(match[1]);
  const end = Number(match[2]);
  requestedRanges.push([start, end]);
  const body = Buffer.alloc(end - start + 1, 0x62);
  return {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${totalBytes}` },
    data: Readable.from([body]),
  };
}, {
  get: async (_url, config) => ({
    status: 206,
    headers: { 'content-range': `bytes 0-0/${totalBytes}` },
    data: Readable.from([Buffer.from('x')]),
  }),
});

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
    const filePath = path.join(tempRoot, 'large.bin');
    const handle = await fs.promises.open(filePath, 'w');
    await handle.truncate(totalBytes);
    await handle.write(Buffer.alloc(chunkSize, 0x61), 0, chunkSize, 0);
    await handle.close();

    const downloader = new Downloader(null);
    downloader._scheduleAutoRemove = () => {};
    const item = {
      id: 'chunk-resume-test', url: 'https://example.invalid/large', filename: 'large.bin', filePath,
      meta: {}, status: 'downloading', progress: 20, downloadedBytes: chunkSize, totalBytes,
      speed: 0, type: 'http', chunkSize, completedRanges: [{ start: 0, end: chunkSize - 1 }],
    };
    downloader.downloads.set(item.id, item);

    await downloader._performHttpDownload(item.id, item.url, filePath, chunkSize);

    const content = fs.readFileSync(filePath);
    const firstChunkIntact = content.subarray(0, chunkSize).every(byte => byte === 0x61);
    const remainderIntact = content.subarray(chunkSize).every(byte => byte === 0x62);
    const fetchedSavedRange = requestedRanges.some(([start]) => start === 0);

    if (!firstChunkIntact || !remainderIntact || fetchedSavedRange || item.status !== 'completed') {
      console.error('FAIL: chunk resume must preserve saved ranges, fetch only missing ranges, and complete');
      console.error({ firstChunkIntact, remainderIntact, fetchedSavedRange, status: item.status, requestedRanges });
      process.exitCode = 1;
      return;
    }
    console.log(`PASS: resumed intact file by fetching only ${requestedRanges.length} missing ranges`);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
