const axios = require('axios');

// ------------------------------------------------------------------
// Proxy Pool
// ------------------------------------------------------------------
// Downloads free proxy lists from public GitHub repositories, tests
// each candidate proxy with a tiny request, keeps the fastest working
// ones, and hands them out round-robin so download chunks can run
// through MANY different IPs at once (more parallel "peers", which
// often defeats per-IP throttling on game hosts and boosts speed).
// ------------------------------------------------------------------

// Public free-proxy list repositories on GitHub (raw file URLs).
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt'
];

// Proxy validation endpoint: returns HTTP 204, tiny and fast.
const TEST_URL = 'http://www.gstatic.com/generate_204';

const VALIDATION_CONCURRENCY = 25;   // parallel tests while refreshing
const MAX_CANDIDATES = 400;          // max proxies to actually test per refresh
const MAX_PROXIES = 40;              // keep the N fastest working proxies
const TEST_TIMEOUT_MS = 5000;

const state = {
  proxies: [],       // [{ host, port, latencyMs }]
  cursor: 0,
  lastUpdated: 0,
  updating: false,
  error: null
};

function isEnabled() {
  try {
    const db = require('./database');
    const s = db.getSettings();
    return !!(s && s.proxyPoolEnabled);
  } catch (err) {
    return false;
  }
}

function hasProxies() {
  return isEnabled() && state.proxies.length > 0;
}

function getStatus() {
  return {
    enabled: isEnabled(),
    count: state.proxies.length,
    lastUpdated: state.lastUpdated,
    updating: state.updating,
    error: state.error,
    sources: PROXY_SOURCES.length
  };
}

// Fetch + parse candidate "host:port" entries from all GitHub lists.
async function fetchRawCandidates() {
  const seen = new Set();
  const candidates = [];

  const sources = PROXY_SOURCES.slice();
  // Shuffle so we don't always favor the same list.
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sources[i], sources[j]] = [sources[j], sources[i]];
  }

  for (const url of sources) {
    if (candidates.length >= MAX_CANDIDATES) break;
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const lines = String(res.data).split(/\r?\n/);
      for (const line of lines) {
        if (candidates.length >= MAX_CANDIDATES) break;
        const t = line.trim();
        // Formats: "host:port" or "host:port:user:pass" or "host:port#country"
        const m = t.match(/^([0-9a-zA-Z.-]+):(\d{2,5})(?::[^:]+:[^:]+)?(?:#.*)?$/);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ host: m[1], port: parseInt(m[2], 10) });
      }
    } catch (err) {
      console.warn(`Proxy list fetch failed (${url}):`, err.message);
    }
  }
  return candidates;
}

// Returns latency in ms, or null if the proxy is dead.
async function testProxy(host, port) {
  const t0 = Date.now();
  try {
    const res = await axios.get(TEST_URL, {
      proxy: { protocol: 'http', host, port },
      timeout: TEST_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.status === 204 || res.status === 200) return Date.now() - t0;
  } catch (err) {
    // Dead proxy
  }
  return null;
}

/**
 * Refresh the pool: download lists from GitHub, test candidates, keep
 * the fastest working proxies. Safe to call repeatedly (no-ops while a
 * refresh is already running).
 */
async function refreshProxyPool() {
  if (state.updating) return getStatus();
  state.updating = true;
  state.error = null;
  try {
    const candidates = await fetchRawCandidates();
    const working = [];

    let idx = 0;
    async function worker() {
      while (idx < candidates.length) {
        const cur = idx++;
        const c = candidates[cur];
        const latency = await testProxy(c.host, c.port);
        if (latency !== null) {
          working.push({ host: c.host, port: c.port, latencyMs: latency });
        }
      }
    }

    await Promise.all(Array.from({ length: VALIDATION_CONCURRENCY }, () => worker()));

    working.sort((a, b) => a.latencyMs - b.latencyMs);
    state.proxies = working.slice(0, MAX_PROXIES);
    state.cursor = 0;
    state.lastUpdated = Date.now();
    console.log(`Proxy pool refresh complete: ${state.proxies.length} working proxies (${candidates.length} tested).`);
  } catch (err) {
    state.error = err.message;
    console.error('Proxy pool refresh error:', err.message);
  } finally {
    state.updating = false;
  }
  return getStatus();
}

/**
 * Round-robin pick of the next proxy, or null when the pool is
 * disabled / empty. Returned object is safe to pass to axios as the
 * `proxy` option.
 */
function getNextProxy() {
  if (!isEnabled() || state.proxies.length === 0) return null;
  const p = state.proxies[state.cursor % state.proxies.length];
  state.cursor++;
  return { protocol: 'http', host: p.host, port: p.port };
}

/**
 * Drop a proxy that just failed a chunk request so we stop wasting
 * attempts on it.
 */
function markFailed(host, port) {
  const before = state.proxies.length;
  state.proxies = state.proxies.filter(p => !(p.host === host && p.port === port));
  if (state.proxies.length !== before && state.cursor >= state.proxies.length) {
    state.cursor = 0;
  }
}

module.exports = {
  isEnabled,
  hasProxies,
  getStatus,
  refreshProxyPool,
  getNextProxy,
  markFailed,
  PROXY_SOURCES
};
