#!/usr/bin/env node
import { createClient } from './cdp-client.js'
import { writeFileSync } from 'fs'

const secret = process.env.CDP_SECRET
const workerUrl = process.env.WORKER_URL

if (!secret || !workerUrl) {
  console.error('Usage: CDP_SECRET=xxx WORKER_URL=your-worker.workers.dev node scripts/test-browser.js')
  process.exit(1)
}

console.log('Connecting to', workerUrl)

try {
  const client = await createClient({ secret, workerUrl })
  console.log('Connected! Target ID:', client.targetId)

  console.log('Navigating to example.com...')
  await client.navigate('https://example.com')

  console.log('Taking screenshot...')
  const screenshot = await client.screenshot('png')
  writeFileSync('screenshot.png', screenshot)
  console.log('Saved screenshot.png')

  console.log('Getting page text...')
  const text = await client.getText()
  console.log('Page text:', text.substring(0, 200) + '...')

  client.close()
  console.log('Done!')
} catch (err) {
  console.error('Error:', err.message)
  process.exit(1)
}
