const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const catalog = require('../data/standaloneGames.json').games;
const MAX_ARCHIVE_BYTES = 2_500_000_000;
const MAX_EXTRACTED_BYTES = 15_000_000_000;
const MAX_ENTRIES = 100_000;
const MAX_WALK_DEPTH = 8;

function getStandaloneGames() {
  return catalog.map(({ checksum, checksumAlgorithm, downloadHost, executableNames, ...game }) => ({
    ...game,
    source: 'Official standalone download',
  }));
}

function getStandaloneGame(gameId) {
  return catalog.find((game) => game.id === gameId) || null;
}

function isSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) return false;
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => (
    segment === '.' ||
    segment === '..' ||
    /[<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  ))) return false;
  return true;
}

function resolveInside(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`The game archive contains an unsafe path: ${relativePath}`);
  }
  const rootPath = path.resolve(root);
  const candidate = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`The game archive contains a path outside its install folder: ${relativePath}`);
  }
  return candidate;
}

async function hashFile(filePath, algorithm) {
  if (!['sha256', 'sha512'].includes(algorithm)) {
    throw new Error(`Unsupported archive checksum algorithm: ${algorithm}`);
  }
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyChecksum(filePath, expectedChecksum, algorithm, gameTitle = 'game archive') {
  const expectedLength = algorithm === 'sha256' ? 64 : algorithm === 'sha512' ? 128 : 0;
  if (!expectedLength || !new RegExp(`^[a-f0-9]{${expectedLength}}$`, 'i').test(expectedChecksum)) {
    throw new Error('The standalone game catalog contains an invalid checksum.');
  }
  const actualChecksum = await hashFile(filePath, algorithm);
  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error(`The ${gameTitle} download failed its checksum verification.`);
  }
  return actualChecksum;
}

function extractZipSafely(archivePath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }

      let settled = false;
      let entryCount = 0;
      let extractedBytes = 0;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          zipFile.close();
        } catch (closeError) {
          console.warn('Could not close rejected game archive:', closeError.message);
        }
        reject(error);
      };

      zipFile.on('error', fail);
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      zipFile.on('entry', (entry) => {
        if (settled) return;
        (async () => {
          entryCount += 1;
          if (entryCount > MAX_ENTRIES) throw new Error('The game archive contains too many files.');

          const targetPath = resolveInside(destination, entry.fileName);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const entryType = unixMode & 0xf000;
          const isDirectory = entry.fileName.endsWith('/') || entryType === 0x4000;

          if (entryType !== 0 && entryType !== 0x8000 && entryType !== 0x4000) {
            throw new Error(`The game archive contains an unsupported file type: ${entry.fileName}`);
          }
          if (!isDirectory && entry.uncompressedSize > MAX_EXTRACTED_BYTES - extractedBytes) {
            throw new Error('The game archive expands beyond the allowed size.');
          }
          if (!isDirectory) extractedBytes += entry.uncompressedSize;

          if (isDirectory) {
            await fs.promises.mkdir(targetPath, { recursive: true });
            if (!settled) zipFile.readEntry();
            return;
          }

          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
          await new Promise((streamResolve, streamReject) => {
            zipFile.openReadStream(entry, (streamError, readStream) => {
              if (streamError) {
                streamReject(streamError);
                return;
              }
              const writeStream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
              pipeline(readStream, writeStream).then(streamResolve, streamReject);
            });
          });
          if (!settled) zipFile.readEntry();
        })().catch(fail);
      });

      zipFile.readEntry();
    });
  });
}

function findApprovedExecutable(rootPath, executableNames) {
  const allowedNames = new Set(executableNames.map((name) => name.toLowerCase()));
  const pending = [{ directory: rootPath, depth: 0 }];
  let visited = 0;

  while (pending.length && visited < MAX_ENTRIES) {
    const current = pending.pop();
    const entries = fs.readdirSync(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ENTRIES) break;
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_WALK_DEPTH) pending.push({ directory: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile() && allowedNames.has(entry.name.toLowerCase()) && path.extname(entry.name).toLowerCase() === '.exe') {
        return entryPath;
      }
    }
  }

  if (visited >= MAX_ENTRIES) throw new Error('The extracted game contains too many files to inspect safely.');
  return null;
}

function getInstalledStandaloneGame(gameId, gamesRoot) {
  const game = getStandaloneGame(gameId);
  if (!game) throw new Error('Unknown standalone game.');

  const installDirectory = path.join(gamesRoot, game.id);
  const markerPath = path.join(installDirectory, '.universal-freebie-install.json');
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Could not read the ${game.title} install record: ${error.message}`);
  }
  if (!marker || marker.gameId !== game.id || !isSafeRelativePath(marker.executableRelativePath)) {
    throw new Error(`The ${game.title} install record is invalid.`);
  }

  const executablePath = resolveInside(installDirectory, marker.executableRelativePath);
  const stats = fs.lstatSync(executablePath);
  if (!stats.isFile() || !game.executableNames.some((name) => name.toLowerCase() === path.basename(executablePath).toLowerCase())) {
    throw new Error(`The approved ${game.title} game executable is missing.`);
  }
  return { ...game, installDirectory, executablePath };
}

async function installStandaloneGameArchive(game, archivePath, gamesRoot) {
  const catalogGame = game && getStandaloneGame(game.id);
  if (!catalogGame) throw new Error('Unknown standalone game.');
  game = catalogGame;
  const sourceUrl = new URL(game.downloadUrl);
  if (
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.hostname !== game.downloadHost ||
    !/^[a-z0-9][a-z0-9._-]*\.zip$/i.test(game.filename) ||
    game.filename.includes('..')
  ) {
    throw new Error('The standalone game catalog contains an invalid official download.');
  }

  const archiveStats = await fs.promises.lstat(archivePath);
  if (!archiveStats.isFile() || archiveStats.size > MAX_ARCHIVE_BYTES) {
    throw new Error('The downloaded game archive is missing, invalid, or larger than the allowed limit.');
  }
  await verifyChecksum(archivePath, game.checksum, game.checksumAlgorithm, game.title);

  const existing = getInstalledStandaloneGame(game.id, gamesRoot);
  if (existing) return existing;

  await fs.promises.mkdir(gamesRoot, { recursive: true });
  const installDirectory = path.join(gamesRoot, game.id);
  if (fs.existsSync(installDirectory)) {
    throw new Error(`An incomplete ${game.title} folder already exists at ${installDirectory}. Remove it before reinstalling.`);
  }
  const stagingDirectory = path.join(gamesRoot, `.${game.id}.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

  try {
    await fs.promises.mkdir(stagingDirectory, { recursive: false });
    await extractZipSafely(archivePath, stagingDirectory);
    const executablePath = findApprovedExecutable(stagingDirectory, game.executableNames);
    if (!executablePath) {
      throw new Error(`The official ${game.title} archive did not contain an approved game executable.`);
    }
    const executableRelativePath = path.relative(stagingDirectory, executablePath);
    await fs.promises.writeFile(
      path.join(stagingDirectory, '.universal-freebie-install.json'),
      JSON.stringify({ gameId: game.id, executableRelativePath }, null, 2),
      { flag: 'wx', mode: 0o600 }
    );
    await fs.promises.rename(stagingDirectory, installDirectory);
    return getInstalledStandaloneGame(game.id, gamesRoot);
  } catch (error) {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  getStandaloneGames,
  getStandaloneGame,
  getInstalledStandaloneGame,
  installStandaloneGameArchive,
  extractZipSafely,
  hashFile,
  verifyChecksum,
  isSafeRelativePath,
};
