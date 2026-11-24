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

const { resolveModelRoutes, MAX_MODEL_ROUTES } = require('../ai-backend/modelRouting');
const fallbacks = resolveModelRoutes({}).models;
const CURRENT_MODELS = [
  'nvidia/nemotron-3.5-bolt-e4b',
  'google/gemma-4-31b-it',
  'mistralai/mistral-large-4-1t-a52b',
];

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

// 1. The configured route list must use currently documented NVIDIA NIM IDs.
check('current NVIDIA NIM models are the built-in routes', JSON.stringify(fallbacks) === JSON.stringify(CURRENT_MODELS));
check('fallback list is non-empty', fallbacks.length > 0);
check('fallback list has no duplicates', new Set(fallbacks).size === fallbacks.length);
const comboRoutes = resolveModelRoutes({
  NVIDIA_NIM_MODEL: '21559-M',
  NVIDIA_NIM_FALLBACK_MODELS: 'route-b,route-c,route-d,route-e,route-f,route-g,route-h,route-i,route-j'
});
check('custom model combo is the primary route', comboRoutes.primary === '21559-M');
check('configured model routing is capped at nine distinct routes', comboRoutes.models.length === MAX_MODEL_ROUTES);
check('configured routes stay unique', new Set(comboRoutes.models).size === comboRoutes.models.length);

// 2. The chain must treat 410 as "try the next model".
check('treats 410 as a candidate failure', /status === 410/.test(helperSource));
check('treats 404 as a candidate failure', /status === 404/.test(helperSource));
check('does not retry on other errors', /return response; \/\/ Bad key/.test(helperSource));

// 3. It must remember the winner so a retired model costs one call, not one
//    per request.
check('remembers the working model', /preferredModel = model/.test(helperSource));
check('starts from the configured model first', /\[preferredModel, \.\.\.MODEL_FALLBACKS\]/.test(helperSource));

// 4. Exercise the real helper with a stubbed fetch: first model 410s, second works.
async function runChain(behaviour, models = fallbacks) {
  const requested = [];
  const requestBodies = [];
  const sandboxFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const model = body.model;
    requested.push(model);
    requestBodies.push(body);
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

  const requestNim = fn(sandboxFetch, 'https://example.invalid', 'test-key', models, 'sys', models[0]);
  const result = await requestNim({ gameTitle: 'G', source: 'T', files: [] });

  console.log = realLog;
  console.error = realError;
  return { requested, requestBodies, result };
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
  // A custom combo model is sent first when configured, then falls back normally.
  {
    const { requested, requestBodies, result } = await runChain((model) => gemmaOk(model), comboRoutes.models);
    check('combo route is requested first', requested[0] === '21559-M');
    check('combo route can return success', result.ok === true && result.modelUsed === '21559-M');
    check('NIM request disables streaming for JSON parsing', requestBodies[0].stream === false);
    check('NIM request omits unsupported response_format', !('response_format' in requestBodies[0]));
  }

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
    const dead = new Set(fallbacks.slice(0, 2));
    const { requested, result } = await runChain((model) => {
      if (dead.has(model)) return { ok: false, status: 410, text: async () => 'gone' };
      return gemmaOk(model);
    });

    check('B: skipped two unavailable models', requested.length === 3);
    check('B: succeeded on the third', result.ok === true);
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
