# AGENTS.md - Cloudflare Browser CDP

## Project Overview

Cloudflare Worker exposing headless Chrome via CDP over WebSocket. Uses `@cloudflare/puppeteer` for browser control. Requires Workers Paid plan.

**Stack:** TypeScript, Cloudflare Workers, Puppeteer (Cloudflare fork), WebSocket

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
  index.ts       # Main worker, CDP handlers (~1400 lines)
  types.ts       # Env and CDP message types
scripts/
  cdp-client.js  # Node.js client library (ESM)
  test-browser.js # Test script for remote browser
```

---

## Code Style Guidelines

### TypeScript Configuration

- **Target/Module:** ES2022 with bundler resolution
- **Strict mode:** Enabled
- **Types:** `@cloudflare/workers-types` only
- **No emit:** TypeScript for checking only (Wrangler bundles)

### Imports

```typescript
// External packages first
import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';
// Local imports with explicit type imports
import type { Env, CDPRequest, CDPResponse, CDPEvent } from './types';
```

### Type Annotations

- Explicit return types on public functions
- `Record<string, unknown>` for generic object params
- Use `as unknown as` for Puppeteer internal APIs
- `satisfies ExportedHandler<Env>` for exports

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Interfaces | PascalCase | `CDPSession`, `CDPRequest` |
| Functions | camelCase | `handleBrowser`, `sendResponse` |
| Constants | SCREAMING_SNAKE | `SUPPORTED_METHODS` |

### Function Organization

1. Utility functions at file top (`timingSafeEqual`, `sendResponse`)
2. Handler functions named `handle{Domain}` for CDP domains
3. Main entry point at file bottom with `export default`

### Error Handling

```typescript
// Throw descriptive errors for missing params
if (!url) throw new Error('url is required');

// Throw for unknown methods/domains
throw new Error(`Unknown Browser method: ${command}`);

// Wrap evaluation errors with CDP-compliant response
try {
  const result = await page.evaluate(expression);
  return { result: { ... } };
} catch (err) {
  return {
    exceptionDetails: {
      exceptionId: 1,
      text: err instanceof Error ? err.message : 'Evaluation failed',
      lineNumber: 0, columnNumber: 0,
    },
  };
}
```

### WebSocket Patterns

```typescript
function sendResponse(ws: WebSocket, id: number, result: unknown): void {
  ws.send(JSON.stringify({ id, result } as CDPResponse));
}
function sendError(ws: WebSocket, id: number, code: number, message: string): void {
  ws.send(JSON.stringify({ id, error: { code, message } } as CDPResponse));
}
function sendEvent(ws: WebSocket, method: string, params?: Record<string, unknown>): void {
  ws.send(JSON.stringify({ method, params } as CDPEvent));
}
```

### Security

- Use timing-safe comparison for secrets (see `timingSafeEqual` in index.ts)
- Info endpoint (`GET /`) only shows `supported_methods` when authenticated via `?secret=`

---

## Environment & Bindings

```typescript
export interface Env {
  BROWSER: Fetcher;      // Browser Rendering binding
  CDP_SECRET: string;    // Auth secret (wrangler secret put)
}
```

wrangler.jsonc: `browser.binding: "BROWSER"`, `compatibility_flags: ["nodejs_compat"]`

---

## CDP Implementation Notes

### Session State (CDPSession)

- `browser`: Puppeteer Browser instance
- `pages`: Map<targetId, Page>
- `nodeMap`: Map<nodeId, CSS selector> (DOM operations)
- `objectMap`: Map<objectId, JS object refs>
- `scriptsToEvaluateOnNewDocument`, `pendingRequests`

### Supported Domains

Browser, Target, Page, Runtime, DOM, Input, Network, Emulation, Fetch

### Adding New CDP Methods

1. Add to `SUPPORTED_METHODS` array
2. Add case to `handle{Domain}` function
3. Extract params: `const x = params.x as Type`
4. Return CDP-compliant response object

---

## Common Pitfalls

1. **Puppeteer types**: Use `as unknown as` for internal APIs
2. **Missing await**: All Puppeteer ops are async
3. **Node ID tracking**: Update `nodeMap` when creating/removing DOM nodes
4. **WebSocket cleanup**: Close browser on WebSocket close
5. **Binary data**: `Buffer.from(buffer).toString('base64')`

---

## Verification Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run dev` starts without errors
- [ ] Test WebSocket connection with CDP client
- [ ] Proper error responses on invalid input
