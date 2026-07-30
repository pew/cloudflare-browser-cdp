# Cloudflare Browser CDP Proxy

A Cloudflare Worker that exposes Cloudflare Browser Rendering as a remote Chrome DevTools Protocol endpoint over WebSocket.

This project is intended for generic remote-CDP clients such as OpenClaw, Browserless-compatible tooling, or anything that expects standard CDP discovery via `/json/version` and then a real DevTools WebSocket.

## Requirements

- Node.js 22 or newer
- Cloudflare account with Browser Rendering enabled
- `CDP_SECRET` configured as a Worker secret
- `wrangler` authenticated for local development and deploys

## What This Worker Does

- Authenticates requests with `?secret=<CDP_SECRET>`
- Exposes discovery endpoints:
  - `GET /json/version?secret=...`
  - `GET /json/list?secret=...`
  - `GET /json?secret=...`
- On WebSocket connect, acquires a Cloudflare Browser Rendering session and proxies the raw DevTools protocol to the client
- Sets Cloudflare Browser Rendering `keep_alive` to 10 minutes to reduce idle-session timeouts

## Quick Start

```bash
npm install
npx wrangler secret put CDP_SECRET
npm run deploy
```

## Local Development

`wrangler.jsonc` sets the browser binding to `"remote": true`, which is required for local `wrangler dev` to talk to a real Browser Rendering session.

```bash
echo "CDP_SECRET=test-secret" > .dev.vars
npm run dev
```

## Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /` | Info endpoint |
| `WS /?secret=<CDP_SECRET>` | Raw DevTools WebSocket |
| `GET /json/version?secret=<CDP_SECRET>` | Browserless-style CDP discovery |
| `GET /json/list?secret=<CDP_SECRET>` | Discovery-compatible placeholder target listing |
| `GET /json?secret=<CDP_SECRET>` | Alias for `/json/list` |

## OpenClaw Example

OpenClaw supports both HTTP CDP discovery and direct WebSocket CDP URLs. For this Worker, prefer the direct WebSocket URL so OpenClaw talks straight to the proxied DevTools session:

```json
{
  "browser": {
    "enabled": true,
    "defaultProfile": "cloudflare",
    "remoteCdpTimeoutMs": 10000,
    "remoteCdpHandshakeTimeoutMs": 20000,
    "profiles": {
      "cloudflare": {
        "cdpUrl": "wss://your-worker.workers.dev/?secret=<CDP_SECRET>"
      }
    }
  }
}
```

Notes:

- If you prefer the Browserless-style discovery path, `https://your-worker.workers.dev/?secret=<CDP_SECRET>` also works for `/json/version`.
- The default OpenClaw examples for Browserless use much smaller timeouts. Cloudflare Browser Rendering cold starts can be slower, so higher OpenClaw timeouts are safer.
- This Worker is a session proxy, not a full Browserless replacement with stable `/json/list`, `/json/new`, and `/json/close/*` tab-management semantics.

## Human in the Loop

The proxy forwards Browser Run's `Cloudflare.*` CDP commands and events unchanged, including structured human handoff. Run the interactive smoke test against a deployed Worker:

```bash
CDP_SECRET=xxx \
WORKER_URL=your-worker.workers.dev \
HANDOFF_URL=https://example.com \
HANDOFF_INSTRUCTIONS='Interact with the page, then select Done.' \
node scripts/test-handoff.js
```

Open the printed Live View URL, complete the task, and select **Done**. The script verifies the completion event, inactive handoff state, and resumed CDP automation.

The Live View URL is a short-lived bearer credential: share it only with the intended operator and do not log or store it. Keep the CDP client connected during handoff; disconnecting closes this proxy's browser session. See Cloudflare's [Human in the Loop documentation](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/).

## Verification

```bash
npm test
npm run typecheck
```

If you want to smoke-test the deployed endpoint manually:

```bash
curl "https://your-worker.workers.dev/json/version?secret=<CDP_SECRET>"
```

The response should include a `webSocketDebuggerUrl` pointing back at this Worker.

## Security

- `CDP_SECRET` is required for all discovery and WebSocket endpoints.
- Treat the Worker URL plus secret as a remote browser credential.
- Prefer deploying behind an unguessable secret and rotating it if it leaks.

## License

MIT
