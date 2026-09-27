#!/usr/bin/env node
/**
 * Local harness for the model fallback chain.
 *
 * The hosted service on Render is the only place that holds NVIDIA_NIM_API_KEY,
 * so this exercises the same code path directly. It prints which model answered
 * and whether the returned installerPath survives the client's own validation.
 *
 * Usage:
 *   node tools/test-model-fallback.js
 *
 * Set NVIDIA_NIM_API_KEY in the environment (or a gitignored .env) first.
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvFile();

const NIM_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const KEY = (process.env.NVIDIA_NIM_API_KEY || '').trim();

const SYSTEM_PROMPT =
  'You identify Windows game installers from a local file listing. ' +
  'Return JSON only with installerPath, confidence, and reason. ' +
  'Never return commands, scripts, URLs, or launch arguments. ' +
  'installerPath must be an existing relative .exe or .msi path, or null if none exists.';

const MODEL_FALLBACKS = [
  'google/gemma-3-12b-it',
  'google/gemma-3-4b-it',
  'mistralai/mistral-7b-instruct-v0.3',
  'nvidia/mistral-nemo-12b-instruct',
  'ibm/granite-3.0-8b-instruct',
];

const FILES = [
  { path: 'setup.exe', extension: '.exe', size: 1234 },
  { path: 'bin\\game.exe', extension: '.exe', size: 88 },
  { path: 'crack\\crack.nfo', extension: '.nfo', size: 99 },
];

async function tryModel(model) {
  const response = await fetch(NIM_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({ gameTitle: 'Test Game', source: 'UnitTest', files: FILES }),
        },
      ],
    }),
  });

  const text = await response.text().catch(() => '');
  return { status: response.status, ok: response.ok, text, json: () => JSON.parse(text) };
}

(async () => {
  if (!KEY) {
    console.log('SKIP: no NVIDIA_NIM_API_KEY in the environment or .env');
    process.exit(0);
  }

  const candidates = ['meta/llama-3.1-8b-instruct', ...MODEL_FALLBACKS];
  let passed = 0;
  let failed = 0;
  let winner = null;

  for (const model of candidates) {
    let result;
    try {
      result = await tryModel(model);
    } catch (error) {
      console.log(`SKIP ${model} -> network error: ${error.message}`);
      continue;
    }

    if (!result.ok) {
      const head = result.text.replace(/\s+/g, ' ').slice(0, 90);
      console.log(`DEAD ${model} -> ${result.status} ${head}`);
      continue;
    }

    if (winner) {
      console.log(`OK   ${model} (fallback not needed)`);
      passed++;
      continue;
    }

    // First model that answers is the one the chain would latch onto.
    winner = model;
    try {
      const content = result.json().choices?.[0]?.message?.content;
      const parsed = JSON.parse(String(content).replace(/^```json\s*/i, '').replace(/```$/, '').trim());
      const installerPath = typeof parsed.installerPath === 'string' ? parsed.installerPath.trim() : '';

      // Mirror the client-side guard: must be a relative .exe/.msi path.
      const extOk = /\.(exe|msi)$/i.test(installerPath);
      const inside = !!installerPath && !installerPath.startsWith('/') && !/^[a-z]:/i.test(installerPath);

      console.log(`LIVE ${model} -> installerPath=${JSON.stringify(installerPath)} confidence=${parsed.confidence}`);
      console.log(`     reason=${String(parsed.reason || '').slice(0, 120)}`);
      console.log(`     client guard: extension=${extOk} relative=${inside}`);

      if (extOk && inside) {
        passed++;
        console.log('PASS: model returns a path the client would accept.');
      } else {
        failed++;
        console.log('FAIL: model returned a path the client would reject.');
      }
    } catch (error) {
      failed++;
      console.log(`FAIL ${model} -> unparseable response: ${error.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(winner ? `Winner: ${winner}` : 'No model answered. Check the API key.');
  process.exit(failed === 0 && winner ? 0 : 1);
})();
