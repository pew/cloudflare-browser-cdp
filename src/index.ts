import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './types';

const BROWSER_KEEP_ALIVE_MS = 600_000;
const INTERNAL_PING_INTERVAL_MS = 1_000;
const FAKE_HOST = 'https://fake.host';
const CHUNK_HEADER_SIZE = 4;
const MAX_CHUNK_SIZE = 1_048_575;
const FIRST_CHUNK_DATA_SIZE = MAX_CHUNK_SIZE - CHUNK_HEADER_SIZE;

interface ProxyState {
  closed: boolean;
  upstream: WebSocket | null;
  upstreamReady: boolean;
  upstreamClosed: boolean;
  browserCloseSent: boolean;
  queuedMessages: string[];
  chunks: Uint8Array[];
  pingInterval: ReturnType<typeof setInterval> | null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function getSecret(url: URL): string | null {
  return url.searchParams.get('secret');
}

function authenticate(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const providedSecret = getSecret(url);

  if (!env.CDP_SECRET) {
    return new Response(JSON.stringify({
      error: 'CDP endpoint not configured',
      hint: 'Set CDP_SECRET via: wrangler secret put CDP_SECRET',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!providedSecret || !timingSafeEqual(providedSecret, env.CDP_SECRET)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.BROWSER) {
    return new Response(JSON.stringify({
      error: 'Browser Rendering not configured',
      hint: 'Add browser binding to wrangler.jsonc',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

function buildWebSocketUrl(url: URL, secret: string): string {
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/?secret=${encodeURIComponent(secret)}`;
}

function messageToChunks(message: string): Uint8Array[] {
  const encoded = new TextEncoder().encode(message);
  const firstChunk = new Uint8Array(
    Math.min(MAX_CHUNK_SIZE, CHUNK_HEADER_SIZE + encoded.length)
  );
  const view = new DataView(firstChunk.buffer);
  view.setUint32(0, encoded.length, true);
  firstChunk.set(encoded.slice(0, FIRST_CHUNK_DATA_SIZE), CHUNK_HEADER_SIZE);

  const chunks = [firstChunk];
  for (let i = FIRST_CHUNK_DATA_SIZE; i < encoded.length; i += MAX_CHUNK_SIZE) {
    chunks.push(encoded.slice(i, i + MAX_CHUNK_SIZE));
  }

  return chunks;
}

function chunksToMessage(chunks: Uint8Array[]): string | null {
  if (chunks.length === 0) return null;

  const firstChunk = chunks[0];
  if (!firstChunk) return null;

  const expectedBytes = new DataView(firstChunk.buffer, firstChunk.byteOffset, firstChunk.byteLength)
    .getUint32(0, true);

  let totalBytes = -CHUNK_HEADER_SIZE;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    totalBytes += chunk.byteLength;
    if (totalBytes > expectedBytes) {
      throw new Error('Received malformed chunked CDP payload from Browser Rendering');
    }
    if (totalBytes !== expectedBytes) {
      continue;
    }

    const completedChunks = chunks.splice(0, i + 1);
    completedChunks[0] = firstChunk.subarray(CHUNK_HEADER_SIZE);

    const combined = new Uint8Array(expectedBytes);
    let offset = 0;
    for (const completedChunk of completedChunks) {
      combined.set(completedChunk, offset);
      offset += completedChunk.byteLength;
    }

    return new TextDecoder().decode(combined);
  }

  return null;
}

function toTextMessage(data: unknown): string | null {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

function toChunk(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function sendChunkedMessage(ws: WebSocket, message: string): void {
  for (const chunk of messageToChunks(message)) {
    ws.send(chunk);
  }
}

async function connectInternalDevtools(env: Env, sessionId: string): Promise<WebSocket> {
  const response = await env.BROWSER.fetch(
    `${FAKE_HOST}/v1/connectDevtools?browser_session=${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Upgrade: 'websocket',
        'cf-brapi-client': 'cloudflare-browser-cdp-proxy/1.0',
      },
    }
  );

  if (!response.webSocket) {
    const body = await response.text();
    throw new Error(`Unable to connect to Browser Rendering devtools: ${response.status} ${body}`);
  }

  response.webSocket.accept();
  return response.webSocket;
}

function clearPing(state: ProxyState): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }
}

function closeUpstream(state: ProxyState, closeBrowser: boolean): void {
  const upstream = state.upstream;
  if (!upstream || state.upstreamClosed) return;

  if (closeBrowser && !state.browserCloseSent) {
    try {
      sendChunkedMessage(upstream, JSON.stringify({ id: -1, method: 'Browser.close' }));
    } catch (err) {
      console.warn('[CDP] Failed to send Browser.close during cleanup:', err);
    }
    state.browserCloseSent = true;
  }

  clearPing(state);
  state.upstreamClosed = true;
  state.upstreamReady = false;
  state.upstream = null;

  try {
    upstream.close(1000, 'Closing upstream DevTools session');
  } catch (err) {
    console.warn('[CDP] Failed to close upstream DevTools socket:', err);
  }
}

function closeServer(state: ProxyState, server: WebSocket, code: number, reason: string): void {
  if (state.closed) return;
  state.closed = true;
  clearPing(state);

  try {
    server.close(code, reason);
  } catch (err) {
    console.warn('[CDP] Failed to close client socket:', err);
  }
}

async function initProxy(server: WebSocket, env: Env, state: ProxyState): Promise<void> {
  const { sessionId } = await puppeteer.acquire(env.BROWSER, {
    keep_alive: BROWSER_KEEP_ALIVE_MS,
  });

  const upstream = await connectInternalDevtools(env, sessionId);
  if (state.closed) {
    try {
      sendChunkedMessage(upstream, JSON.stringify({ id: -1, method: 'Browser.close' }));
      upstream.close(1000, 'Client disconnected before proxy initialization completed');
    } catch (err) {
      console.warn('[CDP] Failed to clean up session after early disconnect:', err);
    }
    return;
  }

  state.upstream = upstream;
  state.upstreamReady = true;
  state.upstreamClosed = false;
  state.pingInterval = setInterval(() => {
    try {
      upstream.send('ping');
    } catch (err) {
      console.warn('[CDP] Failed to ping upstream DevTools socket:', err);
    }
  }, INTERNAL_PING_INTERVAL_MS);

  upstream.addEventListener('message', (event) => {
    const chunk = toChunk(event.data);
    if (!chunk) return;

    state.chunks.push(chunk);
    try {
      while (true) {
        const message = chunksToMessage(state.chunks);
        if (!message) break;
        server.send(message);
      }
    } catch (err) {
      console.error('[CDP] Failed to decode Browser Rendering CDP payload:', err);
      closeUpstream(state, true);
      closeServer(state, server, 1011, 'Upstream CDP stream failed');
    }
  });

  upstream.addEventListener('close', () => {
    if (state.closed) return;
    state.upstreamClosed = true;
    state.upstreamReady = false;
    clearPing(state);
    closeServer(state, server, 1000, 'Browser Rendering session closed');
  });

  upstream.addEventListener('error', (event) => {
    console.error('[CDP] Upstream WebSocket error:', event);
    closeUpstream(state, false);
    closeServer(state, server, 1011, 'Upstream CDP socket failed');
  });

  for (const message of state.queuedMessages.splice(0)) {
    sendChunkedMessage(upstream, message);
  }
}

function handleWebSocketUpgrade(request: Request, env: Env): Response {
  const authError = authenticate(request, env);
  if (authError) return authError;

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  const state: ProxyState = {
    closed: false,
    upstream: null,
    upstreamReady: false,
    upstreamClosed: false,
    browserCloseSent: false,
    queuedMessages: [],
    chunks: [],
    pingInterval: null,
  };

  server.addEventListener('message', (event) => {
    const message = toTextMessage(event.data);
    if (message === null) {
      closeServer(state, server, 1003, 'Only text CDP messages are supported');
      closeUpstream(state, true);
      return;
    }

    if (!state.upstreamReady || !state.upstream) {
      state.queuedMessages.push(message);
      return;
    }

    try {
      sendChunkedMessage(state.upstream, message);
    } catch (err) {
      console.error('[CDP] Failed to forward message to Browser Rendering:', err);
      closeUpstream(state, true);
      closeServer(state, server, 1011, 'Failed to forward CDP message');
    }
  });

  server.addEventListener('close', () => {
    state.closed = true;
    closeUpstream(state, true);
  });

  server.addEventListener('error', (event) => {
    console.error('[CDP] Client WebSocket error:', event);
    closeUpstream(state, true);
    closeServer(state, server, 1011, 'Client WebSocket failed');
  });

  initProxy(server, env, state).catch((err) => {
    console.error('[CDP] Failed to initialize proxy session:', err);
    closeUpstream(state, true);
    closeServer(state, server, 1011, 'Failed to initialize Browser Rendering session');
  });

  return new Response(null, { status: 101, webSocket: client });
}

function handleJsonVersion(request: Request): Response {
  const url = new URL(request.url);
  const providedSecret = getSecret(url);
  const wsUrl = buildWebSocketUrl(url, providedSecret || '');

  return new Response(JSON.stringify({
    Browser: 'Cloudflare Browser Rendering',
    'Protocol-Version': '1.3',
    'User-Agent': 'Mozilla/5.0 Cloudflare Browser Rendering',
    'V8-Version': 'cloudflare',
    'WebKit-Version': 'cloudflare',
    webSocketDebuggerUrl: wsUrl,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleJsonList(request: Request): Response {
  return new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleInfoEndpoint(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const providedSecret = getSecret(url);
  const authenticated = !!(env.CDP_SECRET && providedSecret && timingSafeEqual(providedSecret, env.CDP_SECRET));
  const wsHint = authenticated
    ? buildWebSocketUrl(url, providedSecret)
    : 'wss://host/?secret=<CDP_SECRET>';

  return new Response(JSON.stringify({
    name: 'cloudflare-browser-cdp',
    mode: 'proxy',
    authenticated,
    hint: 'Use /json/version for HTTP CDP discovery or connect directly to the WebSocket endpoint.',
    webSocketDebuggerUrl: authenticated ? wsHint : undefined,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/json/version') {
      const authError = authenticate(request, env);
      return authError || handleJsonVersion(request);
    }

    if (path === '/json/list' || path === '/json') {
      const authError = authenticate(request, env);
      return authError || handleJsonList(request);
    }

    if (path === '/' || path === '') {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return handleWebSocketUpgrade(request, env);
      }
      return handleInfoEndpoint(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
