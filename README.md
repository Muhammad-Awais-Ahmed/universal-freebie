# Universal Freebie

Universal Freebie is a Windows desktop app for discovering, downloading, and managing PC games from multiple sources in one place.

It combines a search UI, intelligent download tracking, a game library, and optional AI-assisted installation workflows into a single Electron + Next.js application.

---

## Current features

- Unified search across supported game sources
- Relevance-based result ranking with multi-page scraping for broader coverage
- Download queue and live progress tracking for active and interrupted downloads
- Resume / retry / continue support for partially downloaded files
- Download history with per-item status and progress persistence
- Manual app update checks from Settings (no forced update prompt on startup)
- Game Library page for installed games, download history, and local storage browsing
- Add Game flow for manual library registration
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

## Supported sources

- ApunKaGames
- FileCR
- FitGirl
- SteamUnlocked
- Archive.org

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
│   │   ├── aiInstaller.js
│   │   ├── autoInstall.js
│   │   ├── database.js
│   │   ├── downloader.js
│   │   └── providers/
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

### Search and ranking

- Each configured source is queried for results.
- Pages are traversed until no fresh items are found, so the app loads more of the catalog instead of stopping at page one.
- Results are merged, deduplicated, and ranked by relevance using title matching and metadata signals.

### Download flow

- Downloads are stored under the configured Downloads directory.
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
