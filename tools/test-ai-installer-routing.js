#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const previous = {
  UNIVERSAL_FREEBIE_AI_URL: process.env.UNIVERSAL_FREEBIE_AI_URL,
  NVIDIA_NIM_BASE_URL: process.env.NVIDIA_NIM_BASE_URL,
  NVIDIA_NIM_API_KEY: process.env.NVIDIA_NIM_API_KEY,
  NIM_API_KEY: process.env.NIM_API_KEY,
  NVIDIA_NIM_MODEL: process.env.NVIDIA_NIM_MODEL,
};
const fixture = path.join(__dirname, '.ai-routing-test');
const installer = path.join(fixture, 'setup.exe');
const realFetch = global.fetch;

function restoreEnv(name, value) {
  if (typeof value === 'undefined') delete process.env[name];
  else process.env[name] = value;
}

(async () => {
  try {
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(installer, 'test installer');
    process.env.UNIVERSAL_FREEBIE_AI_URL = 'direct';
    process.env.NVIDIA_NIM_BASE_URL = 'http://127.0.0.1:20128/v1/chat/completions';
    process.env.NVIDIA_NIM_API_KEY = '';
    process.env.NIM_API_KEY = '';
    process.env.NVIDIA_NIM_MODEL = '21559-M';

    let captured;
    global.fetch = async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: '21559-M',
          choices: [{ message: { content: JSON.stringify({
            installerPath: 'setup.exe', confidence: 0.9, reason: 'test route'
          }) } }],
        }),
      };
    };

    const { planInstall } = require('../src/backend/aiInstaller');
    const result = await planInstall({ filePath: installer, gameTitle: 'Test', source: 'test' });
    if (!captured || captured.url !== process.env.NVIDIA_NIM_BASE_URL) {
      throw new Error('direct mode did not use the configured provider endpoint');
    }
    if (captured.body.model !== '21559-M') {
      throw new Error('configured combo model was not sent to the provider');
    }
    if (captured.options.headers.Authorization) {
      throw new Error('loopback router requests must not require or send a provider key');
    }
    if (!result.ok || result.model !== '21559-M') {
      throw new Error('installer flow did not report the model returned by the provider');
    }

    delete require.cache[require.resolve('../src/backend/aiInstaller')];
    process.env.NVIDIA_NIM_BASE_URL = 'https://provider.example/v1/chat/completions';
    let remoteCalled = false;
    global.fetch = async () => { remoteCalled = true; throw new Error('must not send'); };
    const remoteResult = await require('../src/backend/aiInstaller').planInstall({
      filePath: installer, gameTitle: 'Test', source: 'test'
    });
    if (!remoteResult.error?.includes('API key is required') || remoteCalled) {
      throw new Error('remote providers without a key must be rejected before sending a request');
    }
    console.log('PASS: local combo route works without a key; remote route still requires one');
  } finally {
    global.fetch = realFetch;
    Object.entries(previous).forEach(([name, value]) => restoreEnv(name, value));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
