const fs = require('fs');
const path = require('path');

const MAX_WALK_DEPTH = 5;
const MAX_WALK_ENTRIES = 5000;
const IGNORED_EXECUTABLE = /(?:^|[ _.-])(setup|uninstall(?:er)?|unins\d*|crash(?:reporter)?|redist|vc_redist|easyanticheat|battleye|updater)(?:[ _.-]|$)/i;

function readVdfValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`"${escaped}"\\s+"((?:\\\\.|[^"])*)"`, 'i'));
  return match ? match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : null;
}

function parseSteamLibraryPaths(text, steamRoot) {
  const paths = new Set([steamRoot]);
  const pathPattern = /"path"\s+"((?:\\.|[^"])*)"/gi;
  let match;
  while ((match = pathPattern.exec(text)) !== null) {
    paths.add(match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
  }
  return [...paths];
}

function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findGameExecutable(installDirectory, gameName, fsImpl = fs) {
  const target = normalizedName(gameName);
  const candidates = [];
  const pending = [{ directory: installDirectory, depth: 0 }];
  let visited = 0;

  while (pending.length && visited < MAX_WALK_ENTRIES) {
    const current = pending.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(current.directory, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) break;
      const entryPath = path.join(current.directory, entry.name);

      if (entry.isDirectory()) {
        if (
          current.depth < MAX_WALK_DEPTH &&
          !/^(?:redist|redistributables|_commonredist|support|easyanticheat|battleye|directx|vcredist)$/i.test(entry.name)
        ) {
          pending.push({ directory: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.exe' || IGNORED_EXECUTABLE.test(entry.name)) {
        continue;
      }

      const basename = normalizedName(path.basename(entry.name, path.extname(entry.name)));
      const relativeDepth = current.depth;
      let score = 0;
      if (target && basename === target) score += 100;
      else if (target && (basename.includes(target) || target.includes(basename))) score += 60;
      if (relativeDepth === 0) score += 20;
      score -= relativeDepth;
      candidates.push({ path: entryPath, score, basename });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.basename.localeCompare(b.basename));
  return candidates.length ? candidates[0].path : null;
}

function addCandidate(candidates, game, fsImpl = fs) {
  if (!game.name || !game.installDirectory || !fsImpl.existsSync(game.installDirectory)) return;
  const installDirectory = path.resolve(game.installDirectory);
  let executablePath = game.executablePath && fsImpl.existsSync(game.executablePath)
    ? path.resolve(game.executablePath)
    : findGameExecutable(installDirectory, game.name, fsImpl);
  if (!executablePath) return;
  executablePath = path.resolve(executablePath);
  const relativeExecutablePath = path.relative(installDirectory, executablePath);
  if (
    !relativeExecutablePath ||
    relativeExecutablePath === '..' ||
    relativeExecutablePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeExecutablePath) ||
    path.extname(executablePath).toLowerCase() !== '.exe'
  ) {
    return;
  }
  try {
    if (!fsImpl.statSync(executablePath).isFile()) return;
  } catch (error) {
    return;
  }

  const normalizedPath = executablePath.toLowerCase();
  if (candidates.has(normalizedPath)) return;
  candidates.set(normalizedPath, {
    name: String(game.name).trim(),
    executablePath,
    source: game.source,
  });
}

function discoverInstalledGames(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    throw new Error('Automatic game detection is currently supported on Windows only.');
  }

  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local');
  const programData = env.ProgramData || 'C:\\ProgramData';
  const steamRoots = options.steamRoots || [
    path.join(programFilesX86, 'Steam'),
    path.join(programFiles, 'Steam'),
    path.join(localAppData, 'Programs', 'Steam'),
    path.join(env.USERPROFILE || '', 'Steam'),
    'C:\\Steam',
    'D:\\Steam',
    'E:\\Steam',
  ];
  const candidates = new Map();

  for (const steamRoot of steamRoots) {
    const librariesFile = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    let libraries = [steamRoot];
    try {
      if (fsImpl.existsSync(librariesFile)) {
        libraries = parseSteamLibraryPaths(fsImpl.readFileSync(librariesFile, 'utf8'), steamRoot);
      }
    } catch (error) {
      console.warn(`[library-detect] Could not read Steam library list at ${librariesFile}:`, error.message);
    }

    const primarySteamApps = path.join(steamRoot, 'steamapps');
    let manifests = [];
    try {
      manifests = fsImpl.readdirSync(primarySteamApps).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
    } catch (error) {
      continue;
    }
    for (const manifest of manifests) {
      const manifestPath = path.join(primarySteamApps, manifest);
      try {
        const text = fsImpl.readFileSync(manifestPath, 'utf8');
        const name = readVdfValue(text, 'name');
        const installDirectoryName = readVdfValue(text, 'installdir');
        if (!name || !installDirectoryName) continue;
        for (const library of libraries) {
          const installDirectory = path.join(library, 'steamapps', 'common', installDirectoryName);
          addCandidate(candidates, { name, installDirectory, source: 'Steam' }, fsImpl);
        }
      } catch (error) {
        console.warn(`[library-detect] Could not read Steam manifest ${manifestPath}:`, error.message);
      }
    }
  }

  const epicManifestDirectories = options.epicManifestDirectories || [
    path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    path.join(localAppData, 'EpicGamesLauncher', 'Saved', 'Config', 'Windows'),
  ];
  for (const manifestDirectory of epicManifestDirectories) {
    let manifests = [];
    try {
      manifests = fsImpl.readdirSync(manifestDirectory).filter((name) => name.toLowerCase().endsWith('.item'));
    } catch (error) {
      continue;
    }
    for (const manifest of manifests) {
      const manifestPath = path.join(manifestDirectory, manifest);
      try {
        const data = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
        const installDirectory = data.InstallLocation;
        if (!installDirectory) continue;
        const launchExecutable = data.LaunchExecutable
          ? path.resolve(installDirectory, data.LaunchExecutable)
          : null;
        addCandidate(candidates, {
          name: data.DisplayName || data.AppName || path.basename(installDirectory),
          installDirectory,
          executablePath: launchExecutable,
          source: 'Epic Games',
        }, fsImpl);
      } catch (error) {
        console.warn(`[library-detect] Could not read Epic manifest ${manifestPath}:`, error.message);
      }
    }
  }

  const commonRoots = options.commonRoots || [
    path.join(programFiles, 'Epic Games'),
    path.join(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'games'),
    path.join(programFiles, 'EA Games'),
    path.join(programFilesX86, 'EA Games'),
    path.join(programFiles, 'GOG Games'),
    path.join(programFilesX86, 'GOG Games'),
    'C:\\GOG Games',
    'D:\\GOG Games',
    'C:\\Ubisoft Game Launcher\\games',
    'D:\\Ubisoft Game Launcher\\games',
    'C:\\EA Games',
    'D:\\EA Games',
    path.join(env.PUBLIC || 'C:\\Users\\Public', 'Games'),
    'C:\\Games',
    'D:\\Games',
  ];
  for (const root of commonRoots) {
    let directories = [];
    try {
      directories = fsImpl.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (error) {
      continue;
    }
    for (const directory of directories) {
      const installDirectory = path.join(root, directory.name);
      const source = root.toLowerCase().includes('gog') ? 'GOG' :
        root.toLowerCase().includes('ubisoft') ? 'Ubisoft Connect' :
          root.toLowerCase().includes('ea games') ? 'EA app' :
            root.toLowerCase().includes('epic games') ? 'Epic Games' : 'Detected';
      addCandidate(candidates, { name: directory.name, installDirectory, source }, fsImpl);
    }
  }

  return [...candidates.values()];
}

async function lookupWebIcon(gameName, fetchImpl = global.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Web icon lookup is unavailable in this runtime.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=english&cc=US`;
    const searchResponse = await fetchImpl(searchUrl, { signal: controller.signal });
    if (!searchResponse.ok) throw new Error(`Steam Store search failed (${searchResponse.status}).`);
    const searchData = await searchResponse.json();
    const item = Array.isArray(searchData.items) ? searchData.items[0] : null;
    if (!item || !item.id) return null;

    const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(item.id)}&cc=US&l=en`;
    const detailsResponse = await fetchImpl(detailsUrl, { signal: controller.signal });
    if (!detailsResponse.ok) throw new Error(`Steam Store game details failed (${detailsResponse.status}).`);
    const details = await detailsResponse.json();
    const game = details[item.id]?.data;
    const image = game?.header_image || game?.capsule_image || item.tiny_image || null;
    if (!image) return null;
    const parsedImage = new URL(image);
    if (parsedImage.protocol !== 'https:') {
      throw new Error('The game artwork provider returned a non-secure image URL.');
    }
    return parsedImage.toString();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  discoverInstalledGames,
  findGameExecutable,
  lookupWebIcon,
  parseSteamLibraryPaths,
  readVdfValue,
};
