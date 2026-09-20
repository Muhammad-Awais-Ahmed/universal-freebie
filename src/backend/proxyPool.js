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

// Curated, actively updated public free-proxy repositories on GitHub
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt',
  'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt',
  'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt',
  'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt',
  'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/master/proxy_files/http_proxies.txt'
];

// Validation targets: tiny endpoints returning HTTP 204/200 quickly
const PRIMARY_TEST_URL = 'http://www.gstatic.com/generate_204';
const FALLBACK_TEST_URL = 'http://cp.cloudflare.com/generate_204';

const VALIDATION_CONCURRENCY = 35; // parallel checks for fast speed
const MAX_CANDIDATES = 600;        // candidates to test per full refresh
const MAX_PROXIES = 60;            // keep the N fastest verified proxies
const TEST_TIMEOUT_MS = 3500;      // max wait per proxy test

const state = {
  rawCandidates: [],  // [{ host, port }] - all loaded candidates from GitHub
  proxies: [],        // [{ host, port, latencyMs, lastChecked }] - validated working proxies
  cursor: 0,
  lastUpdated: null,
  lastValidated: null,
  updating: false,
  validating: false,
  error: null,
  stats: {
    totalLoaded: 0,
    staleRemoved: 0,
  }
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
  const working = state.proxies;
  const latencies = working.map(p => p.latencyMs).filter(n => typeof n === 'number');
  const fastest = latencies.length ? Math.min(...latencies) : null;
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const total = state.rawCandidates.length || state.stats.totalLoaded || 0;
  const stale = state.stats.staleRemoved || 0;
  const tested = working.length + stale;
  const inReserve = Math.max(0, total - tested);

  return {
    enabled: isEnabled(),
    updating: state.updating,
    validating: state.validating,
    totalLoaded: total,
    testedCount: tested,
    inReserve: inReserve,
    workingCount: working.length,
    staleRemoved: stale,
    fastestLatency: fastest,
    avgLatency: avg,
    lastUpdated: state.lastUpdated,
    lastValidated: state.lastValidated,
    error: state.error,
    sourcesCount: PROXY_SOURCES.length,
    proxies: working.slice(0, 16).map(p => ({
      host: p.host,
      port: p.port,
      latency: p.latencyMs
    }))
  };
}

/**
 * Fetch and parse candidate "host:port" entries from all GitHub repositories in parallel.
 */
async function fetchRawCandidates() {
  const seen = new Set();
  const candidates = [];

  const fetchPromises = PROXY_SOURCES.map(async (url) => {
    try {
      const res = await axios.get(url, {
        timeout: 6000,
        responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const lines = String(res.data).split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        // Parse host:port, http://host:port, or host:port:user:pass
        const clean = t.replace(/^(?:https?|socks[45]):\/\//i, '');
        const m = clean.match(/^([0-9a-zA-Z.-]+):(\d{2,5})/);
        if (!m) continue;
        const host = m[1];
        const port = parseInt(m[2], 10);
        if (port <= 0 || port > 65535) continue;
        const key = `${host}:${port}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ host, port });
        }
      }
    } catch (err) {
      // Best-effort across multiple sources
    }
  });

  await Promise.allSettled(fetchPromises);

  // Shuffle candidates to avoid clustering by single repository
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  state.rawCandidates = candidates;
  state.stats.totalLoaded = candidates.length;
  return candidates;
}

/**
 * Tests proxy connectivity and returns latency in milliseconds, or null if dead/stale.
 */
async function testProxy(host, port, timeoutMs = TEST_TIMEOUT_MS) {
  const t0 = Date.now();
  try {
    const res = await axios.get(PRIMARY_TEST_URL, {
      proxy: { protocol: 'http', host, port },
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.status === 204 || res.status === 200) {
      return Date.now() - t0;
    }
  } catch (err) {
    // Primary failed, quick fallback check
    try {
      const res = await axios.get(FALLBACK_TEST_URL, {
        proxy: { protocol: 'http', host, port },
        timeout: Math.min(2500, timeoutMs),
        maxRedirects: 0,
        validateStatus: (s) => s < 400,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.status === 204 || res.status === 200) {
        return Date.now() - t0;
      }
    } catch (err2) {
      // Dead proxy
    }
  }
  return null;
}

/**
 * Validating mechanism:
 * Re-tests all currently loaded / active proxies, eliminates stale ones,
 * updates latencies, and sorts by performance.
 */
async function validateProxies() {
  if (state.validating || state.updating) return getStatus();
  state.validating = true;
  state.error = null;

  try {
    // Test active proxies plus up to 120 fresh candidates from reserve
    const targets = state.proxies.slice();
    if (state.rawCandidates.length) {
      const activeKeys = new Set(targets.map(p => `${p.host}:${p.port}`));
      const fresh = state.rawCandidates.filter(c => !activeKeys.has(`${c.host}:${c.port}`));
      targets.push(...fresh.slice(0, 120));
    } else {
      await fetchRawCandidates();
      targets.push(...state.rawCandidates.slice(0, 150));
    }

    const working = [];
    let staleCount = 0;
    let idx = 0;

    async function worker() {
      while (idx < targets.length) {
        const cur = idx++;
        const p = targets[cur];
        const latency = await testProxy(p.host, p.port, 3000);
        if (latency !== null) {
          working.push({ host: p.host, port: p.port, latencyMs: latency, lastChecked: Date.now() });
        } else {
          staleCount++;
        }
      }
    }

    await Promise.all(Array.from({ length: VALIDATION_CONCURRENCY }, () => worker()));

    working.sort((a, b) => a.latencyMs - b.latencyMs);
    state.proxies = working.slice(0, MAX_PROXIES);
    state.stats.staleRemoved += staleCount;
    state.cursor = 0;
    state.lastValidated = Date.now();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.validating = false;
  }

  return getStatus();
}

/**
 * Refresh the pool from GitHub:
 * Downloads fresh proxy lists from 12+ GitHub repos, tests candidates in parallel,
 * keeps the fastest verified working proxies, and drops stale ones.
 */
async function refreshProxyPool() {
  if (state.updating) return getStatus();
  state.updating = true;
  state.error = null;

  try {
    const candidates = await fetchRawCandidates();
    const testSlice = candidates.slice(0, MAX_CANDIDATES);
    const working = [];
    let staleCount = 0;
    let idx = 0;

    async function worker() {
      while (idx < testSlice.length) {
        const cur = idx++;
        const c = testSlice[cur];
        const latency = await testProxy(c.host, c.port);
        if (latency !== null) {
          working.push({ host: c.host, port: c.port, latencyMs: latency, lastChecked: Date.now() });
        } else {
          staleCount++;
        }
      }
    }

    await Promise.all(Array.from({ length: VALIDATION_CONCURRENCY }, () => worker()));

    working.sort((a, b) => a.latencyMs - b.latencyMs);
    state.proxies = working.slice(0, MAX_PROXIES);
    state.stats.staleRemoved += staleCount;
    state.cursor = 0;
    state.lastUpdated = Date.now();
    state.lastValidated = Date.now();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.updating = false;
  }

  return getStatus();
}

/**
 * Round-robin pick of the next proxy, or null when disabled or empty.
 */
function getNextProxy() {
  if (!isEnabled() || state.proxies.length === 0) return null;
  const p = state.proxies[state.cursor % state.proxies.length];
  state.cursor++;
  return { protocol: 'http', host: p.host, port: p.port };
}

/**
 * Drop a proxy that failed a chunk download request.
 */
function markFailed(host, port) {
  const before = state.proxies.length;
  state.proxies = state.proxies.filter(p => !(p.host === host && p.port === port));
  if (state.proxies.length !== before) {
    state.stats.staleRemoved++;
    if (state.cursor >= state.proxies.length) {
      state.cursor = 0;
    }
  }
}

module.exports = {
  isEnabled,
  hasProxies,
  getStatus,
  fetchRawCandidates,
  validateProxies,
  refreshProxyPool,
  getNextProxy,
  markFailed,
  PROXY_SOURCES
};

