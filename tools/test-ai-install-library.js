const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-ai-lib-'));
const archivePath = path.join(tempRoot, 'Game.zip');
fs.writeFileSync(archivePath, 'not-a-real-archive');

let dependencyOutcome = { installed: [], failed: [] };
let dependencyOk = true;

const fakeAiInstaller = {
  planInstall: async () => ({
    installerPath: path.join(tempRoot, 'GameLauncher.exe'),
    displayPath: 'GameLauncher.exe',
    confidence: 0.98,
    reason: 'Fake installer match for regression test',
  }),
  runInstaller: () => ({ ok: true, result: Promise.resolve({ ok: true, exitCode: 0, signal: null }) }),
  installMissingDependencies: async () => Object.assign({ ok: dependencyOk }, dependencyOutcome),
  cleanupDownloadArtifacts: () => ({ removed: [], skipped: [] }),
  pruneEmptyStaging: () => {},
  findGameExecutable: (root) => ({
    absolutePath: path.join(root, 'GameLauncher.exe'),
    size: 1234,
  }),
  isLikelyGameExecutable: () => true,
  INSTALLED_DIR_NAME: 'Universal-Freebie-Installed',
  STAGING_DIR_NAME: 'Universal-Freebie-Installs',
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './aiInstaller' || request.endsWith('/src/backend/aiInstaller.js')) {
    return fakeAiInstaller;
  }
  return originalLoad.apply(this, arguments);
};

const autoInstallPath = path.join(__dirname, '..', 'src', 'backend', 'autoInstall.js');
delete require.cache[autoInstallPath];
const { AutoInstaller } = require(autoInstallPath);
Module._load = originalLoad;

(async () => {
  const installer = new AutoInstaller(() => ({
    autoInstallEnabled: true,
    autoInstallDependencies: false,
    autoLaunchInstaller: true,
    autoDeleteAfterInstall: false,
    downloadDirectory: tempRoot,
  }));

  const exePath = path.join(tempRoot, 'GameLauncher.exe');
  fs.writeFileSync(exePath, 'fake exe');

  let registered = false;
  installer.onRegisterGame = (game) => {
    registered = true;
    return { id: 'library-1', name: game.name, executablePath: game.executablePath };
  };
  installer._waitForInstaller = async () => true;

  await installer.handleCompleted({
    id: 'dl-123',
    filename: 'Game.zip',
    filePath: archivePath,
    source: 'Test Source',
  }, { force: true });

  if (!registered) {
    console.log('FAIL: library registration was skipped in the keep-files install path');
    process.exit(1);
  }

  let launchCount = 0;
  dependencyOk = false;
  dependencyOutcome = {
    ok: false,
    error: 'One prerequisite could not be installed.',
    installed: [],
    failed: [{ id: 'vcredist_x64', label: 'Visual C++ 2015-2022 Redistributable (x64)', ok: false }],
  };
  fakeAiInstaller.runInstaller = () => {
    launchCount++;
    return { ok: true, result: Promise.resolve({ ok: true, exitCode: 0, signal: null }) };
  };

  const prerequisiteBlocker = new AutoInstaller(() => ({
    autoInstallEnabled: true,
    autoInstallDependencies: true,
    autoLaunchInstaller: true,
    autoDeleteAfterInstall: false,
    downloadDirectory: tempRoot,
  }));
  await prerequisiteBlocker.handleCompleted({
    id: 'dl-prereq-failed',
    filename: 'Blocked.zip',
    filePath: archivePath,
    source: 'Test Source',
  }, { force: true });

  const prereqState = prerequisiteBlocker.getState('dl-prereq-failed');
  if (launchCount !== 0) {
    console.log('FAIL: game installer launched after a prerequisite failure');
    process.exit(1);
  }
  if (!prereqState || prereqState.phase !== 'prerequisite-failed' || !prereqState.dependenciesFailed?.length) {
    console.log('FAIL: prerequisite failure was not visible in persisted install state');
    process.exit(1);
  }

  let persisted;
  const restartTest = new AutoInstaller(() => ({ downloadDirectory: tempRoot }), (states) => { persisted = states; });
  restartTest.restoreStates({ 'dl-interrupted': {
    downloadId: 'dl-interrupted',
    phase: 'installing',
    filename: 'Interrupted.zip',
  } });
  const interrupted = restartTest.getState('dl-interrupted');
  if (!interrupted || interrupted.phase !== 'interrupted' || !persisted?.length) {
    console.log('FAIL: active install state was not reconciled and persisted on restart');
    process.exit(1);
  }

  console.log('PASS: auto-install library registration, prerequisite blocking, and restart reconciliation');
  process.exit(0);
})();
