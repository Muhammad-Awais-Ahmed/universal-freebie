const Module = require('module');
const axios = require('axios');

let candidateCount = 750;
let candidates = Array.from({ length: candidateCount }, (_, index) => `192.0.2.${Math.floor(index / 250) + 1}:${1000 + index}`);
let simulateDead = false;
const originalLoad = Module._load;
const originalGet = axios.get;

Module._load = function(request, parent, isMain) {
  if (request === './database' && parent && parent.filename.endsWith(`${require('path').sep}proxyPool.js`)) {
    return { getSettings: () => ({ proxyPoolEnabled: true }) };
  }
  return originalLoad.apply(this, arguments);
};

axios.get = async (url, options = {}) => {
  if (url.includes('generate_204')) {
    return { status: simulateDead && options.proxy && options.proxy.port >= 1400 ? 502 : 204, data: '' };
  }
  if (url === 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt') {
    return { status: 200, data: candidates.join('\n') };
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
    console.log('PASS: refresh reaches 600 when available and reports exhaustion below target');
  } finally {
    axios.get = originalGet;
    Module._load = originalLoad;
  }
})();
