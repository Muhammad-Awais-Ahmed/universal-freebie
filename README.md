# Universal Freebie

Universal Freebie is a Windows desktop app for finding, downloading, installing, and launching games with official standalone releases.

It combines an allowlisted standalone game catalog, a game library, and download management for user-provided links in one Electron + Next.js application.

---

## Current features

- Search the curated standalone catalog instantly, with suggestions shown before searching
- Download official portable archives directly in the app
- Verify pinned SHA-256/SHA-512 checksums before safely extracting and registering a game
- Launch installed games without requiring Steam or another storefront client
- Download queue and live progress tracking for active and interrupted downloads
- Resume / retry / continue support for partially downloaded files
- Download history with per-item status and progress persistence
- Manual app update checks from Settings (no forced update prompt on startup)
- Game Library page for installed games, download history, and local storage browsing
- Detect Games scans Steam and Epic manifests plus common GOG, Ubisoft, EA, and game folders on Windows
- Game artwork can be added as an HTTPS image URL
- Add Game flow for manual library registration, including executable browsing
- Optional AI automatic installation pipeline
  - identifies the real installer in a finished download
  - installs missing system dependencies when needed
  - launches the installer
  - optionally keeps or removes downloaded artifacts after install
- Add-to-Library action for completed downloads and installed games
- Download directory selection and app settings management

---

## Removed / no longer active

The app no longer does the following:

- no forced update check at app startup
- no automatic update install without explicit user action
- no legacy "always available" updater flow that pops on launch
- no undocumented or hidden download-only behavior without the library/settings workflow

The update experience is now user-driven and explicit through the Settings page.

---

## Game catalog

- The current curated catalog includes Teeworlds, Xonotic, SuperTuxKart, and Endless Sky.
- Each archive URL, checksum, and approved executable name is pinned in the app's catalog.
- Downloads come directly from the projects' official domains or release pages; third-party mirrors are not used.
- Archives are checked before extraction, unsafe paths and special files are rejected, and only a catalog-approved executable can be registered for launch.
- The standalone catalog does not require Steam. The separate direct-link downloader remains user-provided and independent of game search.

---

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org) | 20.9+ | Includes npm |
| Windows | 10 / 11 | Primary target |

Check versions:

```bat
node -v
npm -v
```

---

## Quick start

Double-click `build.bat` in the project root.

It will:

1. Verify Node.js and npm are available
2. Install dependencies
3. Build the Next.js frontend
4. Package the Electron app with electron-builder

### Build outputs

```bat
build.bat
```

Creates a Windows installer in `dist/`.

```bat
build.bat dir
```

Creates an unpacked app folder in `dist/win-unpacked/`.

---

## Manual build

```bat
npm install
npm run build
npm run package
```

Or an unpacked folder:

```bat
npm run package:dir
```

---

## Development

Run the frontend and Electron together:

```bat
npm run electron:dev
```

Or run them separately:

```bat
npm run dev
npm run electron
```

---

## Project structure

```text
source/
├── build.bat
├── electron/
│   └── main.js
├── src/
│   ├── app/
│   ├── backend/
│   │   ├── standaloneGames.js
│   │   ├── aiInstaller.js
│   │   ├── autoInstall.js
│   │   ├── database.js
│   │   ├── downloader.js
│   ├── components/
│   └── utils/
├── public/
├── package.json
├── next.config.mjs
├── tsconfig.json
├── LICENSE
└── README.md
```

---

## How the app works

### Search and installation

- Search runs locally against the curated catalog and updates on every keystroke.
- The main process accepts game IDs only; download URLs and approved executable names are fixed in the catalog.
- The downloader retrieves each official ZIP, checks its pinned digest, rejects unsafe ZIP entries, and extracts it into app data.
- Successful installs are added to the Library and launched directly from the verified install folder.

### Direct-link download flow

- User-provided direct links are stored under the configured Downloads directory.
- Active transfers report real-time progress.
- Interrupted downloads can be resumed instead of restarting from zero.
- Completed downloads can be installed manually or via the AI installer workflow.

### Library flow

- Installed games are tracked in the Library page.
- Download history stays visible for resumed or reinstalled items.
- A completed download can be registered as a playable game if the executable is found in the downloaded content.

### Update flow

- The app checks for updates only when the user requests it in Settings.
- This prevents startup noise and keeps update behavior explicit and predictable.

---

## License

See [LICENSE](LICENSE). This project is for personal use and respects the terms of service of the sources it accesses. Only download content you are allowed to use.
