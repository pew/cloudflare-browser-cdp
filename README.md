# Cloudflare Browser CDP

A Cloudflare Worker that exposes headless Chrome via the Chrome DevTools Protocol (CDP) over WebSocket. Use it as a remote browser for automation, scraping, screenshots, and testing.

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month) - required for Browser Rendering

## Quick Start

```bash
# Install dependencies
npm install

# Set the shared secret for authentication
npx wrangler secret put CDP_SECRET
# Enter a secure random string (e.g., openssl rand -hex 32)

# Deploy
npm run deploy
```

## Endpoints

| Endpoint                                | Description                                             |
| --------------------------------------- | ------------------------------------------------------- |
| `GET /`                                 | Info endpoint (add `?secret=` to see supported methods) |
| `WS /?secret=<CDP_SECRET>`              | WebSocket CDP connection                                |
| `GET /json/version?secret=<CDP_SECRET>` | Browser version info                                    |
| `GET /json/list?secret=<CDP_SECRET>`    | List available targets                                  |
| `GET /json?secret=<CDP_SECRET>`         | Alias for /json/list                                    |

## Connecting

### WebSocket Connection

```javascript
const ws = new WebSocket('wss://your-worker.workers.dev?secret=YOUR_SECRET')

ws.onopen = () => {
  // Send CDP commands
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    }),
  )
}

ws.onmessage = (event) => {
  const response = JSON.parse(event.data)
  console.log(response)
}
```

### Using the Test Script

The quickest way to test your deployment:

```bash
CDP_SECRET=your-secret WORKER_URL=your-worker.workers.dev node scripts/test-browser.js
```

This navigates to example.com, takes a screenshot, and prints page text.

### Using the Client Library

The `scripts/cdp-client.js` provides a high-level API:

```javascript
import { createClient } from './scripts/cdp-client.js'

const client = await createClient({
  secret: 'YOUR_SECRET',
  workerUrl: 'your-worker.workers.dev',
})

await client.navigate('https://example.com')
const screenshot = await client.screenshot('png')
const html = await client.getHTML()
const text = await client.getText()

client.close()
```

## Supported CDP Domains

### Browser

- `getVersion` - Get browser version info
- `close` - Close the browser

### Target

- `createTarget` - Create new page/tab
- `closeTarget` - Close a target
- `getTargets` - List all targets
- `attachToTarget` - Attach to a target

### Page

- `navigate` - Navigate to URL
- `reload` - Reload page
- `captureScreenshot` - Capture screenshot (PNG/JPEG/WebP)
- `printToPDF` - Generate PDF
- `setContent` - Set HTML content
- `getFrameTree` - Get frame tree
- `getLayoutMetrics` - Get layout metrics
- `bringToFront` - Bring page to front
- `addScriptToEvaluateOnNewDocument` - Add script
- `handleJavaScriptDialog` - Handle dialogs
- `stopLoading` - Stop page loading
- `getNavigationHistory` - Get history
- `navigateToHistoryEntry` - Navigate history
- `setBypassCSP` - Bypass CSP

### Runtime

- `evaluate` - Evaluate JavaScript
- `callFunctionOn` - Call function on object
- `getProperties` - Get object properties
- `releaseObject` - Release object reference
- `releaseObjectGroup` - Release object group

### DOM

- `getDocument` - Get document
- `querySelector` - Query selector
- `querySelectorAll` - Query selector all
- `getOuterHTML` - Get outer HTML
- `getAttributes` - Get attributes
- `setAttributeValue` - Set attribute
- `focus` - Focus element
- `getBoxModel` - Get box model
- `scrollIntoViewIfNeeded` - Scroll into view
- `removeNode` - Remove node
- `setNodeValue` - Set node value
- `setFileInputFiles` - Set file input

### Input

- `dispatchMouseEvent` - Mouse events
- `dispatchKeyEvent` - Keyboard events
- `insertText` - Insert text

### Network

- `setCacheDisabled` - Disable cache
- `setExtraHTTPHeaders` - Set headers
- `setCookie` / `setCookies` - Set cookies
- `getCookies` - Get cookies
- `deleteCookies` - Delete cookies
- `clearBrowserCookies` - Clear all cookies
- `setUserAgentOverride` - Set user agent

### Emulation

- `setDeviceMetricsOverride` - Set viewport
- `clearDeviceMetricsOverride` - Reset viewport
- `setUserAgentOverride` - Set user agent
- `setGeolocationOverride` - Set geolocation
- `clearGeolocationOverride` - Clear geolocation
- `setTimezoneOverride` - Set timezone
- `setTouchEmulationEnabled` - Enable touch
- `setEmulatedMedia` - Set media type
- `setDefaultBackgroundColorOverride` - Set background

### Fetch (Request Interception)

- `enable` - Enable interception
- `disable` - Disable interception
- `continueRequest` - Continue request
- `fulfillRequest` - Fulfill request
- `failRequest` - Fail request
- `getResponseBody` - Get response body

## Examples

### Take a Screenshot

```javascript
import { createClient } from './scripts/cdp-client.js'
import { writeFileSync } from 'fs'

async function screenshot(url, outputPath) {
  const client = await createClient({
    secret: process.env.CDP_SECRET,
    workerUrl: process.env.WORKER_URL,
  })

  await client.navigate(url)
  await client.setViewport(1920, 1080)

  const buffer = await client.screenshot('png')
  writeFileSync(outputPath, buffer)

  client.close()
}

screenshot('https://example.com', 'screenshot.png')
```

### Scrape Page Content

```javascript
import { createClient } from './scripts/cdp-client.js'

async function scrape(url) {
  const client = await createClient({
    secret: process.env.CDP_SECRET,
    workerUrl: process.env.WORKER_URL,
  })

  await client.navigate(url)

  const title = await client.evaluate('document.title')
  const text = await client.getText()

  client.close()

  return { title: title.result.value, text }
}
```

### Set Viewport and Mobile Emulation

```javascript
// Desktop
await client.setViewport(1920, 1080, 1, false)

// Mobile
await client.setViewport(375, 812, 2, true)
```

## Local Development

```bash
# Create .dev.vars for local secrets
echo "CDP_SECRET=test-secret" > .dev.vars

# Run locally
npm run dev
```

Note: Browser Rendering works in local development but requires the `remote: true` option in wrangler.jsonc for real browser sessions.

## Secrets

| Secret       | Required | Description                      |
| ------------ | -------- | -------------------------------- |
| `CDP_SECRET` | Yes      | Shared secret for authentication |

## License

MIT
