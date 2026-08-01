/**
 * Monitor Admin — receives consent-based screen snapshots from
 * Universal Freebie clients and provides a web dashboard.
 *
 * Run:  ADMIN_TOKEN=your-secret node server.js
 * (or set ADMIN_TOKEN in the environment / .env)
 *
 * Endpoints:
 *   POST /api/frames          receive a snapshot (Bearer auth)
 *   GET  /api/users           list devices (Bearer auth)
 *   GET  /api/frames/:deviceId  list a device's snapshots (Bearer auth)
 *   GET  /                     admin dashboard (asks for token in browser)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4480;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-admin-token';

const DATA_DIR = path.join(__dirname, 'data');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Sanitize device ids to avoid path traversal
function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load users.json:', err.message);
  }
  return {};
}

function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(express.json({ limit: '25mb' }));

// Receive a snapshot frame from a client
app.post('/api/frames', auth, (req, res) => {
  const { deviceId, app: appName, version, ts, frame } = req.body || {};
  const id = safeId(deviceId);
  if (!id || !frame) {
    return res.status(400).json({ error: 'deviceId and frame are required' });
  }

  const timestamp = ts || new Date().toISOString();
  const stamp = timestamp.replace(/[:.]/g, '-');
  const hash = crypto.createHash('md5').update(stamp + Math.random()).digest('hex').slice(0, 6);
  const dir = path.join(FRAMES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${stamp}-${hash}.jpg`;
  fs.writeFileSync(path.join(dir, filename), Buffer.from(frame, 'base64'));

  const users = loadUsers();
  if (!users[id]) {
    users[id] = { firstSeen: timestamp, app: appName || 'unknown', version: version || 'unknown' };
  }
  users[id].lastSeen = timestamp;
  users[id].app = appName || users[id].app;
  users[id].version = version || users[id].version;
  saveUsers(users);

  res.json({ ok: true, file: filename });
});

// List devices
app.get('/api/users', auth, (req, res) => {
  const users = loadUsers();
  const out = Object.entries(users).map(([id, meta]) => {
    const dir = path.join(FRAMES_DIR, id);
    let count = 0;
    try {
      count = fs.readdirSync(dir).length;
    } catch (err) {
      count = 0;
    }
    return { id, ...meta, frameCount: count };
  }).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  res.json(out);
});

// List a device's frames
app.get('/api/frames/:deviceId', auth, (req, res) => {
  const id = safeId(req.params.deviceId);
  const dir = path.join(FRAMES_DIR, id);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort().reverse();
  res.json(files.map(f => ({ file: f, ts: f.replace(/-[a-f0-9]{6}\.jpg$/, '') })));
});

// Serve frame images
app.get('/api/frame/:deviceId/:file', auth, (req, res) => {
  const id = safeId(req.params.deviceId);
  const file = String(req.params.file).replace(/[^a-zA-Z0-9._-]/g, '');
  const full = path.join(FRAMES_DIR, id, file);
  if (!full.startsWith(FRAMES_DIR) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(full);
});

// Dashboard
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('==============================================');
  console.log('  Monitor Admin running');
  console.log(`  Dashboard : http://localhost:${PORT}`);
  console.log(`  Admin token: ${ADMIN_TOKEN}`);
  console.log('  Set ADMIN_TOKEN env var to change it.');
  console.log('==============================================');
});
