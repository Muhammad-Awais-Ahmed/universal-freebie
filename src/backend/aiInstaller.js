const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NIM_ENDPOINT = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const AI_PROXY_URL = process.env.UNIVERSAL_FREEBIE_AI_URL || 'https://universal-freebie-ai.onrender.com/api/ai/install-plan';
const AI_PROXY_TOKEN = process.env.UNIVERSAL_FREEBIE_AI_TOKEN || '';
const NIM_MODEL = process.env.NVIDIA_NIM_MODEL || 'meta/llama-3.1-8b-instruct';
const MAX_FILES = 250;

function getApiKey() {
  return (process.env.NVIDIA_NIM_API_KEY || process.env.NIM_API_KEY || '').trim();
}

function resolveInside(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(rootPath, candidate);
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return candidatePath;
}

function safePowerShellPath(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function extractZip(archivePath, downloadDirectory, gameTitle) {
  const folderName = String(gameTitle || path.basename(archivePath, path.extname(archivePath)))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 80) || 'game';
  const targetDirectory = path.join(downloadDirectory, 'Universal-Freebie-Installs', folderName);
  fs.mkdirSync(targetDirectory, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${safePowerShellPath(archivePath)} -DestinationPath ${safePowerShellPath(targetDirectory)} -Force`
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';
    child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(targetDirectory);
      else reject(new Error(errorOutput.trim() || `Archive extraction failed with exit code ${code}.`));
    });
  });
}

function listFiles(rootDirectory) {
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 5 || files.length >= MAX_FILES) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isDirectory()) {
        visit(absolutePath, depth + 1);
      } else {
        const stat = fs.statSync(absolutePath);
        files.push({
          path: path.relative(rootDirectory, absolutePath),
          extension: path.extname(entry.name).toLowerCase(),
          size: stat.size
        });
      }
    }
  };
  visit(rootDirectory, 0);
  return files;
}

function parseJson(content) {
  const cleaned = String(content || '').replace(/^```json\s*|```$/g, '').trim();
  return JSON.parse(cleaned);
}

function extractPlan(payload) {
  // The AI backend returns the normalized shape; direct NIM calls return
  // the raw OpenAI-compatible one. Support both.
  if (payload && typeof payload.installerPath !== 'undefined' && !payload.choices) {
    return {
      installerPath: payload.installerPath,
      confidence: payload.confidence,
      reason: payload.reason,
    };
  }
  return parseJson(payload && payload.choices && payload.choices[0] && payload.choices[0].message.content);
}

async function planInstall({ filePath, gameTitle, source }) {
  const apiKey = getApiKey();
  if (!AI_PROXY_URL && !apiKey) {
    return { error: 'NVIDIA NIM is not configured. Set NVIDIA_NIM_API_KEY in the terminal before starting the app.' };
  }
  if (!fs.existsSync(filePath)) return { error: 'The downloaded file is no longer available.' };

  let scanRoot = path.dirname(filePath);
  let selectedFile = null;
  if (path.extname(filePath).toLowerCase() === '.zip') {
    try {
      scanRoot = await extractZip(filePath, path.dirname(filePath), gameTitle);
    } catch (error) {
      return { error: error.message };
    }
  } else if (fs.statSync(filePath).isDirectory()) {
    scanRoot = filePath;
  } else if (['.exe', '.msi'].includes(path.extname(filePath).toLowerCase())) {
    selectedFile = filePath;
  }

  const files = selectedFile
    ? [{
        path: path.basename(selectedFile),
        extension: path.extname(selectedFile).toLowerCase(),
        size: fs.statSync(selectedFile).size
      }]
    : listFiles(scanRoot);
  if (!files.length) return { error: 'No files were found to inspect.' };

  const requestBody = {
    gameTitle: gameTitle || 'Unknown game',
    source: source || 'Unknown',
    files
  };
  const response = await fetch(AI_PROXY_URL || NIM_ENDPOINT, {
    method: 'POST',
    headers: {
      ...(AI_PROXY_URL ? (AI_PROXY_TOKEN ? { 'X-App-Token': AI_PROXY_TOKEN } : {}) : { Authorization: `Bearer ${apiKey}` }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(AI_PROXY_URL ? requestBody : {
      model: NIM_MODEL,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You identify Windows game installers from a local file listing. Return JSON only with installerPath, confidence, and reason. Never return commands, scripts, URLs, or launch arguments. installerPath must be an existing relative .exe or .msi path, or null if none exists.'
        },
        {
          role: 'user',
          content: JSON.stringify(requestBody)
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`NVIDIA NIM request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  const payload = await response.json();
  const result = extractPlan(payload);
  const installerPath = typeof result.installerPath === 'string' ? result.installerPath : '';
  const installer = installerPath ? resolveInside(scanRoot, installerPath) : null;
  if (!installer || !fs.existsSync(installer) || !['.exe', '.msi'].includes(path.extname(installer).toLowerCase())) {
    return { error: result.reason || 'AI could not identify a safe Windows installer in this download.' };
  }

  return {
    ok: true,
    installerPath: installer,
    displayPath: path.relative(path.dirname(filePath), installer),
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    reason: String(result.reason || 'Installer candidate detected.'),
    model: NIM_MODEL
  };
}

function runInstaller(installerPath, downloadDirectory) {
  const installer = resolveInside(downloadDirectory, path.relative(downloadDirectory, installerPath));
  if (!installer || !fs.existsSync(installer)) return { ok: false, error: 'Installer was not found.' };
  const extension = path.extname(installer).toLowerCase();
  const command = extension === '.msi' ? 'msiexec.exe' : installer;
  const args = extension === '.msi' ? ['/i', installer] : [];
  const child = spawn(command, args, { cwd: path.dirname(installer), detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true };
}

module.exports = { planInstall, runInstaller };