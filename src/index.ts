const BROWSER_KEEP_ALIVE_MS = 600_000;
const BROWSER_BINDING_ORIGIN = 'https://browser-rendering.invalid';
const CONNECTION_ID_HEADER = 'x-cdp-connection-id';
const LIVE_VIEW_ORIGIN = 'https://live.browser.run';
const LIVE_VIEW_TTL_MS = 300_000;
const MAX_LIVE_VIEW_TTL_MS = 3_600_000;

type Authentication = { secretDigest: Uint8Array } | { error: Response };

interface ProxyState {
  closed: boolean;
  upstream: WebSocket | null;
  queuedMessages: string[];
  liveViewRequests: Map<string, number>;
  upstreamMessages: Promise<void>;
}

interface LiveViewLinkValue {
  url: string;
  expiresAt: number;
}

function logLifecycle(
  event: string,
  connectionId: string,
  details: Record<string, string | number | boolean> = {}
): void {
  console.log({ event, connectionId, ...details });
}

async function hashSecret(secret: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  );
}

function configuredSecrets(env: Env): string[] {
  const secrets: unknown = JSON.parse(env.CDP_SECRETS);
  if (
    !Array.isArray(secrets) ||
    secrets.length === 0 ||
    secrets.some((secret) => typeof secret !== 'string' || !secret)
  ) {
    throw new Error('CDP_SECRETS must be a non-empty JSON array of non-empty strings');
  }

  if (new Set(secrets).size !== secrets.length) {
    throw new Error('CDP_SECRETS values must be unique');
  }

  return secrets;
}

async function authenticate(request: Request, env: Env): Promise<Authentication> {
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('secret');
  let secrets: string[];

  try {
    secrets = configuredSecrets(env);
  } catch {
    return {
      error: Response.json({ error: 'Invalid CDP secret configuration' }, { status: 503 }),
    };
  }

  const providedDigest = await hashSecret(providedSecret ?? '');
  let matched = false;
  for (const secretDigest of await Promise.all(secrets.map(hashSecret))) {
    if (crypto.subtle.timingSafeEqual(providedDigest, secretDigest)) matched = true;
  }

  if (!providedSecret || !matched) {
    return {
      error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  if (!env.BROWSER) {
    return {
      error: Response.json({
        error: 'Browser Rendering not configured',
        hint: 'Add browser binding to wrangler.jsonc',
      }, {
        status: 503,
      }),
    };
  }

  return { secretDigest: providedDigest };
}

function digestName(digest: Uint8Array): string {
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}

function buildWebSocketUrl(url: URL): string {
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/${url.search}`;
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

function cdpMessageKey(message: { id: number; sessionId?: unknown }): string {
  return JSON.stringify([message.sessionId ?? null, message.id]);
}

function trackLiveViewRequest(state: ProxyState, message: string): void {
  let command: unknown;
  try {
    command = JSON.parse(message);
  } catch {
    return;
  }
  if (typeof command !== 'object' || command === null || !('id' in command)) return;
  const id = command.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return;

  const key = cdpMessageKey({
    id,
    sessionId: 'sessionId' in command ? command.sessionId : undefined,
  });
  state.liveViewRequests.delete(key);
  if (!('method' in command) || command.method !== 'Cloudflare.getLiveView') return;

  let ttl = LIVE_VIEW_TTL_MS;
  const params = 'params' in command ? command.params : undefined;
  if (typeof params === 'object' && params !== null) {
    if ('expiresInMs' in params && params.expiresInMs !== undefined) {
      if (
        typeof params.expiresInMs !== 'number'
        || !Number.isInteger(params.expiresInMs)
        || params.expiresInMs <= 0
        || params.expiresInMs > MAX_LIVE_VIEW_TTL_MS
      ) {
        ttl = LIVE_VIEW_TTL_MS;
      } else {
        ttl = params.expiresInMs;
      }
    }
  }

  state.liveViewRequests.set(key, Date.now() + ttl);
}

async function relayLiveViewResponse(
  state: ProxyState,
  message: string,
  createLink: (url: string, expiresAt: number) => Promise<string>
): Promise<string> {
  let response: unknown;
  try {
    response = JSON.parse(message);
  } catch {
    return message;
  }
  if (typeof response !== 'object' || response === null || !('id' in response)) return message;
  const id = response.id;
  if (typeof id !== 'number') return message;

  const key = cdpMessageKey({
    id,
    sessionId: 'sessionId' in response ? response.sessionId : undefined,
  });
  const expiresAt = state.liveViewRequests.get(key);
  if (expiresAt === undefined) return message;
  state.liveViewRequests.delete(key);

  if (!('result' in response) || typeof response.result !== 'object' || response.result === null) {
    return message;
  }
  if (!('devtoolsFrontendUrl' in response.result)) return message;
  const upstreamUrl = response.result.devtoolsFrontendUrl;
  if (typeof upstreamUrl !== 'string') return message;

  response.result.devtoolsFrontendUrl = await createLink(upstreamUrl, expiresAt);
  return JSON.stringify(response);
}

function responseDetails(response: Response): { status: number; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'date', 'retry-after', 'server', 'cf-ray']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return { status: response.status, headers };
}

async function connectInternalDevtools(
  env: Env,
  sessionId: string,
  connectionId: string
): Promise<WebSocket | number> {
  logLifecycle('browser_upstream_connecting', connectionId);
  const response = await env.BROWSER.fetch(
    `${BROWSER_BINDING_ORIGIN}/v1/devtools/browser/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Upgrade: 'websocket',
        'cf-brapi-client': 'cloudflare-browser-cdp-proxy/1.0',
      },
    }
  );

  if (!response.webSocket) {
    console.error({
      event: 'browser_upstream_rejected',
      connectionId,
      ...responseDetails(response),
    });
    return response.status;
  }

  response.webSocket.accept();
  logLifecycle('browser_upstream_connected', connectionId);
  return response.webSocket;
}

async function acquireBrowser(env: Env, connectionId: string): Promise<string> {
  logLifecycle('browser_session_acquiring', connectionId);
  const response = await env.BROWSER.fetch(
    `${BROWSER_BINDING_ORIGIN}/v1/devtools/browser?keep_alive=${BROWSER_KEEP_ALIVE_MS}`,
    { method: 'POST' }
  );

  if (response.status !== 200) {
    console.error({
      event: 'browser_session_rejected',
      connectionId,
      ...responseDetails(response),
    });
    throw new Error(`Unable to create browser: ${response.status}`);
  }

  const body: unknown = await response.json();
  if (
    typeof body !== 'object'
    || body === null
    || !('sessionId' in body)
    || typeof body.sessionId !== 'string'
    || !body.sessionId
  ) {
    throw new Error('Browser Rendering returned an invalid session ID');
  }

  logLifecycle('browser_session_acquired', connectionId);
  return body.sessionId;
}

function closeUpstream(state: ProxyState): void {
  const upstream = state.upstream;
  if (!upstream) return;
  state.upstream = null;

  try {
    upstream.close(1000, 'Closing upstream DevTools session');
  } catch {
    console.warn({ event: 'browser_upstream_close_failed' });
  }
}

function closeServer(state: ProxyState, server: WebSocket, code: number, reason: string): void {
  if (state.closed) return;
  state.closed = true;

  try {
    server.close(code, reason);
  } catch {
    console.warn({ event: 'client_close_failed' });
  }
}

async function initProxy(
  server: WebSocket,
  state: ProxyState,
  connectionId: string,
  connectUpstream: () => Promise<WebSocket>,
  createLiveViewLink: (url: string, expiresAt: number) => Promise<string>
): Promise<void> {
  const upstream = await connectUpstream();
  if (state.closed) {
    try {
      upstream.close(1000, 'Client disconnected before proxy initialization completed');
    } catch {
      console.warn({ event: 'browser_upstream_close_failed', connectionId });
    }
    return;
  }

  state.upstream = upstream;
  logLifecycle('proxy_ready', connectionId);

  upstream.addEventListener('message', (event) => {
    const message = toTextMessage(event.data);
    if (message === null) {
      console.error({ event: 'browser_message_unsupported', connectionId });
      closeUpstream(state);
      closeServer(state, server, 1011, 'Upstream CDP stream failed');
      return;
    }

    state.upstreamMessages = state.upstreamMessages
      .then(async () => {
        server.send(await relayLiveViewResponse(state, message, createLiveViewLink));
      })
      .catch(() => {
        console.error({ event: 'live_view_relay_failed', connectionId });
        closeUpstream(state);
        closeServer(state, server, 1011, 'Failed to create Live View share link');
      });
  });

  upstream.addEventListener('close', (event) => {
    state.upstream = null;
    logLifecycle('browser_upstream_disconnected', connectionId, { code: event.code });
    if (state.closed) return;
    closeServer(state, server, 1000, 'Browser Rendering session closed');
  });

  upstream.addEventListener('error', () => {
    if (state.closed || state.upstream !== upstream) return;
    console.error({ event: 'browser_upstream_error', connectionId });
    closeUpstream(state);
    closeServer(state, server, 1011, 'Upstream CDP socket failed');
  });

  for (const message of state.queuedMessages.splice(0)) {
    upstream.send(message);
  }
}

function handleProxyWebSocket(
  connectionId: string,
  connectUpstream: () => Promise<WebSocket>,
  createLiveViewLink: (url: string, expiresAt: number) => Promise<string>
): Response {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  server.accept();

  const state: ProxyState = {
    closed: false,
    upstream: null,
    queuedMessages: [],
    liveViewRequests: new Map(),
    upstreamMessages: Promise.resolve(),
  };

  server.addEventListener('message', (event) => {
    const message = toTextMessage(event.data);
    if (message === null) {
      closeServer(state, server, 1003, 'Only text CDP messages are supported');
      closeUpstream(state);
      return;
    }

    trackLiveViewRequest(state, message);

    if (!state.upstream) {
      state.queuedMessages.push(message);
      return;
    }

    try {
      state.upstream.send(message);
    } catch {
      console.error({ event: 'browser_message_forward_failed', connectionId });
      closeUpstream(state);
      closeServer(state, server, 1011, 'Failed to forward CDP message');
    }
  });

  server.addEventListener('close', (event) => {
    state.closed = true;
    logLifecycle('client_disconnected', connectionId, { code: event.code });
    closeUpstream(state);
  });

  server.addEventListener('error', () => {
    if (state.closed) return;
    console.error({ event: 'client_error', connectionId });
    closeUpstream(state);
    closeServer(state, server, 1011, 'Client WebSocket failed');
  });

  initProxy(server, state, connectionId, connectUpstream, createLiveViewLink).catch(() => {
    console.error({ event: 'proxy_initialization_failed', connectionId });
    closeUpstream(state);
    closeServer(state, server, 1011, 'Failed to initialize Browser Rendering session');
  });

  return new Response(null, { status: 101, webSocket: client });
}

export class BrowserSession {
  private state: DurableObjectState;
  private env: Env;
  private sessionId: string | undefined;
  private sessionPromise: Promise<string> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private getSessionId(connectionId: string): Promise<string> {
    if (this.sessionId) {
      logLifecycle('browser_session_reused', connectionId, { source: 'memory' });
      return Promise.resolve(this.sessionId);
    }
    if (this.sessionPromise) {
      logLifecycle('browser_session_reused', connectionId, { source: 'pending' });
      return this.sessionPromise;
    }

    this.sessionPromise = this.loadOrAcquireSession(connectionId).finally(() => {
      this.sessionPromise = undefined;
    });
    return this.sessionPromise;
  }

  private async loadOrAcquireSession(connectionId: string): Promise<string> {
    const stored = await this.state.storage.get<string>('sessionId');
    if (stored) {
      this.sessionId = stored;
      logLifecycle('browser_session_reused', connectionId, { source: 'storage' });
      return stored;
    }

    return this.acquireSession(connectionId);
  }

  private async acquireSession(connectionId: string): Promise<string> {
    const sessionId = await acquireBrowser(this.env, connectionId);
    await this.state.storage.put('sessionId', sessionId);
    this.sessionId = sessionId;
    return sessionId;
  }

  private replaceSession(failedSessionId: string, connectionId: string): Promise<string> {
    if (this.sessionId !== failedSessionId) return this.getSessionId(connectionId);

    logLifecycle('browser_session_replacing', connectionId);
    this.sessionId = undefined;
    this.sessionPromise = (async () => {
      await this.state.storage.delete('sessionId');
      return this.acquireSession(connectionId);
    })().finally(() => {
      this.sessionPromise = undefined;
    });
    return this.sessionPromise;
  }

  private async connectUpstream(connectionId = crypto.randomUUID()): Promise<WebSocket> {
    const sessionId = await this.getSessionId(connectionId);
    const connection = await connectInternalDevtools(this.env, sessionId, connectionId);
    if (typeof connection !== 'number') return connection;
    if (connection !== 404 && connection !== 410) {
      throw new Error(`Unable to connect to Browser Rendering devtools: ${connection}`);
    }

    const replacementId = await this.replaceSession(sessionId, connectionId);
    const replacement = await connectInternalDevtools(this.env, replacementId, connectionId);
    if (typeof replacement === 'number') {
      throw new Error(`Unable to connect to replacement Browser Rendering session: ${replacement}`);
    }
    return replacement;
  }

  private async createLiveViewLink(
    origin: string,
    upstreamUrl: string,
    expiresAt: number
  ): Promise<string> {
    let url: URL;
    try {
      url = new URL(upstreamUrl);
    } catch {
      throw new Error('Browser Rendering returned an invalid Live View URL');
    }
    if (url.origin !== LIVE_VIEW_ORIGIN) {
      throw new Error('Browser Rendering returned an unexpected Live View origin');
    }

    const token = crypto.randomUUID();
    const response = await this.env.LIVE_VIEW_LINKS.getByName(token).fetch(
      'https://live-view-link.invalid/',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: upstreamUrl, expiresAt }),
      }
    );
    if (response.status !== 204) throw new Error('Unable to store Live View share link');
    return new URL(`/handoff/${token}`, origin).toString();
  }

  fetch(request: Request): Response {
    const connectionId = request.headers.get(CONNECTION_ID_HEADER) ?? crypto.randomUUID();
    const origin = new URL(request.url).origin;
    return handleProxyWebSocket(
      connectionId,
      () => this.connectUpstream(connectionId),
      (url, expiresAt) => this.createLiveViewLink(origin, url, expiresAt)
    );
  }
}

export class LiveViewLink {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'PUT') {
      let value: unknown;
      try {
        value = await request.json();
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
      if (
        typeof value !== 'object'
        || value === null
        || !('url' in value)
        || typeof value.url !== 'string'
        || !('expiresAt' in value)
        || typeof value.expiresAt !== 'number'
        || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= Date.now()
        || value.expiresAt > Date.now() + MAX_LIVE_VIEW_TTL_MS
      ) {
        return new Response('Bad Request', { status: 400 });
      }

      try {
        if (new URL(value.url).origin !== LIVE_VIEW_ORIGIN) {
          return new Response('Bad Request', { status: 400 });
        }
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      const link = value as LiveViewLinkValue;
      await this.state.storage.put('link', link);
      await this.state.storage.setAlarm(link.expiresAt);
      return new Response(null, { status: 204 });
    }

    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

    const value = await this.state.storage.get<LiveViewLinkValue>('link');
    if (!value || value.expiresAt <= Date.now()) {
      if (value) await this.state.storage.deleteAll();
      return new Response('Not Found', { status: 404 });
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: value.url,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
  const authentication = await authenticate(request, env);
  if ('error' in authentication) return authentication.error;

  const session = env.CDP_SESSIONS.getByName(digestName(authentication.secretDigest));
  const internalUrl = new URL(request.url);
  internalUrl.search = '';
  const internalRequest = new Request(internalUrl, request);
  const connectionId = crypto.randomUUID();
  internalRequest.headers.set(CONNECTION_ID_HEADER, connectionId);
  logLifecycle('client_routed', connectionId);
  return session.fetch(internalRequest);
}

function handleJsonVersion(request: Request): Response {
  return Response.json({
    Browser: 'Cloudflare Browser Rendering',
    'Protocol-Version': '1.3',
    'User-Agent': 'Mozilla/5.0 Cloudflare Browser Rendering',
    'V8-Version': 'cloudflare',
    'WebKit-Version': 'cloudflare',
    webSocketDebuggerUrl: buildWebSocketUrl(new URL(request.url)),
  });
}

async function handleInfoEndpoint(request: Request, env: Env): Promise<Response> {
  const authenticated = !('error' in await authenticate(request, env));

  return Response.json({
    name: 'cloudflare-browser-cdp',
    mode: 'proxy',
    authenticated,
    hint: 'Use /json/version for HTTP CDP discovery or connect directly to the WebSocket endpoint.',
    webSocketDebuggerUrl: authenticated
      ? buildWebSocketUrl(new URL(request.url))
      : undefined,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const handoff = /^\/handoff\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(path);
    if (handoff) {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      return env.LIVE_VIEW_LINKS.getByName(handoff[1]).fetch(request);
    }

    if (path === '/json/version') {
      const authentication = await authenticate(request, env);
      return 'error' in authentication ? authentication.error : handleJsonVersion(request);
    }

    if (path === '/json/list' || path === '/json') {
      const authentication = await authenticate(request, env);
      return 'error' in authentication ? authentication.error : Response.json([]);
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
