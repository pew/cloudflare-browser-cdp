#!/usr/bin/env node
import { createClient } from './cdp-client.js'

const handoffTimeout = Number(process.env.HANDOFF_TIMEOUT_MS || 600_000)
if (!Number.isInteger(handoffTimeout) || handoffTimeout < 1 || handoffTimeout > 600_000) {
  throw new Error('HANDOFF_TIMEOUT_MS must be an integer between 1 and 600000')
}

const client = await createClient()

try {
  await client.navigate(process.env.HANDOFF_URL || 'https://example.com')

  const state = await client.send('Cloudflare.getHandoffState', {
    targetId: client.targetId,
  })
  if (state.active) {
    throw new Error(`Handoff ${state.handoffId} is already active`)
  }

  let handoffId
  const { devtoolsFrontendUrl } = await client.send('Cloudflare.getLiveView', {
    targetId: client.targetId,
    mode: 'tab',
    expiresInMs: 300_000,
  })
  console.log('Open this short-lived Live View URL:', devtoolsFrontendUrl)

  const handoffComplete = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for Cloudflare.handoffComplete')),
      handoffTimeout + 15_000,
    )

    const onClose = () => finish(reject, new Error('CDP connection closed during handoff'))
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      const result = message.method === 'Cloudflare.handoffComplete' ? message.params : null
      if (
        !result ||
        result.targetId !== client.targetId ||
        (handoffId && result.handoffId && result.handoffId !== handoffId)
      ) {
        return
      }
      finish(resolve, result)
    }
    const finish = (settle, value) => {
      clearTimeout(timer)
      client.ws.removeEventListener('close', onClose)
      client.ws.removeEventListener('message', onMessage)
      settle(value)
    }

    client.ws.addEventListener('close', onClose)
    client.ws.addEventListener('message', onMessage)
  })

  const handoffRequest = client.send('Cloudflare.handoff', {
    targetId: client.targetId,
    instructions: process.env.HANDOFF_INSTRUCTIONS || 'Interact with the page, then select Done.',
    timeout: handoffTimeout,
  }).then((handoff) => {
    handoffId = handoff.handoffId
    return handoff
  })

  const [, result] = await Promise.all([handoffRequest, handoffComplete])
  if (!result.success) {
    throw new Error(`Handoff failed: ${result.reason || 'no reason provided'}`)
  }

  const finalState = await client.send('Cloudflare.getHandoffState', {
    targetId: client.targetId,
  })
  if (finalState.active) {
    throw new Error('Handoff still active after completion')
  }

  const title = await client.evaluate('document.title')
  console.log('Handoff complete; automation resumed on:', title.result?.value)
} finally {
  await client.close()
}
