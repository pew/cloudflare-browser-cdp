#!/usr/bin/env node
import assert from 'node:assert/strict'

const commands = []

class FakeWebSocket extends EventTarget {
  constructor() {
    super()
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

  close() {}
}

globalThis.WebSocket = FakeWebSocket

const { createClient } = await import('./cdp-client.js')
const client = await createClient({ secret: 'test', workerUrl: 'example.test' })
await client.navigate('https://example.com', 0)
await client.evaluate('document.title')
client.close()

assert.deepEqual(
  commands.map(({ method }) => method),
  ['Target.getTargets', 'Target.attachToTarget', 'Page.navigate', 'Runtime.evaluate'],
)
assert.deepEqual(commands[1].params, { targetId: 'page-1', flatten: true })
assert.equal(commands[0].sessionId, undefined)
assert.equal(commands[1].sessionId, undefined)
assert.equal(commands[2].sessionId, 'session-1')
assert.equal(commands[3].sessionId, 'session-1')

console.log('CDP client attaches to the page target and routes page commands through its session')
