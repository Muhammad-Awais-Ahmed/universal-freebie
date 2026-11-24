const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const catalog = require('../src/data/standaloneGames.json');
const {
  getStandaloneGames,
  getStandaloneGame,
  extractZipSafely,
  hashFile,
  verifyChecksum,
  isSafeRelativePath,
} = require('../src/backend/standaloneGames');

async function run() {
  assert.ok(Array.isArray(catalog.games) && catalog.games.length >= 7);
  assert.strictEqual(getStandaloneGames().length, catalog.games.length);
  assert.strictEqual(getStandaloneGame('missing-game'), null);

  const ids = new Set();
  const allowedIcons = new Set([
    'car-front',
    'crosshair',
    'orbit',
    'shield',
    'snowflake',
    'swords',
    'train-front',
  ]);
  for (const game of catalog.games) {
    assert.ok(game.id && !ids.has(game.id), `missing or duplicate id: ${game.id}`);
    ids.add(game.id);
    assert.ok(game.title && game.description, `title and description required for ${game.id}`);
    assert.ok(allowedIcons.has(game.icon), `a supported game icon is required for ${game.id}`);
    assert.ok(game.thumbnail, `official artwork is required for ${game.id}`);
    assert.strictEqual(new URL(game.thumbnail).protocol, 'https:', `HTTPS artwork required for ${game.id}`);
    assert.ok(game.downloadUrl.startsWith('https://'), `HTTPS required for ${game.id}`);
    assert.strictEqual(new URL(game.downloadUrl).hostname, game.downloadHost);
    assert.ok(/^[a-z0-9][a-z0-9._-]*\.zip$/i.test(game.filename), `safe ZIP filename required for ${game.id}`);
    assert.ok(/^(sha256|sha512)$/.test(game.checksumAlgorithm));
    assert.ok(new RegExp(`^[a-f0-9]{${game.checksumAlgorithm === 'sha512' ? 128 : 64}}$`, 'i').test(game.checksum));
    assert.ok(game.executableNames.length > 0 && game.executableNames.every((name) => /\.exe$/i.test(name)));
    assert.ok(!Object.prototype.hasOwnProperty.call(getStandaloneGames().find((item) => item.id === game.id), 'checksum'));
  }

  assert.strictEqual(isSafeRelativePath('bin/game.exe'), true);
  assert.strictEqual(isSafeRelativePath('../outside.exe'), false);
  assert.strictEqual(isSafeRelativePath('folder\\..\\outside.exe'), false);
  assert.strictEqual(isSafeRelativePath('C:\\outside.exe'), false);
  assert.strictEqual(isSafeRelativePath('folder/file.txt:stream'), false);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-standalone-test-'));
  try {
    const sourceDirectory = path.join(tempRoot, 'source');
    const extractedDirectory = path.join(tempRoot, 'extracted');
    const archivePath = path.join(tempRoot, 'fixture.zip');
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, 'portable-game.exe'), 'fixture executable');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${sourceDirectory.replace(/'/g, "''")}\\*' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'ignore' });

    await extractZipSafely(archivePath, extractedDirectory);
    assert.strictEqual(
      fs.readFileSync(path.join(extractedDirectory, 'portable-game.exe'), 'utf8'),
      'fixture executable'
    );
    const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
    assert.strictEqual(await hashFile(archivePath, 'sha256'), expectedHash);
    assert.strictEqual(await verifyChecksum(archivePath, expectedHash, 'sha256'), expectedHash);
    await assert.rejects(() => verifyChecksum(archivePath, '0'.repeat(64), 'sha256'), /checksum verification/);
    await assert.rejects(() => hashFile(archivePath, 'md5'), /Unsupported archive checksum algorithm/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('PASS: standalone catalog, safe archive extraction, and checksums');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
