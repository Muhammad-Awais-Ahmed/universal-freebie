const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const NIM_ENDPOINT = process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
// The hosted AI service is public: no key, no token, no account. Access is
// protected by the backend's per-IP rate limit rather than by a shared secret,
// because a desktop app could never keep one secret anyway.
const AI_PROXY_URL = process.env.UNIVERSAL_FREEBIE_AI_URL || 'https://universal-freebie-ai.onrender.com/api/ai/install-plan';
// Only used for the direct-to-NIM fallback, which the app never takes while the
// hosted service is reachable. Match the hosted service's first choice.
const NIM_MODEL = process.env.NVIDIA_NIM_MODEL || 'google/gemma-3-12b-it';
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
  const dir = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio');
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((name) => name.toLowerCase().startsWith('shared'));
  } catch (e) {
    return false;
  }
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

// Known prerequisite installers. `detect` gives the filename of the bundled
// setup when a download ships one; otherwise the official direct link is used.
const DEPENDENCY_CATALOG = [
  {
    id: 'vcredist_x64',
    label: 'Visual C++ 2015-2022 Redistributable (x64)',
    systemKey: 'Visual C++ 2015-2022 Redistributable (x64)',
    bundledNames: [/^vcredist_x64/i, /^VC_redist\.x64/i, /redist.*x64/i],
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
  },
  {
    id: 'vcredist_x86',
    label: 'Visual C++ 2015-2022 Redistributable (x86)',
    systemKey: 'Visual C++ 2015-2022 Redistributable (x86)',
    bundledNames: [/^vcredist_x86/i, /^VC_redist\.x86/i, /redist.*x86/i],
    url: 'https://aka.ms/vs/17/release/vc_redist.x86.exe',
  },
  {
    id: 'directx',
    label: 'DirectX End-User Runtime (June 2010)',
    systemKey: 'DirectX End-User Runtime (June 2010)',
    bundledNames: [/^DXSETUP/i, /^directx/i],
    url: 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe',
  },
  {
    id: 'dotnet48',
    label: '.NET Framework 4.8',
    systemKey: '.NET Framework 4.8',
    bundledNames: [/^ndp48/i, /dotnet.*4\.8/i],
    url: 'https://go.microsoft.com/fwlink/?linkid=2085155',
  },
];

/**
 * Compare the system against the catalog and return only what is missing.
 * `bundled` is the list of absolute file paths found in the staged download,
 * so a prerequisite shipped inside the archive is always preferred.
 */
function findMissingDependencies(bundled) {
  const present = detectSystemDependencies();
  const names = new Set(bundled.map((file) => path.basename(file)));
  const missing = [];

  for (const entry of DEPENDENCY_CATALOG) {
    if (present[entry.systemKey]) continue;
    const bundledPath = bundled.find((file) => entry.bundledNames.some((rx) => rx.test(path.basename(file))));
    missing.push({
      id: entry.id,
      label: entry.label,
      bundledPath: bundledPath || null,
      url: bundledPath ? null : entry.url,
    });
  }
  return missing;
}

// Downloads a prerequisite to disk over plain https so it can be run silently.
// Kept dependency-free: Node's https module plus a manual redirect follow.
function downloadDependency(url, destination, onBytes, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      reject(new Error('Too many redirects while fetching the dependency.'));
      return;
    }
    const request = https.get(url, { timeout: 60000 }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadDependency(nextUrl, destination, onBytes, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${status}.`));
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      const file = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (onBytes) onBytes(total ? received / total : 0);
      });
      response.pipe(file);
      file.once('error', reject);
      file.once('finish', () => file.close(() => resolve(destination)));
    });
    request.once('timeout', () => request.destroy(new Error('Dependency download timed out.')));
    request.once('error', reject);
  });
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
    return { error: 'The AI service is unreachable. Check your connection and try again.' };
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
      'Content-Type': 'application/json',
      // Only the direct-NIM fallback path needs a key; the hosted service
      // already holds one server-side and is called without credentials.
      ...(!AI_PROXY_URL ? { Authorization: `Bearer ${apiKey}` } : {})
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
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'The AI service rejected this request and is still asking for an app token. '
        + 'The app no longer sends one, so the hosted service needs its AI_CLIENT_TOKEN variable removed.'
      );
    }
    throw new Error(`AI request failed (${response.status}): ${detail.slice(0, 240)}`);
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
    stagingDirectory,
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

// ---------------------------------------------------------------------------
// Silent prerequisite installer
// ---------------------------------------------------------------------------

// Runs a downloaded prerequisite to completion, waiting for the real exit
// code. NSIS/Inno/VC-redist style setups all honour the same switch set:
//   NSIS  -> /S
//   Inno  -> /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
//   MSI   -> msiexec /i /qn /norestart
function runDependencyInstaller(exePath) {
  const extension = path.extname(exePath).toLowerCase();
  let command = exePath;
  let args = ['/S', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'];

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
 * Installs every prerequisite the machine is missing, then hands control back.
 * Bundled prerequisites are used when the download shipped one; otherwise the
 * official Microsoft runtime is fetched to a temp cache.
 */
async function installMissingDependencies(bundledFiles, options = {}) {
  const cacheDirectory = options.cacheDirectory
    || path.join(require('os').tmpdir(), 'universal-freebie-deps');
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const results = [];

  let missing;
  try {
    missing = findMissingDependencies(bundledFiles || []);
  } catch (error) {
    return { ok: false, error: `Dependency scan failed: ${error.message}`, installed: [] };
  }

  if (!missing.length) {
    onUpdate({ phase: 'dependencies-done', installed: [], message: 'All required runtimes are already present.' });
    return { ok: true, installed: [] };
  }

  fs.mkdirSync(cacheDirectory, { recursive: true });

  for (let index = 0; index < missing.length; index += 1) {
    const dependency = missing[index];
    onUpdate({
      phase: 'dependency',
      dependency: dependency.id,
      label: dependency.label,
      index,
      total: missing.length,
    });

    let target = dependency.bundledPath;
    let temporary = false;

    if (!target) {
      const fileName = path.basename(new URL(dependency.url).pathname) || `${dependency.id}.exe`;
      target = path.join(cacheDirectory, fileName);
      try {
        onUpdate({ phase: 'dependency-download', label: dependency.label, index, total: missing.length });
        await downloadDependency(dependency.url, target, (fraction) => {
          onUpdate({ phase: 'dependency-download', label: dependency.label, index, total: missing.length, fraction });
        });
        temporary = true;
      } catch (error) {
        results.push({ id: dependency.id, label: dependency.label, ok: false, error: error.message });
        onUpdate({ phase: 'dependency-failed', label: dependency.label, error: error.message });
        continue;
      }
    }

    onUpdate({ phase: 'dependency-installing', label: dependency.label, index, total: missing.length });
    const outcome = await runDependencyInstaller(target);

    if (temporary) {
      try { fs.unlinkSync(target); } catch (e) {}
    }

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

module.exports = {
  planInstall,
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