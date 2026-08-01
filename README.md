# Universal Freebie

**Game & Mod download manager** built with **Electron + Next.js**.

Universal Freebie lets you search, download, and manage games and mods from multiple
sources (ApunKaGames, FileCR, FitGirl, SteamUnlocked, ModDB, Archive.org, TheMovieBox)
through one unified UI.

---

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org) | **20.9+** | Includes `npm` |
| Windows | 10 / 11 | NSIS installer target |

Check your versions:

```bat
node -v
npm -v
```

---

## Quick start (one-click build)

Double-click **`build.bat`** in this folder. It will:

1. Verify Node.js / npm are installed
2. Run `npm install` (syncs or fresh-installs dependencies)
3. Build the Next.js frontend (`next build` → static export to `out/`)
4. Package the Windows app with electron-builder

**Outputs:**

| Command | Output |
|---------|--------|
| `build.bat` | `dist\Universal Freebie Setup 1.0.0.exe` (NSIS installer) |
| `build.bat dir` | `dist\win-unpacked\Universal Freebie.exe` (no installer) |

The installer is in `dist\` when done. Install it, and the app appears in your
Start Menu / desktop.

---

## Manual build (step by step)

```bat
REM 1. Install dependencies
npm install

REM 2. Build the Next.js frontend (static export)
npm run build

REM 3a. Create the NSIS installer
npm run package

REM 3b. ...or just an unpacked folder (faster, no installer)
npm run package:dir
```

- `npm run package` → installer at `dist\Universal Freebie Setup 1.0.0.exe`
- `npm run package:dir` → unpacked app at `dist\win-unpacked\`

---

## Development

Run the frontend + Electron together with hot reload:

```bat
npm run electron:dev
```

Or separately:

```bat
npm run dev          REM Next.js dev server on http://localhost:3000
npm run electron     REM launch Electron (expects the dev server or out/)
```

---

## Project structure

```
production/
├── build.bat                  # One-click builder (installer or dir mode)
├── electron/
│   └── main.js                # Electron main process (downloads, windows, IPC)
├── src/
│   ├── app/                   # Next.js routes: /, /games, /library, /mods, /settings
│   ├── backend/
│   │   ├── downloader.js      # HTTP download engine (resume, retries, queue)
│   │   ├── database.js        # Local app database (history, library)
│   │   └── providers/         # Source scrapers (ApunKaGames, FileCR, ...)
│   └── components/            # React UI components
├── public/
│   └── favicon.ico
├── package.json               # Scripts + electron-builder config
├── next.config.mjs
└── .gitignore
```

---

## How downloading works

1. You search a game/mods in the UI → backend provider scrapes the source.
2. Download links are resolved through the provider (e.g. ApunKaGames →
   TheFilesLocker chain, which may open a hidden window for the free-download
   flow — **some hosts show a captcha that must be solved manually per part**).
3. Files download to your **Downloads** folder (configurable in Settings) with
   resume/retry support.

> ⚠️ **Note:** The free-host download flow (e.g. TheFilesLocker) may require you
> to solve a reCAPTCHA in the pop-up window. Parts download sequentially.

---

## Monitoring & privacy (optional, consent-based)

The app includes an optional **screen-monitoring** feature for administrators
(parental control, device management, fleet supervision). It is **off by
default** and never runs without explicit user consent:

1. On first launch the app shows a **consent screen** explaining exactly what
   is captured.
2. If the user consents (and an admin server is configured), the app captures
   low-frequency snapshots of **its own window only** — never the desktop,
   keyboard, microphone, or camera.
3. A **visible "● REC" badge** is shown at all times while monitoring is
   active.
4. Users can **disable monitoring or revoke consent** at any time in
   Settings → Monitoring & Privacy.
5. Snapshots are sent to the admin server over HTTPS with a Bearer token.

### Running the admin viewer

A separate server app lives in [`monitor-admin/`](monitor-admin/README.md):

```bat
cd monitor-admin
npm install
set ADMIN_TOKEN=your-strong-secret
npm start
```

Open **http://localhost:4480**, enter the token, and view devices + snapshots.

---

## License & usage

Personal-use software. Respect the terms of service of the sites you download
from, and only download content you have the right to. Screen monitoring must
only be used with explicit user consent and a visible indicator, in compliance
with applicable privacy laws.
