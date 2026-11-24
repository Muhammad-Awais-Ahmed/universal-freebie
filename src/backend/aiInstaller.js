const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NIM_ENDPOINT = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
// The hosted AI service is public: no key, no token, no account. Access is
// protected by the backend's per-IP rate limit rather than by a shared secret,
// because a desktop app could never keep one secret anyway.
const configuredAiUrl = (process.env.UNIVERSAL_FREEBIE_AI_URL || '').trim();
const AI_PROXY_URL = /^direct$/i.test(configuredAiUrl)
  ? ''
  : configuredAiUrl || 'https://universal-freebie-ai.onrender.com/api/ai/install-plan';
// Used only in explicit local direct mode; the hosted service remains the
// default so provider credentials stay server-side.
const NIM_MODEL = process.env.NVIDIA_NIM_MODEL || 'nvidia/nemotron-3.5-bolt-e4b';
const MAX_FILES = 250;

// Folders are split on purpose: archives are staged in `Installs`, the
// installed game lives in `Installed`. That keeps the auto-delete step
// able to wipe the staging tree without ever touching the game.
const STAGING_DIR_NAME = 'Universal-Freebie-Installs';
const INSTALLED_DIR_NAME = 'Universal-Freebie-Installed';

// Extra archives (.bin, .dat, .nupkg ...) that shipped with the download.
// They are only ever deleted alongside their owning download folder.
const AUX_EXTENSIONS = new Set(['.bin', '.dat', '.nupkg', '.cab', '.msi']);

function getApiKey() {
  return (process.env.NVIDIA_NIM_API_KEY || process.env.NIM_API_KEY || '').trim();
}

function isLoopbackEndpoint(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch (error) {
    return false;
  }
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
  const targetDirectory = path.join(downloadDirectory, STAGING_DIR_NAME, folderName);
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
    child.once('error', (error) => {
      try { fs.rmSync(targetDirectory, { recursive: true, force: true }); } catch (e) {}
      reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) resolve(targetDirectory);
      else {
        try { fs.rmSync(targetDirectory, { recursive: true, force: true }); } catch (e) {}
        reject(new Error(errorOutput.trim() || `Archive extraction failed with exit code ${code}.`));
      }
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

// ---------------------------------------------------------------------------
// Dependency detection
//
// The model is only ever asked which file is the installer. Whether a machine
// is missing the DirectX / Visual C++ / .NET runtimes that game needs is
// deterministic and testable locally, so it is never asked of the AI. This
// keeps the AI call cheap, fast, and impossible to get wrong.
// ---------------------------------------------------------------------------

// Presence checks for the runtimes most game installers demand. Each probe is
// cheap and side-effect free; none of them mutate the machine.
function readRegistryValue(root, subkey) {
  const full = `${root}\\${subkey}`;
  let out = '';
  try {
    out = require('child_process').execFileSync('reg.exe', ['query', full, '/v', 'Version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
    }).toString();
  } catch (e) {
    return null;
  }
  // The value is stored as e.g. "v14.51.36247.00", so allow a leading "v".
  const match = out.match(/Version\s+REG_SZ\s+v?([\d.]+)/i);
  return match ? match[1] : null;
}

function hasDotNetFramework(minor) {
  // Release key is the canonical "is it installed" signal for .NET Framework.
  return readRegistryValue('HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP', `v${minor}\\Full`) !== null;
}

function hasDotNetDesktopRuntime() {
  const major = 8;
  return readRegistryValue('HKLM\\SOFTWARE\\dotnet\\Setup\\Installed', `x64\\sharedfx\\Microsoft\\WindowsDesktop\\App.${major}.0`) !== null
    || fs.existsSync(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'dotnet', 'shared', 'Microsoft.WindowsDesktop.App'));
}

function hasDirectX() {
  const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
  const runtimeFiles = ['d3dx9_43.dll', 'xinput1_3.dll', 'd3dcompiler_43.dll'];
  const systemDirectories = [
    path.join(windowsDirectory, 'System32'),
    path.join(windowsDirectory, 'SysWOW64'),
  ];
  return systemDirectories.some((directory) =>
    runtimeFiles.some((file) => fs.existsSync(path.join(directory, file)))
  );
}

function detectSystemDependencies() {
  const present = {};

  present['Visual C++ 2015-2022 Redistributable (x64)'] = findVisualCRedistributable(true);
  present['Visual C++ 2015-2022 Redistributable (x86)'] = findVisualCRedistributable(false);
  present['DirectX End-User Runtime (June 2010)'] = hasDirectX();
  present['.NET Framework 4.8'] = hasDotNetFramework('4');
  present['.NET Desktop Runtime 8'] = hasDotNetDesktopRuntime();

  return present;
}

function findVisualCRedistributable(isX64) {
  // Authoritative check: the runtime itself registers its installed version
  // here. The Uninstall-key scan below is unreliable for the 2015+ combined
  // redistributable, which is why it cannot be the only signal.
  const arch = isX64 ? 'x64' : 'x86';
  const version = readRegistryValue(
    'HKLM',
    'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\' + arch
  );
  if (version) return true;

  // Fall back to the Add/Remove Programs listing.
  try {
    const raw = require('child_process').execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Visual C++'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, maxBuffer: 8 * 1024 * 1024 }
    ).toString();

    return raw.split(/\r?\n/).some((line) => {
      if (!/Visual C\+\+.*Redistributable/i.test(line)) return false;
      if (!/2015|2017|2019|2022/i.test(line)) return false;
      return isX64 ? /x64/i.test(line) : /x86/i.test(line);
    });
  } catch (e) {
    return false;
  }
}

// Only install prerequisites shipped with the game download. If a runtime is
// not bundled, the game's own setup remains responsible for installing it.
const DEPENDENCY_CATALOG = [
  {
    id: 'vcredist_x64',
    label: 'Visual C++ 2015-2022 Redistributable (x64)',
    systemKey: 'Visual C++ 2015-2022 Redistributable (x64)',
    bundledNames: [/^vcredist_x64/i, /^VC_redist\.x64/i, /redist.*x64/i],
    args: ['/install', '/quiet', '/norestart'],
  },
  {
    id: 'vcredist_x86',
    label: 'Visual C++ 2015-2022 Redistributable (x86)',
    systemKey: 'Visual C++ 2015-2022 Redistributable (x86)',
    bundledNames: [/^vcredist_x86/i, /^VC_redist\.x86/i, /redist.*x86/i],
    args: ['/install', '/quiet', '/norestart'],
  },
  {
    id: 'directx',
    label: 'DirectX End-User Runtime (June 2010)',
    systemKey: 'DirectX End-User Runtime (June 2010)',
    bundledNames: [/^DXSETUP/i],
    args: ['/silent'],
  },
  {
    id: 'dotnet48',
    label: '.NET Framework 4.8',
    systemKey: '.NET Framework 4.8',
    bundledNames: [/^ndp48/i, /dotnet.*4\.8/i],
    args: ['/q', '/norestart'],
  },
];

/**
 * Return missing prerequisites only when their installer is bundled locally.
 * `bundled` is the list of absolute file paths found in the staged download.
 */
function findMissingDependencies(bundled, detected = detectSystemDependencies()) {
  const files = Array.isArray(bundled) ? bundled : [];
  const missing = [];

  for (const entry of DEPENDENCY_CATALOG) {
    if (detected[entry.systemKey]) continue;
    const bundledPath = files.find((file) => entry.bundledNames.some((rx) => rx.test(path.basename(file))));
    if (!bundledPath) continue;
    missing.push({
      id: entry.id,
      label: entry.label,
      bundledPath,
      args: entry.args,
    });
  }
  return missing;
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

function cleanupExtractedStaging(stagingDirectory) {
  if (!stagingDirectory) return false;
  const resolved = path.resolve(stagingDirectory);
  const stagingRoot = path.resolve(path.dirname(path.dirname(resolved)));
  // This helper is only called for staging we created. Keep the archive and
  // remove only the staging folder itself.
  if (path.basename(path.dirname(resolved)) !== STAGING_DIR_NAME) return false;
  try { fs.rmSync(resolved, { recursive: true, force: true }); return true; } catch (e) { return false; }
}

async function planInstall({ filePath, gameTitle, source }) {
  const apiKey = getApiKey();
  if (!AI_PROXY_URL && !apiKey && !isLoopbackEndpoint(NIM_ENDPOINT)) {
    return { error: 'A provider API key is required unless the configured endpoint is local.' };
  }
  if (!fs.existsSync(filePath)) return { error: 'The downloaded file is no longer available.' };

  let scanRoot = path.dirname(filePath);
  let stagingDirectory = null;
  let selectedFile = null;
  if (path.extname(filePath).toLowerCase() === '.zip') {
    try {
      scanRoot = await extractZip(filePath, path.dirname(filePath), gameTitle);
      stagingDirectory = scanRoot;
    } catch (error) {
      return { error: error.message };
    }
  } else if (fs.statSync(filePath).isDirectory()) {
    scanRoot = filePath;
  } else if (['.exe', '.msi'].includes(path.extname(filePath).toLowerCase())) {
    selectedFile = filePath;
  }

  let files;
  try {
    files = selectedFile
      ? [{
          path: path.basename(selectedFile),
          extension: path.extname(selectedFile).toLowerCase(),
          size: fs.statSync(selectedFile).size
        }]
      : listFiles(scanRoot);
  } catch (error) {
    cleanupExtractedStaging(stagingDirectory);
    return { error: `Extracted files could not be inspected: ${error.message}` };
  }
  if (!files.length) {
    cleanupExtractedStaging(stagingDirectory);
    return { error: 'No files were found to inspect.' };
  }

  const requestBody = {
    gameTitle: gameTitle || 'Unknown game',
    source: source || 'Unknown',
    files
  };
  let response;
  try {
    response = await fetch(AI_PROXY_URL || NIM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Keep direct credentials local; loopback routers can be unauthenticated.
      ...(!AI_PROXY_URL && apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(AI_PROXY_URL ? requestBody : {
      model: NIM_MODEL,
      temperature: 0,
      max_tokens: 500,
      stream: false,
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
  } catch (error) {
    cleanupExtractedStaging(stagingDirectory);
    return { error: `AI planning request failed: ${error.message}` };
  }

  if (!response.ok) {
    cleanupExtractedStaging(stagingDirectory);
    const detail = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'The AI service rejected this request and is still asking for an app token. '
        + 'The app no longer sends one, so the hosted service needs its AI_CLIENT_TOKEN variable removed.'
      );
    }
    throw new Error(`AI request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  let payload;
  let result;
  try {
    payload = await response.json();
    result = extractPlan(payload);
  } catch (error) {
    cleanupExtractedStaging(stagingDirectory);
    return { error: `AI response could not be parsed safely: ${error.message}` };
  }
  const installerPath = typeof result.installerPath === 'string' ? result.installerPath : '';
  const installer = installerPath ? resolveInside(scanRoot, installerPath) : null;
  if (!installer || !fs.existsSync(installer) || !['.exe', '.msi'].includes(path.extname(installer).toLowerCase())) {
    cleanupExtractedStaging(stagingDirectory);
    return { error: result.reason || 'AI could not identify a safe Windows installer in this download.' };
  }

  return {
    ok: true,
    installerPath: installer,
    displayPath: path.relative(path.dirname(filePath), installer),
    stagingDirectory,
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    reason: String(result.reason || 'Installer candidate detected.'),
    model: payload.model || NIM_MODEL
  };
}

function runInstaller(installerPath, downloadDirectory) {
  const installer = resolveInside(downloadDirectory, path.relative(downloadDirectory, installerPath));
  if (!installer || !fs.existsSync(installer)) return { ok: false, error: 'Installer was not found.' };

  const extension = path.extname(installer).toLowerCase();
  const command = extension === '.msi' ? 'msiexec.exe' : installer;
  const args = extension === '.msi' ? ['/i', installer] : [];

  let child;
  try {
    child = spawn(command, args, {
      cwd: path.dirname(installer),
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: false,
    });
  } catch (error) {
    return { ok: false, error: error.message || 'Installer could not be started.' };
  }

  const result = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    child.once('error', (error) => finish({
      ok: false,
      exitCode: null,
      signal: null,
      error: error.message || 'Installer could not be started.',
    }));
    child.once('close', (code, signal) => finish({
      ok: code === 0 && !signal,
      exitCode: typeof code === 'number' ? code : null,
      signal: signal || null,
      error: code === 0 && !signal ? null : signal
        ? `Installer was terminated by signal ${signal}.`
        : `Installer exited with code ${code}.`,
    }));
  });

  return { ok: true, process: child, result, installerPath: installer };
}

// ---------------------------------------------------------------------------
// Silent prerequisite installer
// ---------------------------------------------------------------------------

// Runs a downloaded prerequisite to completion, waiting for the real exit
// code. NSIS/Inno/VC-redist style setups all honour the same switch set:
// MSI packages use msiexec; EXE switches are specific to their redistributable.
function runDependencyInstaller(exePath, installerArgs = []) {
  const extension = path.extname(exePath).toLowerCase();
  let command = exePath;
  let args = installerArgs;

  if (extension === '.msi') {
    command = 'msiexec.exe';
    args = ['/i', exePath, '/qn', '/norestart'];
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: path.dirname(exePath),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let settled = false;
    // Hard ceiling: a wedged installer must never block the queue forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) {}
      resolve({ ok: false, error: 'Dependency installer timed out.' });
    }, 15 * 60 * 1000);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : `Installer exited with code ${code}.` });
    });
  });
}

/**
 * Installs only missing prerequisites bundled with the selected download.
 * Unbundled runtimes are left to the game's installer.
 */
async function installMissingDependencies(bundledFiles, options = {}) {
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const results = [];

  let missing;
  try {
    missing = findMissingDependencies(bundledFiles || []);
  } catch (error) {
    return { ok: false, error: `Dependency scan failed: ${error.message}`, installed: [] };
  }

  if (!missing.length) {
    onUpdate({ phase: 'dependencies-done', installed: [], message: 'No bundled prerequisites need installing.' });
    return { ok: true, installed: [] };
  }

  for (let index = 0; index < missing.length; index += 1) {
    const dependency = missing[index];
    onUpdate({
      phase: 'dependency',
      dependency: dependency.id,
      label: dependency.label,
      index,
      total: missing.length,
    });

    onUpdate({ phase: 'dependency-installing', label: dependency.label, index, total: missing.length });
    const outcome = await runDependencyInstaller(dependency.bundledPath, dependency.args);

    results.push({ id: dependency.id, label: dependency.label, ok: outcome.ok, error: outcome.error });
    onUpdate({
      phase: outcome.ok ? 'dependency-done' : 'dependency-failed',
      label: dependency.label,
      ok: outcome.ok,
      error: outcome.error,
    });
  }

  const failed = results.filter((entry) => !entry.ok);
  return {
    ok: failed.length === 0,
    installed: results.filter((entry) => entry.ok),
    failed,
    error: failed.length ? `${failed.length} prerequisite(s) could not be installed.` : null,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function removePath(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Deletes the downloaded archive, the extracted staging tree and any loose
 * sidecar files that shipped with the download.
 *
 * Safety contract — a path is only ever removed when ALL of these hold:
 *   1. it is strictly inside the download folder (blocks `..` traversal and
 *      refuses to delete the download folder itself);
 *   2. it is not inside the Installed tree, so an installed game can never be
 *      destroyed even when it lives in the download folder;
 *   3. for staging, it sits strictly inside the staging root we created, so a
 *      sibling game folder can never be caught in the sweep.
 * Everything else is reported in `skipped` rather than deleted.
 */
function cleanupDownloadArtifacts({ filePath, stagingDirectory, downloadDirectory }) {
  const removed = [];
  const skipped = [];
  const root = path.resolve(downloadDirectory);
  const stagingRoot = path.join(root, STAGING_DIR_NAME);
  const installedRoot = path.join(root, INSTALLED_DIR_NAME);

  const isProtected = (resolved) =>
    resolved === stagingRoot
    || resolved === installedRoot
    || resolved.startsWith(installedRoot + path.sep);

  // Inside the download folder, but not the folder itself and not Installed.
  const isContained = (resolved) =>
    resolved !== root && resolved.startsWith(root + path.sep) && !isProtected(resolved);

  if (stagingDirectory) {
    const resolvedStaging = path.resolve(stagingDirectory);
    // Must be <downloads>/Universal-Freebie-Installs/<per-game folder>.
    const isPerGameStaging = resolvedStaging !== stagingRoot
      && resolvedStaging.startsWith(stagingRoot + path.sep);

    if (isPerGameStaging && isContained(resolvedStaging)) {
      if (removePath(resolvedStaging)) removed.push(resolvedStaging);
      else skipped.push(resolvedStaging);
    } else {
      skipped.push(resolvedStaging);
    }
  }

  if (filePath && fs.existsSync(filePath)) {
    const resolvedFile = path.resolve(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const isRemovable = ['.zip', '.rar', '.7z', '.exe', '.msi', '.iso'].includes(extension)
      || AUX_EXTENSIONS.has(extension);

    if (isRemovable && isContained(resolvedFile)) {
      if (removePath(resolvedFile)) removed.push(resolvedFile);
      else skipped.push(resolvedFile);
    } else {
      // Not an archive/installer, or not safely contained: left alone.
      skipped.push(resolvedFile);
    }
  }

  return { removed, skipped };
}

// Removes a now-empty staging parent so the download folder stays tidy.
function pruneEmptyStaging(downloadDirectory) {
  const stagingRoot = path.join(downloadDirectory, STAGING_DIR_NAME);
  try {
    if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) {
      fs.rmdirSync(stagingRoot);
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Installed-game detection
//
// Once a game is installed we need the executable the player actually starts,
// so the library can launch it. It is found deterministically rather than by
// asking the model: a "launcher" is conventionally the largest .exe sitting
// next to the game's data folders, and the names below are the ones that are
// never the game itself.
// ---------------------------------------------------------------------------

// Never a launch target: setup/bootstrap, redistributables, editors, tools.
const NON_GAME_EXECUTABLES = [
  /^unins\d*\.exe$/i,
  /^uninstall/i,
  /^setup\.exe$/i,
  /^install/i,
  /^bootstrap/i,
  /^autorun/i,
  /^redist/i,
  /^vcredist/i,
  /^dxsetup/i,
  /^directx/i,
  /^dotnetfx/i,
  /^dotnet.*\.exe$/i,
  /^ngdp/i,
  /^gfwlive/i,
  /^crashpad/i,
  /^crashreport/i,
  /^unarc/i,
  /^7z/i,
  /^winRAR/i,
  /^arc/i,
  /^(steam|origin|uplay|epic|eos|ubisoft|rockstar|battle|riot|epicgames|galaxy|ubisoftconnect|launcher\.exe)$/i,
  /^easyanticheat/i,
  /^steamstub/i,
  /^prereq/i,
  /^_commonredist/i,
  /^_smartcam/i,
  /^config(urator)?\.exe$/i,
  /^editor\.exe$/i,
  /^sdk.*\.exe$/i
];

// Strong signal that a file really is the game, not a support tool.
const GAME_EXE_PATTERNS = [
  /\.exe$/i
];

function isLikelyGameExecutable(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.length < 4) return false;
  if (NON_GAME_EXECUTABLES.some((pattern) => pattern.test(base))) return false;
  return GAME_EXE_PATTERNS.some((pattern) => pattern.test(base));
}

// Scores one candidate: bigger and shallower files win, because a real game
// binary is normally the largest .exe in its folder and sits near the top.
function scoreExecutable(absolutePath, root) {
  let size = 0;
  try {
    size = fs.statSync(absolutePath).size;
  } catch (e) {
    return null;
  }
  if (size <= 0) return null;

  const relative = path.relative(root, absolutePath);
  const depth = relative.split(path.sep).length - 1;
  // A folder whose name looks like the game's data directory is a good hint
  // that this is the shipped binary (Binaries\Win64\Game.exe and friends).
  const folderHint = /(^|\\)(bin|binaries|game|release|dist|build|win32|win64|x64)(s)?$/i.test(
    path.dirname(relative)
  );

  return { absolutePath, size, depth, score: size / (1 + depth) * (folderHint ? 2 : 1) };
}

/**
 * Finds the most plausible game executable inside a download or an
 * already-installed folder.
 *
 * `installerPath` (when supplied) is only used to skip setup/bootstrap files
 * that are known not to be the game. Returns null when nothing looks like a
 * runnable game, so callers never register a junk entry in the library.
 */
function findGameExecutable(root, options = {}) {
  const start = root;
  if (!start || !fs.existsSync(start)) return null;

  // A .zip/.rar that was never extracted cannot be searched, and the caller
  // only reaches here once an install has already expanded it.
  let roots = [start];
  try {
    if (!fs.statSync(start).isDirectory()) return null;
  } catch (e) {
    return null;
  }

  // A freshly installed game usually lives in one clearly-named subfolder.
  // Prefer it when it exists, but still fall back to the whole tree.
  const preferred = [];
  try {
    for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === STAGING_DIR_NAME) continue;
      if (/^(bin|bins|binaries|game|games|redist|directx|support|installer)/i.test(entry.name)) continue;
      preferred.push(path.join(start, entry.name));
    }
  } catch (e) {
    // Unreadable root: fall through with the root only.
  }

  const candidates = [];
  const seen = new Set();
  const visit = (directory, depth) => {
    if (depth > 5 || candidates.length > 2000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // Never descend into these: they hold other products' installers and
        // would otherwise dominate the search with a large unrelated .exe.
        if (/^(redist|directx|vcredist|dotnet|node_modules|\.git|uninstall|support|redist_data|__redist)$/i.test(entry.name)) continue;
        visit(absolute, depth + 1);
      } else if (/\.exe$/i.test(entry.name)) {
        if (!isLikelyGameExecutable(entry.name)) continue;
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        const scored = scoreExecutable(absolute, start);
        if (scored) candidates.push(scored);
      }
    }
  };

  // Search the preferred subfolders first, then the whole tree, so a top-level
  // launcher always wins over a deeply buried tool of similar size.
  for (const folder of preferred.slice(0, 8)) {
    if (fs.existsSync(folder)) visit(folder, 1);
  }
  visit(start, 0);

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

module.exports = {
  planInstall,
  findGameExecutable,
  isLikelyGameExecutable,
  runInstaller,
  installMissingDependencies,
  cleanupDownloadArtifacts,
  pruneEmptyStaging,
  // Exported for the verification scripts in tools/.
  detectSystemDependencies,
  findMissingDependencies,
  STAGING_DIR_NAME,
  INSTALLED_DIR_NAME,
};