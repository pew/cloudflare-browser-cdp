#!/usr/bin/env node
import WebSocket from 'ws';

export function createClient(options = {}) {
  const CDP_SECRET = options.secret || process.env.CDP_SECRET;
  if (!CDP_SECRET) {
    throw new Error('CDP_SECRET environment variable not set');
  }
  
  const workerUrl = (options.workerUrl || process.env.WORKER_URL).replace(/^https?:\/\//, '');
  const wsUrl = `wss://${workerUrl}?secret=${encodeURIComponent(CDP_SECRET)}`;
  const timeout = options.timeout || 60000;
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let messageId = 1;
    const pending = new Map();
    let targetId = null;
    let targetResolve;
    const targetReady = new Promise(r => { targetResolve = r; });
    
    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = messageId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`Timeout: ${method}`));
        }, timeout);
        pending.set(id, { resolve: res, reject: rej, timeout: timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.type === 'page') {
        targetId = msg.params.targetInfo.targetId;
        targetResolve(targetId);
      }
      
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timeout: timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    
    ws.on('error', reject);
    
    ws.on('open', async () => {
      try {
        await Promise.race([
          targetReady,
          new Promise((_, rej) => setTimeout(() => rej(new Error('No target created')), 10000))
        ]);
        
        const client = {
          ws,
          targetId,
          send,
          
          async navigate(url, waitMs = 3000) {
            await send('Page.navigate', { url });
            await new Promise(r => setTimeout(r, waitMs));
          },
          
          async screenshot(format = 'png') {
            const { data } = await send('Page.captureScreenshot', { format });
            return Buffer.from(data, 'base64');
          },
          
          async setViewport(width = 1280, height = 800, scale = 1, mobile = false) {
            await send('Emulation.setDeviceMetricsOverride', {
              width, height, deviceScaleFactor: scale, mobile
            });
          },
          
          async evaluate(expression) {
            return send('Runtime.evaluate', { expression });
          },
          
          async scroll(y = 300) {
            await send('Runtime.evaluate', { expression: `window.scrollBy(0, ${y})` });
            await new Promise(r => setTimeout(r, 300));
          },
          
          async click(selector) {
            await send('Runtime.evaluate', { 
              expression: `document.querySelector('${selector}')?.click()` 
            });
          },
          
          async type(selector, text) {
            await send('Runtime.evaluate', {
              expression: `(() => {
                const el = document.querySelector('${selector}');
                if (el) { el.value = '${text}'; el.dispatchEvent(new Event('input')); }
              })()`
            });
          },
          
          async getHTML() {
            const result = await send('Runtime.evaluate', {
              expression: 'document.documentElement.outerHTML'
            });
            return result.result?.value;
          },
          
          async getText() {
            const result = await send('Runtime.evaluate', {
              expression: 'document.body.innerText'
            });
            return result.result?.value;
          },
          
          close() {
            ws.close();
          }
        };
        
        resolve(client);
      } catch (err) {
        reject(err);
      }
    });
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  console.log('CDP Client Library');
  console.log('');
  console.log('Usage:');
  console.log('  import { createClient } from "./scripts/cdp-client.js";');
  console.log('  const client = await createClient({ secret: "...", workerUrl: "..." });');
  console.log('  await client.navigate("https://example.com");');
  console.log('  const screenshot = await client.screenshot();');
  console.log('  client.close();');
}
