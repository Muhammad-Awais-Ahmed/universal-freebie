# Universal Freebie — AI Backend

Server-side NVIDIA NIM proxy for the Universal Freebie desktop app's
**AI Install** flow. The NVIDIA API key stays on this service; the desktop
client only sends a sanitized file listing and gets back the installer
candidate to run.

## Endpoints

| Method | Path                  | Auth                  | Purpose                                  |
| ------ | --------------------- | --------------------- | ---------------------------------------- |
| GET    | `/api/health`         | none                  | Service + AI configuration status         |
| POST   | `/api/ai/install-plan` | `X-App-Token` (opt.)  | Identify the installer in a file listing  |

### Request

```json
{
  "gameTitle": "Some Game",
  "source": "Archive.org",
  "files": [
    { "path": "Setup/Game.exe", "extension": ".exe", "size": 1234567 },
    { "path": "data.bin", "extension": ".bin", "size": 9876543 }
  ]
}
```

The response uses the OpenAI-compatible shape so the client can parse it with
its existing logic:

```json
{
  "object": "chat.completion",
  "model": "meta/llama-3.1-8b-instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "{\"installerPath\":\"Setup/Game.exe\",\"confidence\":0.94,\"reason\":\"Setup executable in a Setup folder.\"}"
      },
      "finish_reason": "stop"
    }
  ]
}
```

## Environment variables

| Variable               | Required | Default                        | Description                                  |
| ---------------------- | -------- | ------------------------------ | -------------------------------------------- |
| `NVIDIA_NIM_API_KEY`   | yes      | —                              | NVIDIA NIM API key (never exposed to client) |
| `NVIDIA_NIM_MODEL`     | no       | `meta/llama-3.1-8b-instruct`   | Model identifier                              |
| `NVIDIA_NIM_BASE_URL`  | no       | NIM chat completions endpoint   | Override endpoint if needed                   |
| `AI_CLIENT_TOKEN`      | no       | —                              | If set, clients must send `X-App-Token`       |
| `AI_REQUEST_LIMIT`     | no       | `30`                           | Requests per IP per window                    |
| `AI_REQUEST_WINDOW_MS` | no       | `3600000`                      | Rate limit window in ms                       |
| `PORT`                 | no       | `4480`                         | Listen port                                   |

## Run locally

```bat
cd ai-backend
npm install
set NVIDIA_NIM_API_KEY=nvapi-...
npm start
```

Health check:

```bat
curl http://localhost:4480/api/health
```

## Deploy to Render

This folder is wired up in the repo's `render.yaml`:

```yaml
services:
  - type: web
    name: universal-freebie-ai
    rootDir: ai-backend
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /api/health
```

Steps:

1. Push the repo to GitHub.
2. In Render choose **New → Blueprint** and select the repo.
3. When prompted, set:
   - `NVIDIA_NIM_API_KEY` (required, secret)
   - `AI_CLIENT_TOKEN` (optional — only for a private deployment)
4. Deploy, then confirm:

   ```
   https://universal-freebie-ai.onrender.com/api/health
   → { "ok": true, "aiConfigured": true, "clientTokenRequired": false, ... }
   ```

The app already targets this URL by default and needs **no key and no token**.
To point it elsewhere, set `UNIVERSAL_FREEBIE_AI_URL` before launching the
desktop app.

## Security notes

- The NVIDIA key is only read from the server environment and is never shipped
  to or visible in the desktop app.
- Requests are rate limited per IP, which is what protects a public service.
- A shared client token is not a real boundary for a desktop app: any token
  shipped inside the app is public the moment the app ships. `AI_CLIENT_TOKEN`
  therefore exists for private deployments, not for the public one.
- The model is instructed to return JSON only, and the client re-validates any
  returned path before running it (must exist locally, be a relative path
  inside the download, and end in `.exe` or `.msi`).
