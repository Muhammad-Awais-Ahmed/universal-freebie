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
  "source": "Direct link",
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
  "model": "nvidia/nemotron-3.5-bolt-e4b",
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
| `NVIDIA_NIM_MODEL`     | no       | `nvidia/nemotron-3.5-bolt-e4b` | First model tried; can be a provider-supported alias |
| `NVIDIA_NIM_FALLBACK_MODELS` | no | built-in list | Comma-separated fallback IDs, capped at 8 plus the primary model |
| `NVIDIA_NIM_BASE_URL`  | no       | NIM chat completions endpoint   | Override endpoint if needed                   |
| `AI_CLIENT_TOKEN`      | no       | —                              | If set, clients must send `X-App-Token`       |
| `AI_REQUEST_LIMIT`     | no       | `30`                           | Requests per IP per window                    |
| `AI_REQUEST_WINDOW_MS` | no       | `3600000`                      | Rate limit window in ms                       |
| `PORT`                 | no       | `4480`                         | Listen port                                   |

## Model selection and retirement

NVIDIA retires hosted models without warning, and a retired id answers
`410 Gone`. Rather than let that silently break installer detection, the
service tries `NVIDIA_NIM_MODEL` first and then walks the configured fallback list
until one answers. Set `NVIDIA_NIM_FALLBACK_MODELS` to a comma-separated list to
replace the defaults (at most eight fallbacks are used). The winner is remembered
for the life of the process, so a retirement costs one extra request rather than
one per request. A custom model such as `combo 21559-m` can be placed in either
variable only when the configured API endpoint recognizes that identifier.

The built-in models are maintained against NVIDIA's current NIM catalog. The
chat request is non-streaming and asks the model for JSON in the prompt; it does
not send `response_format`, which is not supported by every current NIM model.

Only `404`, `410`, and `503` advance the chain. Everything else, such as a bad
key or a rate limit, is surfaced immediately, so a real problem is never
masked by retries.

`GET /api/health` reports both the configured model and the one currently
answering:

```json
{
  "ok": true,
  "aiConfigured": true,
  "model": "nvidia/nemotron-3.5-bolt-e4b",
  "configuredModel": "nvidia/nemotron-3.5-bolt-e4b",
  "clientTokenRequired": false
}
```

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
desktop app. For local development only, set `UNIVERSAL_FREEBIE_AI_URL=direct`
to call the configured OpenAI-compatible endpoint directly; the selected provider
must support the configured model ID. For `combo 21559-m`, for example, set the
provider's chat-completions URL and `NVIDIA_NIM_MODEL=21559-M` in the local environment (the local 9router model
list reports this exact ID with owner `combo`). A key is not required for the
loopback router. In a Windows development shell, launch the app with:

```powershell
$env:UNIVERSAL_FREEBIE_AI_URL = 'direct'
$env:NVIDIA_NIM_BASE_URL = 'http://127.0.0.1:20128/v1/chat/completions'
$env:NVIDIA_NIM_MODEL = '21559-M'
npm run electron:dev
```

For hosted use, set provider/model variables on the service instead. Never put a
key in source control or a packaged app.

## Security notes

- The NVIDIA key is only read from the AI service environment and is never shipped
  to or visible in the desktop app. Local direct mode may omit a key only for a
  loopback endpoint; model requests do not route through the download proxy pool.
- Requests are rate limited per IP, which is what protects a public service.
- A shared client token is not a real boundary for a desktop app: any token
  shipped inside the app is public the moment the app ships. `AI_CLIENT_TOKEN`
  therefore exists for private deployments, not for the public one.
- The model is instructed to return JSON only, and the client re-validates any
  returned path before running it (must exist locally, be a relative path
  inside the download, and end in `.exe` or `.msi`).
