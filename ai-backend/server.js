/**
 * Universal Freebie — AI Backend
 *
 * Server-side NVIDIA NIM proxy used by the desktop app's "AI Install" flow.
 * The NVIDIA API key never leaves this service: the client only ever sends a
 * sanitized file listing and receives back the installer candidate.
 *
 * Endpoints:
 *   GET  /api/health        service + AI configuration status
 *   POST /api/ai/install-plan   ask the model which .exe/.msi is the installer
 *
 * Environment:
 *   NVIDIA_NIM_API_KEY   (required) NVIDIA NIM API key
 *   NVIDIA_NIM_MODEL     (optional) default meta/llama-3.1-8b-instruct
 *   AI_CLIENT_TOKEN      (optional) shared token the app must send. Leave unset
 *                        to keep the service open, which is the default.
 *   AI_REQUEST_LIMIT     (optional) requests per IP per window, default 30
 *   AI_REQUEST_WINDOW_MS (optional) rate limit window, default 1 hour
 *   PORT                 (optional) defaults to 4480
 */
const express = require('express');

const app = express();
const PORT = process.env.PORT || 4480;

const NIM_ENDPOINT =
  process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_KEY = (process.env.NVIDIA_NIM_API_KEY || '').trim();
const NIM_MODEL = process.env.NVIDIA_NIM_MODEL || 'meta/llama-3.1-8b-instruct';
const CLIENT_TOKEN = (process.env.AI_CLIENT_TOKEN || '').trim();

// Per-IP rate limit is the real protection. A shared token cannot protect a
// desktop app, because any app-shipped token is public the moment it ships.
const REQUEST_LIMIT = Number(process.env.AI_REQUEST_LIMIT || 30);
const REQUEST_WINDOW_MS = Number(process.env.AI_REQUEST_WINDOW_MS || 60 * 60 * 1000);
const requestLog = new Map();

const SYSTEM_PROMPT =
  'You identify Windows game installers from a local file listing. ' +
  'Return JSON only with installerPath, confidence, and reason. ' +
  'Never return commands, scripts, URLs, or launch arguments. ' +
  'installerPath must be an existing relative .exe or .msi path, or null if none exists.';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Basic CORS so the packaged app (file:// origin) can call the service.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Simple in-memory per-IP limiter (no external dependency).
function aiLimiter(req, res, next) {
  const now = Date.now();
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (requestLog.get(address) || []).filter((time) => now - time < REQUEST_WINDOW_MS);

  if (recent.length >= REQUEST_LIMIT) {
    return res.status(429).json({ error: 'AI request limit reached. Try again later.' });
  }

  recent.push(now);
  requestLog.set(address, recent);

  if (requestLog.size > 5000) requestLog.clear();
  return next();
}

function parseModelJson(content) {
  const cleaned = String(content || '')
    .replace(/^```json\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object') throw new Error('Model did not return a JSON object.');
  return parsed;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'universal-freebie-ai',
    aiConfigured: Boolean(NIM_KEY),
    model: NIM_MODEL,
    clientTokenRequired: Boolean(CLIENT_TOKEN),
  });
});

app.post('/api/ai/install-plan', aiLimiter, async (req, res) => {
  if (CLIENT_TOKEN && req.headers['x-app-token'] !== CLIENT_TOKEN) {
    return res.status(401).json({ error: 'Invalid app token.' });
  }

  const { gameTitle, source, files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0 || files.length > 250) {
    return res.status(400).json({ error: 'A file listing with 1 to 250 files is required.' });
  }

  if (!NIM_KEY) {
    return res.status(503).json({ error: 'AI service is not configured. NVIDIA_NIM_API_KEY is missing.' });
  }

  const safeFiles = files.map((file) => ({
    path: String(file && file.path || '').slice(0, 400),
    extension: String(file && file.extension || '').slice(0, 16),
    size: Number.isFinite(file && file.size) ? file.size : 0,
  }));

  const startedAt = Date.now();
  try {
    const nimResponse = await fetch(NIM_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NIM_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NIM_MODEL,
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              gameTitle: String(gameTitle || 'Unknown game').slice(0, 200),
              source: String(source || 'Unknown').slice(0, 80),
              files: safeFiles,
            }),
          },
        ],
      }),
    });

    if (!nimResponse.ok) {
      const detail = await nimResponse.text();
      console.error(`[ai] NIM responded ${nimResponse.status}: ${detail.slice(0, 300)}`);
      return res.status(502).json({
        error: `NVIDIA NIM request failed (${nimResponse.status}).`,
      });
    }

    const payload = await nimResponse.json();
    const result = parseModelJson(payload.choices?.[0]?.message?.content);

    const installerPath = typeof result.installerPath === 'string' ? result.installerPath.trim() : '';
    const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
    const reason = String(result.reason || 'Installer candidate detected.').slice(0, 400);

    // The desktop client parses the OpenAI-compatible response shape.
    return res.json({
      id: `uf-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: NIM_MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ installerPath: installerPath || null, confidence, reason }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: payload.usage || null,
    });
  } catch (error) {
    console.error('[ai] install-plan error:', error.message);
    return res.status(502).json({ error: 'AI service request failed.' });
  }
});

app.get('/', (_req, res) => res.redirect('/api/health'));

app.listen(PORT, () => {
  console.log('==============================================');
  console.log('  Universal Freebie AI Backend');
  console.log(`  Listening   : http://localhost:${PORT}`);
  console.log(`  AI configured: ${NIM_KEY ? 'yes' : 'no (set NVIDIA_NIM_API_KEY)'}`);
  console.log(`  Model        : ${NIM_MODEL}`);
  console.log(`  Client token : ${CLIENT_TOKEN ? 'required' : 'not required'}`);
  console.log('==============================================');
});
