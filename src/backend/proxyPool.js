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
const MIN_WORKING_PROXIES = 600;   // test until this many candidates pass validation
const VALIDATION_BATCH_SIZE = 120;
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
    lastError: state.error,
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
        // This pool validates HTTP proxies; SOCKS endpoints need a different agent.
        const scheme = t.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (scheme && !/^https?$/i.test(scheme[1])) continue;
        // Parse host:port, http://host:port, or host:port:user:pass
        const clean = t.replace(/^https?:\/\//i, '');
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

async function testUntilTarget(candidates, initialWorking = []) {
  const working = initialWorking.slice();
  const known = new Set(working.map(p => `${p.host}:${p.port}`));
  let staleCount = 0;

  for (let offset = 0; offset < candidates.length && working.length < MIN_WORKING_PROXIES; offset += VALIDATION_BATCH_SIZE) {
    const batch = candidates
      .slice(offset, offset + VALIDATION_BATCH_SIZE)
      .filter(candidate => !known.has(`${candidate.host}:${candidate.port}`));
    let idx = 0;

    async function worker() {
      while (idx < batch.length && working.length < MIN_WORKING_PROXIES) {
        const candidate = batch[idx++];
        const latency = await testProxy(candidate.host, candidate.port);
        const key = `${candidate.host}:${candidate.port}`;
        if (latency !== null) {
          if (!known.has(key)) {
            known.add(key);
            working.push({ host: candidate.host, port: candidate.port, latencyMs: latency, lastChecked: Date.now() });
          }
        } else {
          staleCount++;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(VALIDATION_CONCURRENCY, batch.length) }, () => worker()));
  }

  working.sort((a, b) => a.latencyMs - b.latencyMs);
  return { working: working.slice(0, MIN_WORKING_PROXIES), staleCount };
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
    const active = state.proxies.slice();
    if (!state.rawCandidates.length) await fetchRawCandidates();

    const activeKeys = new Set(active.map(p => `${p.host}:${p.port}`));
    const fresh = state.rawCandidates.filter(c => !activeKeys.has(`${c.host}:${c.port}`));
    const checkedActive = await testUntilTarget(active);
    const checked = await testUntilTarget(fresh, checkedActive.working);

    state.proxies = checked.working;
    state.stats.staleRemoved += checkedActive.staleCount + checked.staleCount;
    state.cursor = 0;
    state.lastValidated = Date.now();
    if (state.proxies.length < MIN_WORKING_PROXIES) {
      state.error = `Only ${state.proxies.length} verified proxies were available after testing all candidates.`;
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    state.validating = false;
  }

  return getStatus();
}

/**
 * Refresh the pool from GitHub:
 * Downloads proxy lists, testing batches until 600 working proxies are found
 * or every fetched candidate has been checked.
 */
async function refreshProxyPool() {
  if (state.updating) return getStatus();
  state.updating = true;
  state.error = null;

  try {
    const candidates = await fetchRawCandidates();
    const result = await testUntilTarget(candidates);
    state.proxies = result.working;
    state.stats.staleRemoved += result.staleCount;
    state.cursor = 0;
    state.lastUpdated = Date.now();
    state.lastValidated = Date.now();
    if (state.proxies.length < MIN_WORKING_PROXIES) {
      state.error = `Only ${state.proxies.length} verified proxies were available after testing all candidates.`;
    }
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

