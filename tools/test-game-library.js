const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  discoverInstalledGames,
  findGameExecutable,
  lookupWebIcon,
  parseSteamLibraryPaths,
  readVdfValue,
} = require('../src/backend/gameLibrary');

function mkdir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-freebie-library-'));
  try {
    const steamRoot = path.join(temp, 'Steam');
    const steamLibrary = path.join(temp, 'SteamLibrary');
    const steamGame = path.join(steamLibrary, 'steamapps', 'common', 'Portal 2');
    const epicGame = path.join(temp, 'Epic Games', 'Sample Game');
    const gogGame = path.join(temp, 'GOG Games', 'GOG Sample');
    const epicManifests = path.join(temp, 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    const libraryPathForVdf = steamLibrary.replace(/\\/g, '\\\\');

    mkdir(path.join(steamRoot, 'steamapps', 'appmanifest_620.acf'));
    fs.writeFileSync(
      path.join(steamRoot, 'steamapps', 'appmanifest_620.acf'),
      '"AppState" { "name" "Portal 2" "installdir" "Portal 2" }',
    );
    mkdir(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'));
    fs.writeFileSync(
      path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders" { "0" { "path" "${libraryPathForVdf}" } }`,
    );
    mkdir(path.join(steamGame, 'portal2.exe'));
    fs.writeFileSync(path.join(steamGame, 'portal2.exe'), '');
    mkdir(path.join(steamGame, 'uninstall.exe'));
    fs.writeFileSync(path.join(steamGame, 'uninstall.exe'), '');

    const epicLaunchPath = path.join(epicGame, 'Binaries', 'Win64', 'SampleGame.exe');
    mkdir(epicLaunchPath);
    fs.writeFileSync(epicLaunchPath, '');
    mkdir(path.join(epicManifests, 'sample.item'));
    fs.writeFileSync(
      path.join(epicManifests, 'sample.item'),
      JSON.stringify({
        DisplayName: 'Sample Game',
        InstallLocation: epicGame,
        LaunchExecutable: 'Binaries/Win64/SampleGame.exe',
      }),
    );
    mkdir(path.join(temp, 'outside.exe'));
    fs.writeFileSync(path.join(temp, 'outside.exe'), '');
    fs.writeFileSync(
      path.join(epicManifests, 'unsafe.item'),
      JSON.stringify({
        DisplayName: 'Outside Game',
        InstallLocation: epicGame,
        LaunchExecutable: '../../outside.exe',
      }),
    );

    const gogExe = path.join(gogGame, 'bin', 'GOGSample.exe');
    mkdir(gogExe);
    fs.writeFileSync(gogExe, '');
    mkdir(path.join(gogGame, 'redist', 'setup.exe'));
    fs.writeFileSync(path.join(gogGame, 'redist', 'setup.exe'), '');

    const environment = {
      ProgramFiles: path.join(temp, 'Program Files'),
      'ProgramFiles(x86)': path.dirname(steamRoot),
      LOCALAPPDATA: path.join(temp, 'LocalAppData'),
      ProgramData: path.join(temp, 'ProgramData'),
      USERPROFILE: path.join(temp, 'Profile'),
      PUBLIC: path.join(temp, 'Public'),
    };
    fs.mkdirSync(path.join(environment.ProgramFiles, 'GOG Games'), { recursive: true });
    fs.renameSync(gogGame, path.join(environment.ProgramFiles, 'GOG Games', 'GOG Sample'));

    const detected = discoverInstalledGames({
      platform: 'win32',
      env: environment,
      steamRoots: [steamRoot],
      epicManifestDirectories: [epicManifests],
      commonRoots: [path.join(environment.ProgramFiles, 'GOG Games')],
    });
    assert.strictEqual(detected.length, 3, JSON.stringify(detected, null, 2));
    assert(detected.some((game) => game.name === 'Portal 2' && game.executablePath.endsWith('portal2.exe')));
    assert(detected.some((game) => game.name === 'Sample Game' && game.executablePath === epicLaunchPath));
    assert(detected.some((game) => game.name === 'GOG Sample' && game.executablePath.endsWith('GOGSample.exe')));

    assert.strictEqual(readVdfValue('"name" "Portal \\\\ 2"', 'name'), 'Portal \\ 2');
    assert.deepStrictEqual(
      parseSteamLibraryPaths(`"path" "${libraryPathForVdf}"`, steamRoot),
      [steamRoot, steamLibrary],
    );
    assert.strictEqual(findGameExecutable(steamGame, 'Portal 2'), path.join(steamGame, 'portal2.exe'));
    assert.throws(
      () => discoverInstalledGames({
        platform: 'linux',
        env: environment,
        steamRoots: [],
        epicManifestDirectories: [],
        commonRoots: [],
      }),
      /Windows only/,
    );

    const fakeFetch = async (url) => {
      if (url.includes('/api/storesearch/')) {
        return { ok: true, json: async () => ({ items: [{ id: 620, tiny_image: 'https://cdn.example/tiny.jpg' }] }) };
      }
      return {
        ok: true,
        json: async () => ({ 620: { success: true, data: { header_image: 'https://cdn.example/header.jpg' } } }),
      };
    };
    assert.strictEqual(await lookupWebIcon('Portal 2', fakeFetch), 'https://cdn.example/header.jpg');
    assert.strictEqual(await lookupWebIcon('Unknown Game', async () => ({ ok: true, json: async () => ({ items: [] }) })), null);
    await assert.rejects(
      lookupWebIcon('Portal 2', async (url) => url.includes('/api/storesearch/')
        ? { ok: true, json: async () => ({ items: [{ id: 620, tiny_image: 'http://cdn.example/tiny.jpg' }] }) }
        : { ok: true, json: async () => ({ 620: { success: true, data: {} } }) }),
      /non-secure image URL/,
    );

    console.log('Game library detection and web icon tests passed.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
