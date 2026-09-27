#!/usr/bin/env node
/**
 * Render env-var helper for the `universal-freebie-ai` service.
 *
 * Why this exists: the desktop app is meant to run with zero configuration.
 * The NVIDIA key lives only in Render, and the app-level AI_CLIENT_TOKEN is not
 * wanted at all. Render keeps dashboard-set env vars even after you delete them
 * from render.yaml, so the stale token has to be removed through the API/dash.
 * Doing it by hand is two steps; this does it in one and verifies the result.
 *
 * The API key is read from the repo-root .env (which .gitignore already
 * excludes) so it never has to be pasted into a chat window, a commit, or
 * shell history.
 *
 * Setup (once):
 *   1. Render dashboard -> Account Settings -> API Keys -> create a key.
 *   2. Create a file named `.env` in the repo root containing:
 *        RENDER_API_KEY=rnd_xxxxxxxxxxxxxxxx
 *   3. Delete the key from Render afterwards if you only needed this once.
 *
 * Usage:
 *   node tools/render-env.js status
 *   node tools/render-env.js remove-token --apply
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.render.com/v1';
const SERVICE_NAME = 'universal-freebie-ai';
const TARGET_VAR = 'AI_CLIENT_TOKEN';
const HEALTH_URL = 'https://universal-freebie-ai.onrender.com/api/health';
const DEPLOY_WAIT_MS = 8 * 60 * 1000;

function loadKey() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `No .env found at ${envPath}\n` +
      'Create it with one line: RENDER_API_KEY=<your key from Render Account Settings>'
    );
  }
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*RENDER_API_KEY\s*=\s*(.*?)\s*$/);
    if (match) {
      const value = match[1].replace(/^["']|["']$/g, '').trim();
      if (value) return value;
    }
  }
  throw new Error('RENDER_API_KEY is missing from .env');
}

async function api(key, method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail = (data && data.message) ? data.message : String(data).slice(0, 200);
    throw new Error(`${method} ${endpoint} -> ${res.status}: ${detail}`);
  }
  return data;
}

async function findServiceId(key) {
  const services = await api(key, 'GET', '/services?limit=100');
  const list = Array.isArray(services) ? services : (services && services.services) || [];
  const match = list.find((s) => s && s.name === SERVICE_NAME);
  if (!match) {
    throw new Error(`No Render service named "${SERVICE_NAME}" on this account.`);
  }
  return match.id;
}

// Only ever prints KEYS, never values, so this is safe to paste into a chat.
async function listEnvKeys(key, serviceId) {
  const vars = await api(key, 'GET', `/services/${serviceId}/env-vars`);
  const list = Array.isArray(vars) ? vars : (vars && vars.envVars) || [];
  return list.map((v) => v.envVar && v.envVar.key).filter(Boolean);
}

async function readHealth() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { ok: false, status: res.status };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pollUntilPublic(deadline) {
  let last = null;
  while (Date.now() < deadline) {
    last = await readHealth();
    if (last && last.clientTokenRequired === false) return last;
    if (last && last.error) {
      // Free-tier services sleep; a cold start just means "not ready yet".
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 10000));
  }
  return last;
}

async function main() {
  const command = process.argv[2] || 'status';
  const apply = process.argv.includes('--apply');

  if (!['status', 'remove-token'].includes(command)) {
    console.error(`Unknown command "${command}". Use: status | remove-token --apply`);
    process.exit(2);
  }

  const key = loadKey();
  const serviceId = await findServiceId(key);
  const envKeys = await listEnvKeys(key, serviceId);
  const health = await readHealth();

  console.log(`Service        : ${SERVICE_NAME} (${serviceId})`);
  console.log(`Env var keys   : ${envKeys.join(', ') || '(none)'}`);
  console.log(`NIM key present: ${envKeys.includes('NVIDIA_NIM_API_KEY') ? 'yes' : 'NO'}`);
  console.log(`Client token   : ${health && health.clientTokenRequired ? 'REQUIRED (blocker)' : 'not required'}`);

  if (command === 'status') {
    const ready = health && health.ok && health.aiConfigured && health.clientTokenRequired === false;
    console.log(`\n${ready ? 'READY - the app needs no key or token.' : 'NOT READY - see the blocker above.'}`);
    return;
  }

  if (!envKeys.includes(TARGET_VAR)) {
    console.log(`\n${TARGET_VAR} is already gone from Render. Nothing to do.`);
    return;
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete ${TARGET_VAR} and redeploy.`);
    console.log(`NVIDIA_NIM_API_KEY will NOT be touched.`);
    return;
  }

  console.log(`\nDeleting ${TARGET_VAR}...`);
  await api(key, 'DELETE', `/services/${serviceId}/env-vars/${encodeURIComponent(TARGET_VAR)}`);
  console.log('Deleted. Triggering a deploy (free tier can take a few minutes)...');

  const deploy = await api(key, 'POST', `/services/${serviceId}/deploys`, { clearCache: 'do_not_clear' });
  console.log(`Deploy ${deploy && deploy.id ? deploy.id : 'started'}. Waiting for health`);

  const result = await pollUntilPublic(Date.now() + DEPLOY_WAIT_MS);
  console.log('\n---');
  if (result && result.clientTokenRequired === false) {
    console.log(`Done. clientTokenRequired is now false. Auto-install works with zero setup.`);
  } else {
    console.log('Still not public. Check the Render deploy log, then run: node tools/render-env.js status');
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});
