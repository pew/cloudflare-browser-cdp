# AGENTS.md - Cloudflare Browser CDP

## Project Overview

Cloudflare Worker that proxies Cloudflare Browser Rendering as a standard remote CDP (Chrome DevTools Protocol) WebSocket endpoint. Clients connect via WebSocket, the worker acquires a browser session and forwards raw CDP traffic between the client and Browser Rendering's internal devtools WebSocket.

**Stack:** TypeScript, Cloudflare Workers, `@cloudflare/puppeteer` (session acquisition only), WebSocket

---

## Build/Test/Lint Commands

```bash
npm install                    # Install dependencies
npm run dev                    # Local dev (wrangler dev)
npm run typecheck              # Type check (tsc --noEmit)
npm run types                  # Generate Cloudflare types
npm run deploy                 # Deploy to Cloudflare
```

### Local Development

```bash
echo "CDP_SECRET=test-secret" > .dev.vars    # Local secrets
npx wrangler secret put CDP_SECRET            # Production secret
```

### Testing the Remote Browser

```bash
npm install ws                 # Required for client scripts
CDP_SECRET=xxx WORKER_URL=your-worker.workers.dev node scripts/test-browser.js
```

### No Test Framework

Currently no test suite. If adding tests, use Vitest with `@cloudflare/vitest-pool-workers`.

---

## Project Structure

```
src/
  index.ts       # Main worker: auth, WebSocket proxy, chunked message codec
  types.ts       # Env and CDP message types
scripts/
  cdp-client.js  # Node.js CDP client library (ESM, uses ws)
  test-browser.js # Smoke-test script for deployed worker
```

---

## Architecture

The worker is a **transparent CDP proxy**, not a CDP implementation. It does not interpret or handle individual CDP methods.

### Request Flow

1. Client connects via `WS /?secret=<CDP_SECRET>`
2. Worker authenticates the secret against `env.CDP_SECRET` (timing-safe comparison)
3. Worker calls `puppeteer.acquire(env.BROWSER, { keep_alive: 600_000 })` to get a `sessionId`
4. Worker opens an internal devtools WebSocket to Browser Rendering via `env.BROWSER.fetch(/v1/connectDevtools?browser_session=...)`
5. CDP messages are proxied bidirectionally:
   - **Client → upstream:** text messages are re-encoded as chunked binary and forwarded
   - **Upstream → client:** chunked binary frames are reassembled into text CDP messages and forwarded
6. On disconnect, the worker sends `Browser.close` to clean up the session

### Chunked Message Protocol

Browser Rendering's internal devtools WebSocket uses a chunked binary encoding:
- First chunk: 4-byte little-endian length header + up to `MAX_CHUNK_SIZE - 4` bytes of payload
- Subsequent chunks: raw payload continuation, up to `MAX_CHUNK_SIZE` bytes each
- Reassembly uses the length header to determine when all chunks have arrived

### Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `BROWSER_KEEP_ALIVE_MS` | 600,000 (10 min) | Browser session keep-alive duration |
| `INTERNAL_PING_INTERVAL_MS` | 1,000 (1 sec) | Ping interval to keep upstream WebSocket alive |
| `MAX_CHUNK_SIZE` | 1,048,575 | Max bytes per chunk frame |

### HTTP Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Info endpoint (JSON) |
| `WS /?secret=...` | Raw CDP WebSocket proxy |
| `GET /json/version?secret=...` | CDP discovery (Browserless-compatible) |
| `GET /json/list?secret=...` | Empty target list placeholder |
| `GET /json?secret=...` | Alias for `/json/list` |

---

## Code Style Guidelines

### TypeScript Configuration

- **Target/Module:** ES2022 with bundler resolution
- **Strict mode:** Enabled
- **Types:** `@cloudflare/workers-types` only
- **No emit:** TypeScript for checking only (Wrangler bundles)

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Interfaces | PascalCase | `ProxyState`, `CDPRequest` |
| Functions | camelCase | `handleWebSocketUpgrade`, `sendChunkedMessage` |
| Constants | SCREAMING_SNAKE | `BROWSER_KEEP_ALIVE_MS`, `MAX_CHUNK_SIZE` |

### Function Organization

1. Constants and types at file top
2. Utility functions (`timingSafeEqual`, `toTextMessage`, chunking helpers)
3. Proxy lifecycle (`initProxy`, `closeUpstream`, `closeServer`)
4. HTTP/WebSocket handlers (`handleWebSocketUpgrade`, `handleJsonVersion`, etc.)
5. `export default` entry point at file bottom with `satisfies ExportedHandler<Env>`

### Security

- Timing-safe comparison for secret authentication (`timingSafeEqual`)
- All endpoints require `?secret=<CDP_SECRET>` except unauthenticated `GET /` (which reveals no sensitive info)
- `CDP_SECRET` stored as a Wrangler secret, never in code

---

## Environment & Bindings

```typescript
export interface Env {
  BROWSER: Fetcher;      // Browser Rendering binding (remote: true)
  CDP_SECRET: string;    // Auth secret (wrangler secret put)
}
```

wrangler.jsonc: `browser.binding: "BROWSER"`, `browser.remote: true`, `compatibility_flags: ["nodejs_compat"]`

---

## Verification Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run dev` starts without errors
- [ ] WebSocket connection works with CDP client scripts
- [ ] Authentication rejects invalid/missing secrets
