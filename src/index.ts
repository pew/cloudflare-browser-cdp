const BROWSER_KEEP_ALIVE_MS = 600_000;
const FAKE_HOST = 'https://fake.host';

interface ProxyState {
  closed: boolean;
  upstream: WebSocket | null;
  queuedMessages: string[];
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.byteLength !== bBytes.byteLength) {
    return !crypto.subtle.timingSafeEqual(aBytes, aBytes);
  }

  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

function authenticate(request: Request, env: Env): Response | null {
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('secret');

  if (!env.CDP_SECRET) {
    return Response.json({
      error: 'CDP endpoint not configured',
      hint: 'Set CDP_SECRET via: wrangler secret put CDP_SECRET',
    }, {
      status: 503,
    });
  }

  if (!providedSecret || !timingSafeEqual(providedSecret, env.CDP_SECRET)) {
    return Response.json({ error: 'Unauthorized' }, {
      status: 401,
    });
  }

  if (!env.BROWSER) {
    return Response.json({
      error: 'Browser Rendering not configured',
      hint: 'Add browser binding to wrangler.jsonc',
    }, {
      status: 503,
    });
  }

  return null;
}

function buildWebSocketUrl(url: URL, secret: string): string {
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/?secret=${encodeURIComponent(secret)}`;
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

async function connectInternalDevtools(env: Env, sessionId: string): Promise<WebSocket> {
  const response = await env.BROWSER.fetch(
    `${FAKE_HOST}/v1/devtools/browser/${encodeURIComponent(sessionId)}`,
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

function closeUpstream(state: ProxyState, closeBrowser: boolean): void {
  const upstream = state.upstream;
  if (!upstream) return;
  state.upstream = null;

  if (closeBrowser) {
    try {
      upstream.send(JSON.stringify({ id: -1, method: 'Browser.close' }));
    } catch (err) {
      console.warn('[CDP] Failed to send Browser.close during cleanup:', err);
    }
  }

  try {
    upstream.close(1000, 'Closing upstream DevTools session');
  } catch (err) {
    console.warn('[CDP] Failed to close upstream DevTools socket:', err);
  }
}

function closeServer(state: ProxyState, server: WebSocket, code: number, reason: string): void {
  if (state.closed) return;
  state.closed = true;

  try {
    server.close(code, reason);
  } catch (err) {
    console.warn('[CDP] Failed to close client socket:', err);
  }
}

async function initProxy(server: WebSocket, env: Env, state: ProxyState): Promise<void> {
  const acquireResponse = await env.BROWSER.fetch(
    `${FAKE_HOST}/v1/devtools/browser?keep_alive=${BROWSER_KEEP_ALIVE_MS}`,
    { method: 'POST' }
  );
  const acquireBody = await acquireResponse.text();
  if (acquireResponse.status !== 200) {
    throw new Error(
      `Unable to create new browser: code: ${acquireResponse.status}: message: ${acquireBody}`
    );
  }
  const { sessionId } = JSON.parse(acquireBody) as { sessionId: string };

  const upstream = await connectInternalDevtools(env, sessionId);
  if (state.closed) {
    try {
      upstream.send(JSON.stringify({ id: -1, method: 'Browser.close' }));
      upstream.close(1000, 'Client disconnected before proxy initialization completed');
    } catch (err) {
      console.warn('[CDP] Failed to clean up session after early disconnect:', err);
    }
    return;
  }

  state.upstream = upstream;

  upstream.addEventListener('message', (event) => {
    const message = toTextMessage(event.data);
    if (message === null) {
      console.error('[CDP] Received unsupported message from Browser Rendering');
      closeUpstream(state, true);
      closeServer(state, server, 1011, 'Upstream CDP stream failed');
      return;
    }
    server.send(message);
  });

  upstream.addEventListener('close', () => {
    state.upstream = null;
    if (state.closed) return;
    closeServer(state, server, 1000, 'Browser Rendering session closed');
  });

  upstream.addEventListener('error', (event) => {
    console.error('[CDP] Upstream WebSocket error:', event);
    closeUpstream(state, false);
    closeServer(state, server, 1011, 'Upstream CDP socket failed');
  });

  for (const message of state.queuedMessages.splice(0)) {
    upstream.send(message);
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
    queuedMessages: [],
  };

  server.addEventListener('message', (event) => {
    const message = toTextMessage(event.data);
    if (message === null) {
      closeServer(state, server, 1003, 'Only text CDP messages are supported');
      closeUpstream(state, true);
      return;
    }

    if (!state.upstream) {
      state.queuedMessages.push(message);
      return;
    }

    try {
      state.upstream.send(message);
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
  const providedSecret = url.searchParams.get('secret');
  const wsUrl = buildWebSocketUrl(url, providedSecret || '');

  return Response.json({
    Browser: 'Cloudflare Browser Rendering',
    'Protocol-Version': '1.3',
    'User-Agent': 'Mozilla/5.0 Cloudflare Browser Rendering',
    'V8-Version': 'cloudflare',
    'WebKit-Version': 'cloudflare',
    webSocketDebuggerUrl: wsUrl,
  });
}

function handleInfoEndpoint(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('secret');
  const authenticated = !!(env.CDP_SECRET && providedSecret && timingSafeEqual(providedSecret, env.CDP_SECRET));
  const wsHint = authenticated
    ? buildWebSocketUrl(url, providedSecret)
    : 'wss://host/?secret=<CDP_SECRET>';

  return Response.json({
    name: 'cloudflare-browser-cdp',
    mode: 'proxy',
    authenticated,
    hint: 'Use /json/version for HTTP CDP discovery or connect directly to the WebSocket endpoint.',
    webSocketDebuggerUrl: authenticated ? wsHint : undefined,
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
      return authError || Response.json([]);
    }

    if (path === '/') {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return handleWebSocketUpgrade(request, env);
      }
      return handleInfoEndpoint(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
