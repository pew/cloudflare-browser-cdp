#!/usr/bin/env node
import assert from 'node:assert/strict'
import { timingSafeEqual } from 'node:crypto'

const commands = []
const webSocketUrls = []

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super()
    webSocketUrls.push(url)
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }

  send(data) {
    const command = JSON.parse(data)
    commands.push(command)

    const results = {
      'Target.getTargets': {
        targetInfos: [{ targetId: 'page-1', type: 'page' }],
      },
      'Target.attachToTarget': { sessionId: 'session-1' },
      'Page.navigate': {},
      'Runtime.evaluate': { result: { value: 'Example Domain' } },
    }
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: command.id, result: results[command.method] }),
      }))
    })
  }

  close() {
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }
}

globalThis.WebSocket = FakeWebSocket

const { createClient } = await import('./cdp-client.js')
assert.throws(() => createClient(), /CDP_URL environment variable not set/)

const client = await createClient({ cdpUrl: 'wss://example.test/?secret=test' })
await client.navigate('https://example.com', 0)
await client.evaluate('document.title')
await client.close()

assert.deepEqual(
  commands.map(({ method }) => method),
  [
    'Target.getTargets',
    'Target.attachToTarget',
    'Page.navigate',
    'Runtime.evaluate',
  ],
)
assert.deepEqual(commands[1].params, { targetId: 'page-1', flatten: true })
assert.equal(commands[0].sessionId, undefined)
assert.equal(commands[1].sessionId, undefined)
assert.equal(commands[2].sessionId, 'session-1')
assert.equal(commands[3].sessionId, 'session-1')

const directUrl = 'wss://example.test/?secret=signed%2Fvalue&token=a%2Bb%3D%3D'
const directClient = await createClient({ cdpUrl: directUrl })
await directClient.close()
assert.equal(webSocketUrls.at(-1), directUrl)

const comparisonSizes = []
globalThis.crypto.subtle.timingSafeEqual = (a, b) => {
  comparisonSizes.push([a.byteLength, b.byteLength])
  return timingSafeEqual(a, b)
}

const { default: worker, BrowserSession, LiveViewLink } = await import('../src/index.ts')
const query = 'secret=signed%2Fvalue&token=a%2Bb%3D%3D&flag&token=second'
const response = await worker.fetch(
  new Request(`https://example.test/json/version?${query}`),
  { CDP_SECRETS: '["signed/value"]', BROWSER: {} },
)
const discovery = await response.json()

assert.equal(response.status, 200)
assert.equal(discovery.webSocketDebuggerUrl, `wss://example.test/?${query}`)

const routedNames = []
const routedQueries = []
const routedUrls = []
const routedConnectionIds = []
const routedEnv = {
  BROWSER: {},
  CDP_SECRETS: '["alpha","beta"]',
  CDP_SESSIONS: {
    getByName(name) {
      routedNames.push(name)
      return {
        fetch(request) {
          routedQueries.push(new URL(request.url).search)
          routedUrls.push(request.url)
          routedConnectionIds.push(request.headers.get('x-cdp-connection-id'))
          return new Response(null, {
            status: request.headers.get('sec-websocket-key') ? 204 : 400,
          })
        },
      }
    },
  },
}

async function status(path, env = routedEnv) {
  return (await worker.fetch(new Request(`https://example.test${path}`), env)).status
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Buffer.from(digest).toString('hex')
}

assert.equal(await status('/json/version?secret=alpha'), 200)
assert.equal(await status('/json/version?secret=beta'), 200)
assert.equal(await status('/json/version?secret=gamma'), 401)
assert.equal(await status('/json/version?secret=alpha', { ...routedEnv, CDP_SECRETS: 'not-json' }), 503)
assert.equal(await status('/json/version?secret=alpha', { ...routedEnv, CDP_SECRETS: '[""]' }), 503)
assert.equal(await status('/json/version?secret=alpha', { ...routedEnv, CDP_SECRETS: '["alpha","alpha"]' }), 503)
assert.deepEqual(
  await (await worker.fetch(
    new Request('https://example.test/json/version?secret=alpha'),
    { ...routedEnv, CDP_SECRETS: '[]' },
  )).json(),
  { error: 'Invalid CDP secret configuration' },
)
const variedLengthEnv = { ...routedEnv, CDP_SECRETS: '["short","a-much-longer-secret"]' }
assert.equal(await status('/json/version?secret=short', variedLengthEnv), 200)
assert.equal(await status('/json/version?secret=a-much-longer-secret', variedLengthEnv), 200)
assert(comparisonSizes.length > 0)
assert(comparisonSizes.every(([a, b]) => a === 32 && b === 32))

const lifecycleLogs = []
const originalConsoleLog = console.log
console.log = (entry) => lifecycleLogs.push(entry)
try {
  for (const secret of ['alpha', 'beta']) {
    const routed = await worker.fetch(new Request(`https://example.test/?secret=${secret}`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    }), routedEnv)
    assert.equal(routed.status, 204)
  }
} finally {
  console.log = originalConsoleLog
}

assert.deepEqual(routedNames, [await sha256Hex('alpha'), await sha256Hex('beta')])
assert.deepEqual(routedQueries, ['', ''])
assert.deepEqual(routedUrls, ['https://example.test/', 'https://example.test/'])
assert.equal(new Set(routedConnectionIds).size, 2)
assert(routedConnectionIds.every((connectionId) => typeof connectionId === 'string'))
assert.deepEqual(
  lifecycleLogs.map(({ event }) => event),
  ['client_routed', 'client_routed'],
)
assert.deepEqual(
  lifecycleLogs.map(({ connectionId }) => connectionId),
  routedConnectionIds,
)
for (const privateValue of ['alpha', 'beta', 'secret=']) {
  assert.doesNotMatch(JSON.stringify(lifecycleLogs), new RegExp(privateValue))
}

function memoryStorage(entries = []) {
  const values = new Map(entries)
  return {
    values,
    alarmAt: undefined,
    async get(key) {
      return values.get(key)
    },
    async put(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      return values.delete(key)
    },
    async deleteAll() {
      values.clear()
    },
    async setAlarm(timestamp) {
      this.alarmAt = timestamp
    },
  }
}

function fakeBrowser({ rejectSession, rejectStatus = 410, throwSession } = {}) {
  const state = {
    acquisitions: 0,
    connections: [],
    rejected: false,
  }

  return {
    state,
    binding: {
      async fetch(input, init = {}) {
        const url = new URL(input)
        if (init.method === 'POST') {
          state.acquisitions += 1
          return new Response(JSON.stringify({ sessionId: `session-${state.acquisitions}` }))
        }

        const sessionId = decodeURIComponent(url.pathname.split('/').at(-1))
        state.connections.push(sessionId)
        if (sessionId === throwSession) {
          throw new Error('transient-connect-canary')
        }
        if (sessionId === rejectSession && !state.rejected) {
          state.rejected = true
          return {
            status: rejectStatus,
            headers: new Headers({
              'cf-ray': 'safe-ray-id',
              'set-cookie': 'private-cookie',
            }),
            async text() {
              return 'response-body-canary'
            },
          }
        }

        return {
          status: 101,
          headers: new Headers(),
          webSocket: { accept() {} },
        }
      },
    },
  }
}

const browserLifecycleLogs = []
console.log = (entry) => browserLifecycleLogs.push(entry)

const sharedStorage = memoryStorage()
const sharedBrowser = fakeBrowser()
const firstObject = new BrowserSession({ storage: sharedStorage }, { BROWSER: sharedBrowser.binding })
await Promise.all([firstObject.connectUpstream(), firstObject.connectUpstream()])
assert.equal(sharedBrowser.state.acquisitions, 1)
assert.deepEqual(sharedBrowser.state.connections, ['session-1', 'session-1'])

const afterEviction = new BrowserSession({ storage: sharedStorage }, { BROWSER: sharedBrowser.binding })
await afterEviction.connectUpstream()
assert.equal(sharedBrowser.state.acquisitions, 1)
assert.equal(sharedBrowser.state.connections.at(-1), 'session-1')

const recoveryStorage = memoryStorage([['sessionId', 'expired-session']])
const recoveryBrowser = fakeBrowser({ rejectSession: 'expired-session' })
const diagnostics = []
const originalConsoleError = console.error
console.error = (...args) => diagnostics.push(args)
try {
  const recoveringObject = new BrowserSession(
    { storage: recoveryStorage },
    {
      BROWSER: recoveryBrowser.binding,
      CDP_SECRETS: '["top-secret","second-secret"]',
    },
  )
  await recoveringObject.connectUpstream()
} finally {
  console.error = originalConsoleError
}

assert.equal(recoveryBrowser.state.acquisitions, 1)
assert.deepEqual(recoveryBrowser.state.connections, ['expired-session', 'session-1'])
assert.equal(recoveryStorage.values.get('sessionId'), 'session-1')
const renderedDiagnostics = JSON.stringify(diagnostics)
assert.match(renderedDiagnostics, /410/)
assert.match(renderedDiagnostics, /safe-ray-id/)
for (const privateValue of ['top-secret', 'second-secret', 'private-cookie', 'response-body-canary']) {
  assert.doesNotMatch(renderedDiagnostics, new RegExp(privateValue))
}

const transientStorage = memoryStorage([['sessionId', 'stable-session']])
const transientBrowser = fakeBrowser({ throwSession: 'stable-session' })
const transientObject = new BrowserSession(
  { storage: transientStorage },
  { BROWSER: transientBrowser.binding },
)
await assert.rejects(() => transientObject.connectUpstream(), /transient-connect-canary/)
assert.equal(transientBrowser.state.acquisitions, 0)
assert.equal(transientStorage.values.get('sessionId'), 'stable-session')

const rateLimitedStorage = memoryStorage([['sessionId', 'rate-limited-session']])
const rateLimitedBrowser = fakeBrowser({
  rejectSession: 'rate-limited-session',
  rejectStatus: 429,
})
const rateLimitedObject = new BrowserSession(
  { storage: rateLimitedStorage },
  { BROWSER: rateLimitedBrowser.binding },
)
console.error = () => {}
try {
  await assert.rejects(() => rateLimitedObject.connectUpstream(), /429/)
} finally {
  console.error = originalConsoleError
}
assert.equal(rateLimitedBrowser.state.acquisitions, 0)
assert.equal(rateLimitedStorage.values.get('sessionId'), 'rate-limited-session')

console.log = originalConsoleLog
const browserLifecycleEvents = new Set(browserLifecycleLogs.map(({ event }) => event))
for (const event of [
  'browser_session_acquiring',
  'browser_session_acquired',
  'browser_session_reused',
  'browser_session_replacing',
  'browser_upstream_connecting',
  'browser_upstream_connected',
]) {
  assert(browserLifecycleEvents.has(event))
}
for (const privateValue of [
  'top-secret',
  'second-secret',
  'expired-session',
  'stable-session',
  'rate-limited-session',
]) {
  assert.doesNotMatch(JSON.stringify(browserLifecycleLogs), new RegExp(privateValue))
}

const rawLiveViewUrl =
  'https://live.browser.run/ui/view?mode=tab&wss=live.browser.run%2Fdevtools%3Fjwt%3DeyJhbGciOiJIUzI1NiJ9.payload.signature'
const directLinkStorage = memoryStorage()
const directLink = new LiveViewLink({ storage: directLinkStorage })
const expiresAt = Date.now() + 60_000
assert.equal((await directLink.fetch(new Request('https://link.internal/', {
  method: 'PUT',
  body: JSON.stringify({ url: rawLiveViewUrl, expiresAt }),
}))).status, 204)
assert.equal(directLinkStorage.alarmAt, expiresAt)
const directRedirect = await directLink.fetch(new Request('https://worker.example/handoff/test'))
assert.equal(directRedirect.status, 302)
assert.equal(directRedirect.headers.get('location'), rawLiveViewUrl)
assert.equal(directRedirect.headers.get('cache-control'), 'no-store')
assert.equal(directRedirect.headers.get('referrer-policy'), 'no-referrer')
assert.equal(directRedirect.headers.get('x-robots-tag'), 'noindex')
assert.equal((await directLink.fetch(new Request('https://link.internal/', {
  method: 'PUT',
  body: JSON.stringify({ url: 'https://attacker.example/', expiresAt }),
}))).status, 400)
directLinkStorage.values.set('link', { url: rawLiveViewUrl, expiresAt: Date.now() - 1 })
assert.equal((await directLink.fetch(new Request('https://worker.example/handoff/test'))).status, 404)
assert.equal(directLinkStorage.values.size, 0)

class PairedWebSocket extends EventTarget {
  readyState = 1

  accept() {}

  send(data) {
    queueMicrotask(() => this.peer.dispatchEvent(new MessageEvent('message', { data })))
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.peer.readyState = 3
    queueMicrotask(() => {
      this.dispatchEvent(new CloseEvent('close', { code, reason }))
      this.peer.dispatchEvent(new CloseEvent('close', { code, reason }))
    })
  }
}

class FakeWebSocketPair {
  constructor() {
    const client = new PairedWebSocket()
    const server = new PairedWebSocket()
    client.peer = server
    server.peer = client
    this[0] = client
    this[1] = server
  }
}

const NativeResponse = Response
globalThis.Response = class extends NativeResponse {
  constructor(body, init = {}) {
    const upgrade = init.status === 101
    super(body, upgrade ? { ...init, status: 200 } : init)
    this.upgradeStatus = upgrade ? 101 : undefined
    this.webSocket = init.webSocket
  }

  get status() {
    return this.upgradeStatus ?? super.status
  }

  static json(data, init) {
    return NativeResponse.json(data, init)
  }
}
globalThis.WebSocketPair = FakeWebSocketPair

const links = new Map()
const liveViewLinks = {
  getByName(token) {
    if (!links.has(token)) {
      links.set(token, new LiveViewLink({ storage: memoryStorage() }))
    }
    return {
      fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init)
        return links.get(token).fetch(request)
      },
    }
  },
}
const browserBinding = {
  async fetch(_input, init = {}) {
    if (init.method === 'POST') {
      return new NativeResponse(JSON.stringify({ sessionId: 'live-view-session' }))
    }

    const pair = new FakeWebSocketPair()
    pair[1].addEventListener('message', (event) => {
      const command = JSON.parse(event.data)
      pair[1].send(JSON.stringify({
        id: command.id,
        sessionId: command.sessionId,
        result: command.method === 'Cloudflare.getLiveView'
          ? { devtoolsFrontendUrl: rawLiveViewUrl }
          : {},
      }))
    })
    return { status: 101, headers: new Headers(), webSocket: pair[0] }
  },
}
const liveViewEnv = {
  BROWSER: browserBinding,
  LIVE_VIEW_LINKS: liveViewLinks,
}
console.log = () => {}
const liveViewSession = new BrowserSession({ storage: memoryStorage() }, liveViewEnv)
const upgrade = liveViewSession.fetch(new Request('https://worker.example/'))
const relayedMessages = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timed out waiting for Live View relay')), 1000)
  const messages = []
  upgrade.webSocket.addEventListener('message', (event) => {
    messages.push(JSON.parse(event.data))
    if (messages.length === 4) {
      clearTimeout(timer)
      resolve(messages)
    }
  })
})
upgrade.webSocket.send(JSON.stringify({
  id: 42,
  method: 'Cloudflare.getLiveView',
  params: { mode: 'tab', expiresInMs: 300_000 },
  sessionId: 'page-session-a',
}))
upgrade.webSocket.send(JSON.stringify({
  id: 42,
  method: 'Runtime.enable',
  sessionId: 'page-session-b',
}))
upgrade.webSocket.send(JSON.stringify({
  id: 43,
  method: 'Cloudflare.getLiveView',
  params: 'invalid',
  sessionId: 'page-session-a',
}))
upgrade.webSocket.send(JSON.stringify({
  id: 44,
  method: 'Cloudflare.getLiveView',
  params: { expiresInMs: 3_600_001 },
  sessionId: 'page-session-a',
}))

const liveViewResponses = (await relayedMessages).filter(({ result }) => result.devtoolsFrontendUrl)
assert.equal(liveViewResponses.length, 3)
for (const { result } of liveViewResponses) {
  assert.match(result.devtoolsFrontendUrl, /^https:\/\/worker\.example\/handoff\/[0-9a-f-]{36}$/)
  assert.doesNotMatch(result.devtoolsFrontendUrl, /jwt|eyJ/)
}
const relayedUrl = liveViewResponses[0].result.devtoolsFrontendUrl
const redirect = await worker.fetch(new Request(relayedUrl), liveViewEnv)
assert.equal(redirect.status, 302)
assert.equal(redirect.headers.get('location'), rawLiveViewUrl)
assert.equal((await worker.fetch(new Request(relayedUrl, { method: 'POST' }), liveViewEnv)).status, 405)
assert.equal((await worker.fetch(new Request('https://worker.example/handoff/not-a-token'), liveViewEnv)).status, 404)

globalThis.Response = NativeResponse
console.log = originalConsoleLog
console.log('CDP clients preserve queries, share browsers, and relay Live View links')
