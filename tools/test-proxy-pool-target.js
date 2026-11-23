const Module = require('module');
const axios = require('axios');

let candidateCount = 750;
let candidates = Array.from({ length: candidateCount }, (_, index) => `192.0.2.${Math.floor(index / 250) + 1}:${1000 + index}`);
let simulateDead = false;
let failAllSources = false;
let emptySources = false;
const originalLoad = Module._load;
const originalGet = axios.get;

Module._load = function(request, parent, isMain) {
  if (request === './database' && parent && parent.filename.endsWith(`${require('path').sep}proxyPool.js`)) {
    return { getSettings: () => ({ proxyPoolEnabled: true }) };
  }
  return originalLoad.apply(this, arguments);
};

axios.get = async (url, options = {}) => {
  if (failAllSources) throw new Error('simulated source outage');
  if (url.includes('generate_204')) {
    return { status: simulateDead && options.proxy && options.proxy.port >= 1400 ? 502 : 204, data: '' };
  }
  if (url === 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt') {
    return { status: 200, data: emptySources ? '' : candidates.join('\n') };
  }
  return { status: 200, data: '' };
};

(async () => {
  try {
    const proxyPool = require('../src/backend/proxyPool');
    const status = await proxyPool.refreshProxyPool();
    if (status.workingCount < 600) {
      console.error(`FAIL: expected at least 600 verified proxies, got ${status.workingCount}`);
      process.exitCode = 1;
      return;
    }
    candidateCount = 420;
    candidates = Array.from({ length: candidateCount }, (_, index) => `198.51.100.${Math.floor(index / 250) + 1}:${1000 + index}`);
    simulateDead = true;
    const exhausted = await proxyPool.refreshProxyPool();
    if (exhausted.workingCount !== 400 || !exhausted.error?.includes('Only 400 verified proxies')) {
      console.error('FAIL: exhausting a short feed must retain verified proxies and report the 600-target shortfall');
      console.error(exhausted);
      process.exitCode = 1;
      return;
    }

    candidates = Array.from({ length: 420 }, (_, index) => `203.0.113.${Math.floor(index / 250) + 1}:${1500 + index}`);
    const noWorking = await proxyPool.refreshProxyPool();
    if (noWorking.workingCount !== 400 || !noWorking.error?.includes('previous verified pool was retained')) {
      console.error('FAIL: a refresh with no working candidates must retain the previous verified pool');
      console.error(noWorking);
      process.exitCode = 1;
      return;
    }

    emptySources = true;
    const empty = await proxyPool.refreshProxyPool();
    if (empty.workingCount !== 400 || !empty.error?.includes('no candidates')) {
      console.error('FAIL: empty feeds must retain the previous verified pool');
      console.error(empty);
      process.exitCode = 1;
      return;
    }

    failAllSources = true;
    const outage = await proxyPool.refreshProxyPool();
    if (outage.workingCount !== 400 || !outage.error?.includes('All proxy list sources failed')) {
      console.error('FAIL: a source outage must preserve the last verified pool and report the outage');
      console.error(outage);
      process.exitCode = 1;
      return;
    }
    console.log('PASS: refresh targets 600, reports short feeds, and retains verified proxies during source outages');
  } finally {
    axios.get = originalGet;
    Module._load = originalLoad;
  }
})();
