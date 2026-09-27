/**
 * Safety test for the auto-install cleanup guard.
 * Run with:  node tools/test-cleanup-guard.js
 *
 * Creates a fake download folder, then asserts that
 * cleanupDownloadArtifacts refuses to delete anything outside it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanupDownloadArtifacts, pruneEmptyStaging } = require('../src/backend/aiInstaller');

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-cleanup-'));
const downloads = path.join(root, 'Downloads');
const outside = path.join(root, 'ImportantDocuments');

fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'thesis.docx'), 'precious');
fs.writeFileSync(path.join(downloads, 'game.zip'), 'archive');
fs.writeFileSync(path.join(downloads, 'crack.txt'), 'sidecar');

const staging = path.join(downloads, 'Universal-Freebie-Installs', 'Some Game');
fs.mkdirSync(staging, { recursive: true });
fs.writeFileSync(path.join(staging, 'setup.exe'), 'installer');

console.log('\nAuto-install cleanup guard tests\n');

// 1. The happy path: archive + staging tree are removed.
const good = cleanupDownloadArtifacts({
  filePath: path.join(downloads, 'game.zip'),
  stagingDirectory: staging,
  downloadDirectory: downloads,
});
check('staging tree removed', good.removed.includes(staging));
check('archive removed', good.removed.includes(path.join(downloads, 'game.zip')));
check('staging tree gone from disk', !fs.existsSync(staging));
check('unrelated sidecar (.txt) kept', fs.existsSync(path.join(downloads, 'crack.txt')));
check('outside file untouched', fs.existsSync(path.join(outside, 'thesis.docx')));

// 2. Path traversal must not escape the download folder.
const traversal = cleanupDownloadArtifacts({
  filePath: path.join(downloads, '..', 'ImportantDocuments', 'thesis.docx'),
  stagingDirectory: path.join(downloads, '..', 'ImportantDocuments'),
  downloadDirectory: downloads,
});
check('traversal produced no deletions', traversal.removed.length === 0);
check('traversal parent dir still exists', fs.existsSync(outside));
check('traversal file still exists', fs.existsSync(path.join(outside, 'thesis.docx')));

// 3. The download folder itself must never be deleted.
const self = cleanupDownloadArtifacts({
  filePath: downloads,
  stagingDirectory: downloads,
  downloadDirectory: downloads,
});
check('download folder not deleted', fs.existsSync(downloads));
check('download folder reported as skipped', self.skipped.length >= 1);

// 4. The Installed tree must never be touched. It can legitimately live
//    inside the download folder, so containment alone is not enough.
const installed = path.join(downloads, 'Universal-Freebie-Installed', 'Some Game');
fs.mkdirSync(installed, { recursive: true });
fs.writeFileSync(path.join(installed, 'game.exe'), 'installed');
const installedCase = cleanupDownloadArtifacts({
  filePath: path.join(downloads, 'game.zip'),
  stagingDirectory: installed,
  downloadDirectory: downloads,
});
check('installed game tree not deleted', fs.existsSync(path.join(installed, 'game.exe')));
check('installed tree reported as skipped', installedCase.skipped.includes(installed));

// 4b. An installed game's .exe must survive even when named like an installer.
const installedExe = cleanupDownloadArtifacts({
  filePath: path.join(installed, 'game.exe'),
  stagingDirectory: null,
  downloadDirectory: downloads,
});
check('installed game .exe not deleted', fs.existsSync(path.join(installed, 'game.exe')));
check('installed .exe reported as skipped', installedExe.removed.length === 0);

// 4c. A plain .exe sitting in the downloads root (the installer itself) IS
//     removed, otherwise downloads would never reclaim any space.
const bareExe = path.join(downloads, 'Setup.exe');
fs.writeFileSync(bareExe, 'installer');
const bareCase = cleanupDownloadArtifacts({
  filePath: bareExe,
  stagingDirectory: null,
  downloadDirectory: downloads,
});
check('bare .exe in downloads root is removed', bareCase.removed.includes(bareExe));

// 5. pruneEmptyStaging only removes the folder when it is empty.
pruneEmptyStaging(downloads);
check('empty staging root pruned', !fs.existsSync(path.join(downloads, 'Universal-Freebie-Installs')));
check('installed tree survived pruning', fs.existsSync(installed));
const stagingLeftover = path.join(downloads, 'Universal-Freebie-Installs', 'Other Game');
fs.mkdirSync(stagingLeftover, { recursive: true });
pruneEmptyStaging(downloads);
check('non-empty staging root kept', fs.existsSync(stagingLeftover));

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
