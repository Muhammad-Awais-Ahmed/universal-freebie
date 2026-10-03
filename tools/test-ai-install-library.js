const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-ai-lib-'));
const archivePath = path.join(tempRoot, 'Game.zip');
fs.writeFileSync(archivePath, 'not-a-real-archive');

const fakeAiInstaller = {
  planInstall: async () => ({
    installerPath: path.join(tempRoot, 'GameLauncher.exe'),
    displayPath: 'GameLauncher.exe',
    confidence: 0.98,
    reason: 'Fake installer match for regression test',
  }),
  runInstaller: () => ({ ok: true }),
  installMissingDependencies: async () => ({ installed: [], failed: [] }),
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

  console.log('PASS: auto-install registers the installed game in the library');
  process.exit(0);
})();
