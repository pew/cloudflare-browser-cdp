#!/usr/bin/env node
import { createClient } from './cdp-client.js'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

const cdpUrl = process.env.CDP_URL
const secondCdpUrl = process.env.CDP_URL_SECOND

if (!cdpUrl) {
  console.error('Usage: CDP_URL=wss://...?secret=... node scripts/test-browser.js')
  process.exit(1)
}

console.log('Connecting to remote CDP endpoint')

try {
  const client = await createClient({ cdpUrl })
  console.log('Connected! Target ID:', client.targetId)
  const targetId = client.targetId

  console.log('Navigating to example.com...')
  await client.navigate('https://example.com')

  console.log('Taking screenshot...')
  const screenshot = await client.screenshot('png')
  writeFileSync('screenshot.png', screenshot)
  console.log('Saved screenshot.png')

  console.log('Getting page text...')
  const text = await client.getText()
  console.log('Page text:', text.substring(0, 200) + '...')

  await client.close()

  console.log('Reconnecting to verify browser persistence...')
  const reconnected = await createClient({ cdpUrl })
  assert.equal(reconnected.targetId, targetId)
  assert.match(await reconnected.getText(), /Example Domain/)
  console.log('Reconnected to the same target:', targetId)

  const concurrent = await createClient({ cdpUrl })
  assert.equal(concurrent.targetId, targetId)
  assert.equal((await concurrent.evaluate('document.title')).result.value, 'Example Domain')
  await Promise.all([reconnected.close(), concurrent.close()])
  console.log('Concurrent client controlled the same target:', targetId)

  if (secondCdpUrl) {
    const isolated = await createClient({ cdpUrl: secondCdpUrl })
    assert.notEqual(isolated.targetId, targetId)
    await isolated.close()
    console.log('Second secret reached an independent target:', isolated.targetId)
  }

  console.log('Done!')
} catch (err) {
  console.error('Error:', err.message)
  process.exit(1)
}
