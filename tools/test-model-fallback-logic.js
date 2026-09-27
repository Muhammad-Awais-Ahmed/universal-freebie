#!/usr/bin/env node
/**
 * Verifies the model fallback chain in ai-backend/server.js without needing an
 * NVIDIA key, express, or the network.
 *
 * The real service has already shown the failure mode: a retired model id
 * answers 410 Gone. This reproduces that with a stub fetch and asserts the
 * chain latches onto the first model that works, and remembers it.
 *
 * Usage: node tools/test-model-fallback-logic.js
 */
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '..', 'ai-backend', 'server.js');
const source = fs.readFileSync(SERVER_PATH, 'utf8');

// Pull the constants and helper straight out of the source so the test cannot
// drift from the implementation. The first entry is an expression, not a plain
// string, so it is evaluated rather than regex-matched.
function extractList(name) {
  const re = new RegExp(`^const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm');
  const match = source.match(re);
  if (!match) throw new Error(`Could not find const ${name} in server.js`);
  return Function(`return [${match[1]}];`)()
    .filter((v) => typeof v === 'string' && v.length > 0);
}

const fallbacks = extractList('MODEL_FALLBACKS');

const helperSource = source.slice(
  source.indexOf('async function requestNim'),
  source.indexOf("app.get('/api/health'")
);

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
  }
}

// 1. Every fallback must be a currently listed NVIDIA model id.
const RETIRED = 'meta/llama-3.1-8b-instruct';
check('configured default is no longer the retired model', !source.includes(`|| '${RETIRED}'`));
check('fallback list is not the retired model', !fallbacks.includes(RETIRED));
check('fallback list is non-empty', fallbacks.length > 0);
check('fallback list has no duplicates', new Set(fallbacks).size === fallbacks.length);

// 2. The chain must treat 410 as "try the next model".
check('treats 410 as a candidate failure', /status === 410/.test(helperSource));
check('treats 404 as a candidate failure', /status === 404/.test(helperSource));
check('does not retry on other errors', /return response; \/\/ Bad key/.test(helperSource));

// 3. It must remember the winner so a retired model costs one call, not one
//    per request.
check('remembers the working model', /preferredModel = model/.test(helperSource));
check('starts from the configured model first', /\[preferredModel, \.\.\.MODEL_FALLBACKS\]/.test(helperSource));

// 4. Exercise the real helper with a stubbed fetch: first model 410s, second works.
async function runChain(behaviour) {
  const requested = [];
  const sandboxFetch = async (url, options) => {
    const model = JSON.parse(options.body).model;
    requested.push(model);
    return behaviour(model);
  };

  const fn = new Function(
    'fetch',
    'NIM_ENDPOINT',
    'NIM_KEY',
    'MODEL_FALLBACKS',
    'SYSTEM_PROMPT',
    'preferredModel',
    `${helperSource}; return requestNim;`
  );

  const realLog = console.log;
  const realError = console.error;
  console.log = () => {};
  console.error = () => {};

  const requestNim = fn(sandboxFetch, 'https://example.invalid', 'test-key', fallbacks, 'sys', fallbacks[0]);
  const result = await requestNim({ gameTitle: 'G', source: 'T', files: [] });

  console.log = realLog;
  console.error = realError;
  return { requested, result };
}

function gemmaOk(model) {
  return {
    ok: true,
    status: 200,
    modelUsed: model,
    text: async () => JSON.stringify({ choices: [{ message: { content: '{"installerPath":"setup.exe","confidence":0.9,"reason":"ok"}' } }] }),
    json: async () => ({ choices: [{ message: { content: '{"installerPath":"setup.exe","confidence":0.9,"reason":"ok"}' } }] }),
  };
}

(async () => {
  // Case A: first model 410s, next one works.
  {
    const { requested, result } = await runChain((model) => {
      if (model === fallbacks[0]) return { ok: false, status: 410, text: async () => 'model retired' };
      if (model === fallbacks[1]) return gemmaOk(model);
      throw new Error(`unexpected extra call to ${model}`);
    });

    check('A: tried the configured model first', requested[0] === fallbacks[0]);
    check('A: fell through to the next candidate', requested[1] === fallbacks[1]);
    check('A: returned a successful response', result.ok === true);
    check('A: no wasted call after success', requested.length === 2);
    check('A: reports the model that answered', result.modelUsed === fallbacks[1]);
  }

  // Case B: several models are dead, must keep walking.
  {
    const dead = new Set(fallbacks.slice(0, 3));
    const { requested, result } = await runChain((model) => {
      if (dead.has(model)) return { ok: false, status: 410, text: async () => 'gone' };
      return gemmaOk(model);
    });

    check('B: skipped three unavailable models', requested.length === 4);
    check('B: succeeded on the fourth', result.ok === true);
    check('B: no duplicates requested', new Set(requested).size === requested.length);
  }

  // Case C: every model dead -> failure is reported, not swallowed.
  {
    const { result } = await runChain(() => ({ ok: false, status: 410, text: async () => 'gone' }));
    check('C: all-dead surfaces a failure', result.ok === false);
  }

  // Case D: a real error (bad key) must NOT be masked by trying other models.
  {
    const { requested, result } = await runChain(() => ({ ok: false, status: 401, text: async () => 'bad key' }));
    check('D: bad key stops immediately', requested.length === 1);
    check('D: 401 is surfaced', result.ok === false && result.status === 401);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('Harness error:', error.message);
  process.exit(1);
});
