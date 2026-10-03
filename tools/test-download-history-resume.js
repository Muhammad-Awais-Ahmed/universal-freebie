const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-history-resume-'));
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'electron') {
    return { app: { getPath: () => tempRoot } };
  }
  return originalLoad.apply(this, arguments);
};

const databasePath = path.join(__dirname, '..', 'src', 'backend', 'database.js');
delete require.cache[databasePath];
const db = require(databasePath);
Module._load = originalLoad;

try {
  const item = {
    id: 'resume-meta-test', filename: 'Video.mp4', url: 'https://example.invalid/video',
    type: 'ytdlp', status: 'interrupted', totalBytes: 100, downloadedBytes: 40,
    meta: { source: 'Video', quality: '720', customHeaders: { Authorization: 'do-not-persist' } },
    completedRanges: [{ start: 0, end: 9 }], chunkSize: 10,
  };
  db.addDownloadToHistory(item);
  const saved = db.getDownloadHistory()[0];

  if (saved.type !== 'ytdlp' || saved.meta?.quality !== '720' || saved.chunkSize !== 10 || saved.completedRanges?.length !== 1) {
    console.error('FAIL: resume type, quality, and completed-range metadata must be persisted');
    process.exitCode = 1;
  } else if (JSON.stringify(saved).includes('do-not-persist')) {
    console.error('FAIL: custom authorization headers must not be persisted in history');
    process.exitCode = 1;
  } else {
    console.log('PASS: history persists safe resume metadata without request credentials');
  }
} finally {
  Module._load = originalLoad;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
