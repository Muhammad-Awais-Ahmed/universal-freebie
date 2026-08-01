# Monitor Admin

Admin viewer for **Universal Freebie's** consent-based screen monitoring.
Receives snapshot frames sent by consented clients and displays them in a
web dashboard, grouped by device.

> ⚠️ **Legal note:** Only use this with users who have **explicitly consented**
> (the app shows a first-run consent screen and a visible REC indicator while
> active). Never use covertly.

## Run

```bat
REM 1. Install dependencies
npm install

REM 2. Start with a secret admin token
set ADMIN_TOKEN=your-strong-secret
npm start
```

Or set `ADMIN_TOKEN` and `PORT` (default 4480) via environment variables.

Open **http://localhost:4480** in a browser, enter the admin token, and you'll
see a list of devices with their snapshots.

## How clients connect

In **Universal Freebie → Settings → Monitoring & Privacy**, the user (or an
administrator) enters this server's URL (e.g. `http://your-server:4480`) and
the same `ADMIN_TOKEN`, then grants consent. The app then sends JPEG snapshots
of its own window at the configured interval to:

```
POST /api/frames
Authorization: Bearer <ADMIN_TOKEN>
{ deviceId, app, version, ts, frame: <base64 jpeg> }
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/frames` | Receive a snapshot (Bearer auth) |
| GET | `/api/users` | List devices with frame counts (Bearer auth) |
| GET | `/api/frames/:deviceId` | List a device's snapshots (Bearer auth) |
| GET | `/api/frame/:deviceId/:file` | Serve a snapshot image (Bearer auth) |
| GET | `/` | Dashboard |

## Data

Snapshots are stored under `data/frames/<deviceId>/` and device metadata in
`data/users.json`. Both are gitignored — add them to your backups.
