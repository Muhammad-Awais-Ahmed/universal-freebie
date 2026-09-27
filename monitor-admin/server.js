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
const AI_NIM_KEY = (process.env.NVIDIA_NIM_API_KEY || '').trim();
const AI_NIM_MODEL = process.env.NVIDIA_NIM_MODEL || 'meta/llama-3.1-8b-instruct';
const AI_CLIENT_TOKEN = (process.env.AI_CLIENT_TOKEN || '').trim();
const AI_REQUEST_LIMIT = 30;
const AI_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const aiRequests = new Map();

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

function aiClientAuth(req, res, next) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  if (AI_CLIENT_TOKEN && req.headers['x-app-token'] !== AI_CLIENT_TOKEN) {
    return res.status(401).json({ error: 'Invalid app token.' });
  }

  const now = Date.now();
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (aiRequests.get(address) || []).filter((time) => now - time < AI_REQUEST_WINDOW_MS);
  if (recent.length >= AI_REQUEST_LIMIT) {
    return res.status(429).json({ error: 'AI request limit reached. Try again later.' });
  }
  recent.push(now);
  aiRequests.set(address, recent);
  next();
}

function parseAiJson(content) {
  const cleaned = String(content || '').replace(/^```json\s*|```$/g, '').trim();
  return JSON.parse(cleaned);
}

app.options('/api/ai/install-plan', aiClientAuth);
app.post('/api/ai/install-plan', aiClientAuth, async (req, res) => {
  if (!AI_NIM_KEY) return res.status(503).json({ error: 'AI service is not configured.' });

  const { gameTitle, source, files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0 || files.length > 250) {
    return res.status(400).json({ error: 'A file listing with 1 to 250 files is required.' });
  }
  const safeFiles = files.map((file) => ({
    path: String(file.path || '').slice(0, 400),
    extension: String(file.extension || '').slice(0, 16),
    size: Number.isFinite(file.size) ? file.size : 0
  }));

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AI_NIM_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_NIM_MODEL,
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You identify Windows game installers from a local file listing. Return JSON only with installerPath, confidence, and reason. Never return commands, scripts, URLs, or launch arguments. installerPath must be an existing relative .exe or .msi path, or null if none exists.'
          },
          {
            role: 'user',
            content: JSON.stringify({ gameTitle: String(gameTitle || 'Unknown game').slice(0, 200), source: String(source || 'Unknown').slice(0, 80), files: safeFiles })
          }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({ error: `NVIDIA NIM request failed (${response.status}): ${detail.slice(0, 240)}` });
    }
    const payload = await response.json();
    const result = parseAiJson(payload.choices?.[0]?.message?.content);
    res.json({
      ok: true,
      installerPath: typeof result.installerPath === 'string' ? result.installerPath : null,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      reason: String(result.reason || 'Installer candidate detected.')
    });
  } catch (error) {
    console.error('AI install plan error:', error.message);
    res.status(502).json({ error: 'AI service request failed.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, aiConfigured: Boolean(AI_NIM_KEY) }));

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
