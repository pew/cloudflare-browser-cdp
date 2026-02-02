import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';
import type { Env, CDPRequest, CDPResponse, CDPEvent } from './types';

interface CDPSession {
  browser: Browser;
  pages: Map<string, Page>;
  defaultTargetId: string;
  nodeIdCounter: number;
  nodeMap: Map<number, string>;
  objectIdCounter: number;
  objectMap: Map<string, unknown>;
  scriptsToEvaluateOnNewDocument: Map<string, string>;
  extraHTTPHeaders: Map<string, string>;
  requestInterceptionEnabled: boolean;
  pendingRequests: Map<string, { request: Request; resolve: (response: Response) => void }>;
}

const SUPPORTED_METHODS = [
  'Browser.getVersion',
  'Browser.close',
  'Target.createTarget',
  'Target.closeTarget',
  'Target.getTargets',
  'Target.attachToTarget',
  'Page.navigate',
  'Page.reload',
  'Page.captureScreenshot',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.bringToFront',
  'Page.setContent',
  'Page.printToPDF',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.handleJavaScriptDialog',
  'Page.stopLoading',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.setBypassCSP',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getOuterHTML',
  'DOM.getAttributes',
  'DOM.setAttributeValue',
  'DOM.focus',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.removeNode',
  'DOM.setNodeValue',
  'DOM.setFileInputFiles',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Network.enable',
  'Network.disable',
  'Network.setCacheDisabled',
  'Network.setExtraHTTPHeaders',
  'Network.setCookie',
  'Network.setCookies',
  'Network.getCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.setUserAgentOverride',
  'Fetch.enable',
  'Fetch.disable',
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.getResponseBody',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setUserAgentOverride',
  'Emulation.setGeolocationOverride',
  'Emulation.clearGeolocationOverride',
  'Emulation.setTimezoneOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setEmulatedMedia',
  'Emulation.setDefaultBackgroundColorOverride',
];

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function sendResponse(ws: WebSocket, id: number, result: unknown): void {
  const response: CDPResponse = { id, result };
  ws.send(JSON.stringify(response));
}

function sendError(ws: WebSocket, id: number, code: number, message: string): void {
  const response: CDPResponse = { id, error: { code, message } };
  ws.send(JSON.stringify(response));
}

function sendEvent(ws: WebSocket, method: string, params?: Record<string, unknown>): void {
  const event: CDPEvent = { method, params };
  ws.send(JSON.stringify(event));
}

async function handleBrowser(
  session: CDPSession,
  command: string,
): Promise<unknown> {
  switch (command) {
    case 'getVersion':
      return {
        protocolVersion: '1.3',
        product: 'Cloudflare-Browser-Rendering',
        revision: 'cloudflare',
        userAgent: 'Mozilla/5.0 Cloudflare Browser Rendering',
        jsVersion: 'V8',
      };
    case 'close':
      await session.browser.close();
      return {};
    default:
      throw new Error(`Unknown Browser method: ${command}`);
  }
}

async function handleTarget(
  session: CDPSession,
  command: string,
  params: Record<string, unknown>,
  ws: WebSocket
): Promise<unknown> {
  switch (command) {
    case 'createTarget': {
      const url = (params.url as string) || 'about:blank';
      const page = await session.browser.newPage();
      const targetId = crypto.randomUUID();
      session.pages.set(targetId, page);
      if (url !== 'about:blank') {
        await page.goto(url);
      }
      sendEvent(ws, 'Target.targetCreated', {
        targetInfo: {
          targetId,
          type: 'page',
          title: await page.title(),
          url: page.url(),
          attached: true,
        },
      });
      return { targetId };
    }
    case 'closeTarget': {
      const targetId = params.targetId as string;
      const page = session.pages.get(targetId);
      if (!page) throw new Error(`Target not found: ${targetId}`);
      await page.close();
      session.pages.delete(targetId);
      sendEvent(ws, 'Target.targetDestroyed', { targetId });
      return { success: true };
    }
    case 'getTargets': {
      const targets = [];
      for (const [targetId, page] of session.pages) {
        targets.push({
          targetId,
          type: 'page',
          title: await page.title(),
          url: page.url(),
          attached: true,
        });
      }
      return { targetInfos: targets };
    }
    case 'attachToTarget':
      return { sessionId: params.targetId };
    default:
      throw new Error(`Unknown Target method: ${command}`);
  }
}

async function handlePage(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>,
  ws: WebSocket
): Promise<unknown> {
  switch (command) {
    case 'navigate': {
      const url = params.url as string;
      if (!url) throw new Error('url is required');
      const response = await page.goto(url, { waitUntil: 'load' });
      sendEvent(ws, 'Page.frameNavigated', {
        frame: {
          id: session.defaultTargetId,
          url: page.url(),
          securityOrigin: new URL(page.url()).origin,
          mimeType: 'text/html',
        },
      });
      sendEvent(ws, 'Page.loadEventFired', { timestamp: Date.now() / 1000 });
      return {
        frameId: session.defaultTargetId,
        loaderId: crypto.randomUUID(),
        errorText: response?.ok() ? undefined : 'Navigation failed',
      };
    }
    case 'reload':
      await page.reload();
      return {};
    case 'getFrameTree':
      return {
        frameTree: {
          frame: {
            id: session.defaultTargetId,
            loaderId: crypto.randomUUID(),
            url: page.url(),
            securityOrigin: page.url() ? new URL(page.url()).origin : '',
            mimeType: 'text/html',
          },
          childFrames: [],
        },
      };
    case 'captureScreenshot': {
      const format = (params.format as string) || 'png';
      const quality = params.quality as number | undefined;
      const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
      const data = await page.screenshot({
        type: format as 'png' | 'jpeg' | 'webp',
        encoding: 'base64',
        quality: format === 'jpeg' ? quality : undefined,
        clip,
        fullPage: params.fullPage as boolean | undefined,
      });
      return { data };
    }
    case 'getLayoutMetrics': {
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
      }));
      return {
        layoutViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: metrics.clientWidth,
          clientHeight: metrics.clientHeight,
        },
        visualViewport: {
          offsetX: 0,
          offsetY: 0,
          pageX: 0,
          pageY: 0,
          clientWidth: metrics.clientWidth,
          clientHeight: metrics.clientHeight,
          scale: 1,
        },
        contentSize: {
          x: 0,
          y: 0,
          width: metrics.width,
          height: metrics.height,
        },
      };
    }
    case 'bringToFront':
      await page.bringToFront();
      return {};
    case 'setContent': {
      const html = params.html as string;
      if (!html) throw new Error('html is required');
      await page.setContent(html, {
        waitUntil: (params.waitUntil as 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2') || 'load',
      });
      return {};
    }
    case 'printToPDF': {
      const options: Parameters<typeof page.pdf>[0] = {};
      if (params.landscape) options.landscape = params.landscape as boolean;
      if (params.displayHeaderFooter) options.displayHeaderFooter = params.displayHeaderFooter as boolean;
      if (params.printBackground) options.printBackground = params.printBackground as boolean;
      if (params.scale) options.scale = params.scale as number;
      if (params.paperWidth) options.width = `${params.paperWidth}in`;
      if (params.paperHeight) options.height = `${params.paperHeight}in`;
      if (params.marginTop) options.margin = { ...options.margin, top: `${params.marginTop}in` };
      if (params.marginBottom) options.margin = { ...options.margin, bottom: `${params.marginBottom}in` };
      if (params.marginLeft) options.margin = { ...options.margin, left: `${params.marginLeft}in` };
      if (params.marginRight) options.margin = { ...options.margin, right: `${params.marginRight}in` };
      if (params.pageRanges) options.pageRanges = params.pageRanges as string;
      if (params.headerTemplate) options.headerTemplate = params.headerTemplate as string;
      if (params.footerTemplate) options.footerTemplate = params.footerTemplate as string;
      if (params.preferCSSPageSize) options.preferCSSPageSize = params.preferCSSPageSize as boolean;
      const buffer = await page.pdf(options);
      const data = typeof buffer === 'string' ? buffer : Buffer.from(buffer).toString('base64');
      return { data };
    }
    case 'addScriptToEvaluateOnNewDocument': {
      const source = params.source as string;
      if (!source) throw new Error('source is required');
      const identifier = crypto.randomUUID();
      session.scriptsToEvaluateOnNewDocument.set(identifier, source);
      await page.evaluateOnNewDocument(source);
      return { identifier };
    }
    case 'removeScriptToEvaluateOnNewDocument': {
      const identifier = params.identifier as string;
      session.scriptsToEvaluateOnNewDocument.delete(identifier);
      return {};
    }
    case 'handleJavaScriptDialog': {
      const accept = params.accept as boolean;
      const promptText = params.promptText as string | undefined;
      page.on('dialog', async (dialog) => {
        if (accept) {
          await dialog.accept(promptText);
        } else {
          await dialog.dismiss();
        }
      });
      return {};
    }
    case 'stopLoading':
      await page.evaluate(() => window.stop());
      return {};
    case 'getNavigationHistory': {
      const history = await page.evaluate(() => ({
        currentIndex: window.history.length - 1,
        entries: [{
          id: 0,
          url: window.location.href,
          userTypedURL: window.location.href,
          title: document.title,
          transitionType: 'typed',
        }],
      }));
      return history;
    }
    case 'navigateToHistoryEntry': {
      const entryId = params.entryId as number;
      await page.evaluate((id: number) => {
        const delta = id - (window.history.length - 1);
        window.history.go(delta);
      }, entryId);
      return {};
    }
    case 'setBypassCSP': {
      const enabled = params.enabled as boolean;
      await page.setBypassCSP(enabled);
      return {};
    }
    case 'enable':
    case 'disable':
      return {};
    default:
      throw new Error(`Unknown Page method: ${command}`);
  }
}

async function handleRuntime(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case 'evaluate': {
      const expression = params.expression as string;
      if (!expression) throw new Error('expression is required');
      const returnByValue = params.returnByValue ?? true;
      const awaitPromise = params.awaitPromise ?? false;
      try {
        const wrappedExpression = awaitPromise
          ? `(async () => { return ${expression}; })()`
          : expression;
        const result = await page.evaluate(wrappedExpression);
        let objectId: string | undefined;
        if (!returnByValue && result !== null && typeof result === 'object') {
          objectId = `obj-${session.objectIdCounter++}`;
          session.objectMap.set(objectId, result);
        }
        return {
          result: {
            type: typeof result,
            subtype: Array.isArray(result) ? 'array' : (result === null ? 'null' : undefined),
            className: result?.constructor?.name,
            value: returnByValue ? result : undefined,
            objectId,
            description: String(result),
          },
        };
      } catch (err) {
        return {
          exceptionDetails: {
            exceptionId: 1,
            text: err instanceof Error ? err.message : 'Evaluation failed',
            lineNumber: 0,
            columnNumber: 0,
          },
        };
      }
    }
    case 'callFunctionOn': {
      const functionDeclaration = params.functionDeclaration as string;
      const args = (params.arguments as Array<{ value?: unknown; objectId?: string }>) || [];
      const returnByValue = params.returnByValue ?? true;
      try {
        const argValues = args.map(a => {
          if (a.objectId) return session.objectMap.get(a.objectId);
          return a.value;
        });
        const fn = new Function(`return (${functionDeclaration}).apply(this, arguments)`);
        const result = await page.evaluate(fn as () => unknown, ...argValues);
        let objectId: string | undefined;
        if (!returnByValue && result !== null && typeof result === 'object') {
          objectId = `obj-${session.objectIdCounter++}`;
          session.objectMap.set(objectId, result);
        }
        return {
          result: {
            type: typeof result,
            subtype: Array.isArray(result) ? 'array' : (result === null ? 'null' : undefined),
            value: returnByValue ? result : undefined,
            objectId,
          },
        };
      } catch (err) {
        return {
          exceptionDetails: {
            exceptionId: 1,
            text: err instanceof Error ? err.message : 'Call failed',
            lineNumber: 0,
            columnNumber: 0,
          },
        };
      }
    }
    case 'getProperties': {
      const objectId = params.objectId as string;
      const ownProperties = params.ownProperties ?? true;
      const obj = session.objectMap.get(objectId);
      if (!obj || typeof obj !== 'object') return { result: [] };
      const properties: Array<{
        name: string;
        value: { type: string; value?: unknown; description?: string };
        writable?: boolean;
        configurable?: boolean;
        enumerable?: boolean;
        isOwn?: boolean;
      }> = [];
      const keys = ownProperties ? Object.getOwnPropertyNames(obj) : Object.keys(obj as object);
      for (const key of keys) {
        const value = (obj as Record<string, unknown>)[key];
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        properties.push({
          name: key,
          value: {
            type: typeof value,
            value,
            description: String(value),
          },
          writable: descriptor?.writable,
          configurable: descriptor?.configurable,
          enumerable: descriptor?.enumerable,
          isOwn: true,
        });
      }
      return { result: properties };
    }
    case 'releaseObject': {
      const objectId = params.objectId as string;
      session.objectMap.delete(objectId);
      return {};
    }
    case 'releaseObjectGroup':
      session.objectMap.clear();
      return {};
    case 'enable':
    case 'disable':
      return {};
    default:
      throw new Error(`Unknown Runtime method: ${command}`);
  }
}

async function handleDOM(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case 'getDocument': {
      const depth = (params.depth as number) ?? 1;
      const doc = await page.evaluate((maxDepth: number) => {
        function serializeNode(node: Node, currentDepth: number): unknown {
          const base: Record<string, unknown> = {
            nodeId: Math.floor(Math.random() * 1000000),
            nodeType: node.nodeType,
            nodeName: node.nodeName,
            localName: node.nodeName.toLowerCase(),
            nodeValue: node.nodeValue || '',
          };
          if (node instanceof Element) {
            base.attributes = [];
            for (const attr of node.attributes) {
              (base.attributes as string[]).push(attr.name, attr.value);
            }
            if (currentDepth < maxDepth && node.children.length > 0) {
              base.children = [];
              for (const child of node.children) {
                (base.children as unknown[]).push(serializeNode(child, currentDepth + 1));
              }
              base.childNodeCount = node.children.length;
            } else {
              base.childNodeCount = node.children.length;
            }
          }
          return base;
        }
        return serializeNode(document.documentElement, 0);
      }, depth);
      const rootNodeId = session.nodeIdCounter++;
      session.nodeMap.set(rootNodeId, 'html');
      return {
        root: {
          nodeId: rootNodeId,
          backendNodeId: rootNodeId,
          nodeType: 9,
          nodeName: '#document',
          localName: '',
          nodeValue: '',
          childNodeCount: 1,
          children: [doc],
          documentURL: page.url(),
          baseURL: page.url(),
        },
      };
    }
    case 'querySelector': {
      const selector = params.selector as string;
      if (!selector) throw new Error('selector is required');
      const element = await page.$(selector);
      if (!element) return { nodeId: 0 };
      const nodeId = session.nodeIdCounter++;
      session.nodeMap.set(nodeId, selector);
      return { nodeId };
    }
    case 'querySelectorAll': {
      const selector = params.selector as string;
      if (!selector) throw new Error('selector is required');
      const elements = await page.$$(selector);
      const nodeIds = elements.map((_, i) => {
        const nodeId = session.nodeIdCounter++;
        session.nodeMap.set(nodeId, `${selector}:nth-of-type(${i + 1})`);
        return nodeId;
      });
      return { nodeIds };
    }
    case 'getOuterHTML': {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) {
        const html = await page.content();
        return { outerHTML: html };
      }
      const html = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return el ? el.outerHTML : '';
      }, selector);
      return { outerHTML: html };
    }
    case 'getAttributes': {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      const attributes = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return [];
        const attrs: string[] = [];
        for (const attr of el.attributes) {
          attrs.push(attr.name, attr.value);
        }
        return attrs;
      }, selector);
      return { attributes };
    }
    case 'setAttributeValue': {
      const nodeId = params.nodeId as number;
      const name = params.name as string;
      const value = params.value as string;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      await page.evaluate((sel: string, attrName: string, attrValue: string) => {
        const el = document.querySelector(sel);
        if (el) el.setAttribute(attrName, attrValue);
      }, selector, name, value);
      return {};
    }
    case 'focus': {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      await page.focus(selector);
      return {};
    }
    case 'getBoxModel': {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      const boxModel = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const style = window.getComputedStyle(el);
        const paddingTop = parseFloat(style.paddingTop);
        const paddingRight = parseFloat(style.paddingRight);
        const paddingBottom = parseFloat(style.paddingBottom);
        const paddingLeft = parseFloat(style.paddingLeft);
        const borderTop = parseFloat(style.borderTopWidth);
        const borderRight = parseFloat(style.borderRightWidth);
        const borderBottom = parseFloat(style.borderBottomWidth);
        const borderLeft = parseFloat(style.borderLeftWidth);
        const content = {
          x: rect.left + scrollX + borderLeft + paddingLeft,
          y: rect.top + scrollY + borderTop + paddingTop,
          width: rect.width - borderLeft - borderRight - paddingLeft - paddingRight,
          height: rect.height - borderTop - borderBottom - paddingTop - paddingBottom,
        };
        const padding = {
          x: rect.left + scrollX + borderLeft,
          y: rect.top + scrollY + borderTop,
          width: rect.width - borderLeft - borderRight,
          height: rect.height - borderTop - borderBottom,
        };
        const border = {
          x: rect.left + scrollX,
          y: rect.top + scrollY,
          width: rect.width,
          height: rect.height,
        };
        const marginTop = parseFloat(style.marginTop);
        const marginRight = parseFloat(style.marginRight);
        const marginBottom = parseFloat(style.marginBottom);
        const marginLeft = parseFloat(style.marginLeft);
        const margin = {
          x: rect.left + scrollX - marginLeft,
          y: rect.top + scrollY - marginTop,
          width: rect.width + marginLeft + marginRight,
          height: rect.height + marginTop + marginBottom,
        };
        return { content, padding, border, margin };
      }, selector);
      if (!boxModel) throw new Error(`Element not found: ${selector}`);
      const toQuad = (box: { x: number; y: number; width: number; height: number }) => [
        box.x, box.y,
        box.x + box.width, box.y,
        box.x + box.width, box.y + box.height,
        box.x, box.y + box.height,
      ];
      return {
        model: {
          content: toQuad(boxModel.content),
          padding: toQuad(boxModel.padding),
          border: toQuad(boxModel.border),
          margin: toQuad(boxModel.margin),
          width: boxModel.border.width,
          height: boxModel.border.height,
        },
      };
    }
    case 'scrollIntoViewIfNeeded': {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }, selector);
      return {};
    }
    case 'removeNode': {
      const nodeId = params.nodeId as number;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, selector);
      session.nodeMap.delete(nodeId);
      return {};
    }
    case 'setNodeValue': {
      const nodeId = params.nodeId as number;
      const value = params.value as string;
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      await page.evaluate((sel: string, val: string) => {
        const el = document.querySelector(sel);
        if (el) el.textContent = val;
      }, selector, value);
      return {};
    }
    case 'setFileInputFiles': {
      const nodeId = params.nodeId as number;
      const files = params.files as string[];
      const selector = session.nodeMap.get(nodeId);
      if (!selector) throw new Error(`Node not found: ${nodeId}`);
      const element = await page.$(selector);
      if (element) {
        const inputElement = element as unknown as { uploadFile: (...paths: string[]) => Promise<void> };
        await inputElement.uploadFile(...files);
      }
      return {};
    }
    case 'enable':
    case 'disable':
      return {};
    default:
      throw new Error(`Unknown DOM method: ${command}`);
  }
}

async function handleInput(
  page: Page,
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case 'dispatchMouseEvent': {
      const type = params.type as string;
      const x = params.x as number;
      const y = params.y as number;
      const button = (params.button as string) || 'left';
      const clickCount = (params.clickCount as number) || 1;
      const mouse = page.mouse;
      switch (type) {
        case 'mousePressed':
          await mouse.down({ button: button as 'left' | 'right' | 'middle' });
          break;
        case 'mouseReleased':
          await mouse.up({ button: button as 'left' | 'right' | 'middle' });
          break;
        case 'mouseMoved':
          await mouse.move(x, y);
          break;
        case 'mouseWheel':
          await mouse.wheel({ deltaX: params.deltaX as number, deltaY: params.deltaY as number });
          break;
        default:
          await mouse.click(x, y, {
            button: button as 'left' | 'right' | 'middle',
            clickCount,
          });
      }
      return {};
    }
    case 'dispatchKeyEvent': {
      const type = params.type as string;
      const key = params.key as string;
      const text = params.text as string;
      const keyboard = page.keyboard;
      type KeyInput = Parameters<typeof keyboard.down>[0];
      switch (type) {
        case 'keyDown':
          await keyboard.down(key as KeyInput);
          break;
        case 'keyUp':
          await keyboard.up(key as KeyInput);
          break;
        case 'char':
          if (text) await keyboard.type(text);
          break;
        default:
          if (key) await keyboard.press(key as KeyInput);
      }
      return {};
    }
    case 'insertText': {
      const text = params.text as string;
      if (text) await page.keyboard.type(text);
      return {};
    }
    default:
      throw new Error(`Unknown Input method: ${command}`);
  }
}

async function handleNetwork(
  session: CDPSession,
  page: Page | undefined,
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case 'enable':
    case 'disable':
      return {};
    case 'setCacheDisabled':
      if (page) await page.setCacheEnabled(!(params.cacheDisabled as boolean));
      return {};
    case 'setExtraHTTPHeaders': {
      const headers = params.headers as Record<string, string>;
      session.extraHTTPHeaders.clear();
      for (const [name, value] of Object.entries(headers)) {
        session.extraHTTPHeaders.set(name, value);
      }
      if (page) await page.setExtraHTTPHeaders(headers);
      return {};
    }
    case 'setCookie': {
      if (!page) throw new Error('No page available');
      const cookie = {
        name: params.name as string,
        value: params.value as string,
        url: params.url as string | undefined,
        domain: params.domain as string | undefined,
        path: params.path as string | undefined,
        secure: params.secure as boolean | undefined,
        httpOnly: params.httpOnly as boolean | undefined,
        sameSite: params.sameSite as 'Strict' | 'Lax' | 'None' | undefined,
        expires: params.expires as number | undefined,
      };
      await page.setCookie(cookie);
      return { success: true };
    }
    case 'setCookies': {
      if (!page) throw new Error('No page available');
      const cookies = params.cookies as Array<{
        name: string;
        value: string;
        url?: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
        expires?: number;
      }>;
      await page.setCookie(...cookies);
      return {};
    }
    case 'getCookies': {
      if (!page) throw new Error('No page available');
      const urls = params.urls as string[] | undefined;
      const cookies = await page.cookies(...(urls || []));
      return {
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          size: c.name.length + c.value.length,
          httpOnly: c.httpOnly,
          secure: c.secure,
          session: c.session,
          sameSite: c.sameSite,
        })),
      };
    }
    case 'deleteCookies': {
      if (!page) throw new Error('No page available');
      const name = params.name as string;
      const url = params.url as string | undefined;
      const domain = params.domain as string | undefined;
      const path = params.path as string | undefined;
      await page.deleteCookie({ name, url, domain, path });
      return {};
    }
    case 'clearBrowserCookies': {
      if (!page) throw new Error('No page available');
      const cookies = await page.cookies();
      for (const cookie of cookies) {
        await page.deleteCookie(cookie);
      }
      return {};
    }
    case 'setUserAgentOverride': {
      if (!page) throw new Error('No page available');
      const userAgent = params.userAgent as string;
      await page.setUserAgent(userAgent);
      return {};
    }
    default:
      throw new Error(`Unknown Network method: ${command}`);
  }
}

async function handleEmulation(
  page: Page,
  command: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case 'setDeviceMetricsOverride': {
      const width = params.width as number;
      const height = params.height as number;
      const deviceScaleFactor = (params.deviceScaleFactor as number) || 1;
      const mobile = (params.mobile as boolean) || false;
      await page.setViewport({ width, height, deviceScaleFactor, isMobile: mobile });
      return {};
    }
    case 'setUserAgentOverride': {
      const userAgent = params.userAgent as string;
      await page.setUserAgent(userAgent);
      return {};
    }
    case 'clearDeviceMetricsOverride':
      await page.setViewport({ width: 1280, height: 720 });
      return {};
    case 'setGeolocationOverride': {
      const latitude = params.latitude as number | undefined;
      const longitude = params.longitude as number | undefined;
      const accuracy = params.accuracy as number | undefined;
      if (latitude !== undefined && longitude !== undefined) {
        await page.setGeolocation({ latitude, longitude, accuracy: accuracy ?? 100 });
      }
      return {};
    }
    case 'clearGeolocationOverride':
      return {};
    case 'setTimezoneOverride': {
      const timezoneId = params.timezoneId as string;
      await page.evaluateOnNewDocument((tz: string) => {
        const originalToLocaleString = Date.prototype.toLocaleString;
        Date.prototype.toString = function() {
          return originalToLocaleString.call(this, 'en-US', { timeZone: tz });
        };
        (globalThis as unknown as Record<string, string>).__timezone = tz;
      }, timezoneId);
      return {};
    }
    case 'setTouchEmulationEnabled': {
      const enabled = params.enabled as boolean;
      if (enabled) {
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 1 });
          window.ontouchstart = null;
        });
      }
      return {};
    }
    case 'setEmulatedMedia': {
      const media = params.media as string | undefined;
      const features = params.features as Array<{ name: string; value: string }> | undefined;
      if (media) await page.emulateMediaType(media as 'screen' | 'print');
      if (features) await page.emulateMediaFeatures(features.map(f => ({ name: f.name, value: f.value })));
      return {};
    }
    case 'setDefaultBackgroundColorOverride': {
      const color = params.color as { r: number; g: number; b: number; a?: number } | undefined;
      if (color) {
        const { r, g, b, a = 1 } = color;
        await page.evaluate((rgba: string) => {
          document.documentElement.style.backgroundColor = rgba;
        }, `rgba(${r}, ${g}, ${b}, ${a})`);
      }
      return {};
    }
    default:
      throw new Error(`Unknown Emulation method: ${command}`);
  }
}

async function handleFetch(
  session: CDPSession,
  page: Page,
  command: string,
  params: Record<string, unknown>,
  ws: WebSocket
): Promise<unknown> {
  switch (command) {
    case 'enable': {
      const patterns = params.patterns as Array<{ urlPattern?: string; requestStage?: string }> | undefined;
      session.requestInterceptionEnabled = true;
      await page.setRequestInterception(true);
      page.on('request', async (request) => {
        if (!session.requestInterceptionEnabled) {
          await request.continue();
          return;
        }
        const requestId = crypto.randomUUID();
        let shouldIntercept = !patterns || patterns.length === 0;
        if (patterns) {
          for (const pattern of patterns) {
            if (!pattern.urlPattern || request.url().match(pattern.urlPattern)) {
              shouldIntercept = true;
              break;
            }
          }
        }
        if (shouldIntercept) {
          session.pendingRequests.set(requestId, {
            request: request as unknown as Request,
            resolve: () => {},
          });
          sendEvent(ws, 'Fetch.requestPaused', {
            requestId,
            request: {
              url: request.url(),
              method: request.method(),
              headers: request.headers(),
              postData: request.postData(),
            },
            frameId: session.defaultTargetId,
            resourceType: request.resourceType(),
          });
        } else {
          await request.continue();
        }
      });
      return {};
    }
    case 'disable':
      session.requestInterceptionEnabled = false;
      await page.setRequestInterception(false);
      return {};
    case 'continueRequest': {
      const requestId = params.requestId as string;
      const url = params.url as string | undefined;
      const method = params.method as string | undefined;
      const postData = params.postData as string | undefined;
      const headers = params.headers as Array<{ name: string; value: string }> | undefined;
      const pending = session.pendingRequests.get(requestId);
      if (!pending) throw new Error(`Request not found: ${requestId}`);
      const request = pending.request as unknown as { continue: (opts?: Record<string, unknown>) => Promise<void> };
      const overrides: Record<string, unknown> = {};
      if (url) overrides.url = url;
      if (method) overrides.method = method;
      if (postData) overrides.postData = postData;
      if (headers) {
        overrides.headers = headers.reduce((acc, h) => {
          acc[h.name] = h.value;
          return acc;
        }, {} as Record<string, string>);
      }
      await request.continue(Object.keys(overrides).length > 0 ? overrides : undefined);
      session.pendingRequests.delete(requestId);
      return {};
    }
    case 'fulfillRequest': {
      const requestId = params.requestId as string;
      const responseCode = params.responseCode as number;
      const responseHeaders = params.responseHeaders as Array<{ name: string; value: string }> | undefined;
      const body = params.body as string | undefined;
      const pending = session.pendingRequests.get(requestId);
      if (!pending) throw new Error(`Request not found: ${requestId}`);
      const request = pending.request as unknown as { respond: (opts: Record<string, unknown>) => Promise<void> };
      const headers: Record<string, string> = {};
      if (responseHeaders) {
        for (const h of responseHeaders) {
          headers[h.name] = h.value;
        }
      }
      await request.respond({
        status: responseCode,
        headers,
        body: body ? Buffer.from(body, 'base64') : undefined,
      });
      session.pendingRequests.delete(requestId);
      return {};
    }
    case 'failRequest': {
      const requestId = params.requestId as string;
      const errorReason = params.errorReason as string;
      const pending = session.pendingRequests.get(requestId);
      if (!pending) throw new Error(`Request not found: ${requestId}`);
      const request = pending.request as unknown as { abort: (reason?: string) => Promise<void> };
      const abortReason = errorReason.toLowerCase().includes('access') ? 'accessdenied' :
                         errorReason.toLowerCase().includes('address') ? 'addressunreachable' :
                         errorReason.toLowerCase().includes('blocked') ? 'blockedbyclient' :
                         errorReason.toLowerCase().includes('connection') ? 'connectionfailed' :
                         errorReason.toLowerCase().includes('timeout') ? 'timedout' :
                         'failed';
      await request.abort(abortReason);
      session.pendingRequests.delete(requestId);
      return {};
    }
    case 'getResponseBody':
      return { body: '', base64Encoded: false };
    default:
      throw new Error(`Unknown Fetch method: ${command}`);
  }
}

async function handleCDPMethod(
  session: CDPSession,
  method: string,
  params: Record<string, unknown>,
  ws: WebSocket
): Promise<unknown> {
  const [domain, command] = method.split('.');
  const targetId = (params.targetId as string) || session.defaultTargetId;
  const page = session.pages.get(targetId);

  switch (domain) {
    case 'Browser':
      return handleBrowser(session, command);
    case 'Target':
      return handleTarget(session, command, params, ws);
    case 'Page':
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handlePage(session, page, command, params, ws);
    case 'Runtime':
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleRuntime(session, page, command, params);
    case 'DOM':
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleDOM(session, page, command, params);
    case 'Input':
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleInput(page, command, params);
    case 'Network':
      return handleNetwork(session, page, command, params);
    case 'Emulation':
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleEmulation(page, command, params);
    case 'Fetch':
      if (!page) throw new Error(`Target not found: ${targetId}`);
      return handleFetch(session, page, command, params, ws);
    default:
      throw new Error(`Unknown domain: ${domain}`);
  }
}

async function initCDPSession(ws: WebSocket, env: Env): Promise<void> {
  let session: CDPSession | null = null;

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    const targetId = crypto.randomUUID();

    session = {
      browser,
      pages: new Map([[targetId, page]]),
      defaultTargetId: targetId,
      nodeIdCounter: 1,
      nodeMap: new Map(),
      objectIdCounter: 1,
      objectMap: new Map(),
      scriptsToEvaluateOnNewDocument: new Map(),
      extraHTTPHeaders: new Map(),
      requestInterceptionEnabled: false,
      pendingRequests: new Map(),
    };

    sendEvent(ws, 'Target.targetCreated', {
      targetInfo: {
        targetId,
        type: 'page',
        title: '',
        url: 'about:blank',
        attached: true,
      },
    });

    console.log('[CDP] Session initialized, targetId:', targetId);
  } catch (err) {
    console.error('[CDP] Browser launch failed:', err);
    ws.close(1011, 'Browser launch failed');
    return;
  }

  ws.addEventListener('message', async (event) => {
    if (!session) return;

    let request: CDPRequest;
    try {
      request = JSON.parse(event.data as string);
    } catch {
      console.error('[CDP] Invalid JSON received');
      return;
    }

    console.log('[CDP] Request:', request.method, request.params);

    try {
      const result = await handleCDPMethod(session, request.method, request.params || {}, ws);
      sendResponse(ws, request.id, result);
    } catch (err) {
      console.error('[CDP] Method error:', request.method, err);
      sendError(ws, request.id, -32000, err instanceof Error ? err.message : 'Unknown error');
    }
  });

  ws.addEventListener('close', async () => {
    console.log('[CDP] WebSocket closed, cleaning up');
    if (session) {
      try {
        await session.browser.close();
      } catch (err) {
        console.error('[CDP] Error closing browser:', err);
      }
    }
  });

  ws.addEventListener('error', (event) => {
    console.error('[CDP] WebSocket error:', event);
  });
}

function handleWebSocketUpgrade(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('secret');

  if (!env.CDP_SECRET) {
    return new Response(JSON.stringify({
      error: 'CDP endpoint not configured',
      hint: 'Set CDP_SECRET via: wrangler secret put CDP_SECRET',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
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
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();

  initCDPSession(server, env).catch((err) => {
    console.error('[CDP] Failed to initialize session:', err);
    server.close(1011, 'Failed to initialize browser session');
  });

  return new Response(null, { status: 101, webSocket: client });
}

function handleJsonVersion(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('secret');

  if (!env.CDP_SECRET) {
    return new Response(JSON.stringify({
      error: 'CDP endpoint not configured',
      hint: 'Set CDP_SECRET via: wrangler secret put CDP_SECRET',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
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
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${url.host}?secret=${encodeURIComponent(providedSecret)}`;

  return new Response(JSON.stringify({
    'Browser': 'Cloudflare-Browser-Rendering/1.0',
    'Protocol-Version': '1.3',
    'User-Agent': 'Mozilla/5.0 Cloudflare Browser Rendering',
    'V8-Version': 'cloudflare',
    'WebKit-Version': 'cloudflare',
    'webSocketDebuggerUrl': wsUrl,
  }), { headers: { 'Content-Type': 'application/json' } });
}

function handleJsonList(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get('secret');

  if (!env.CDP_SECRET) {
    return new Response(JSON.stringify({
      error: 'CDP endpoint not configured',
      hint: 'Set CDP_SECRET via: wrangler secret put CDP_SECRET',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
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
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${url.host}?secret=${encodeURIComponent(providedSecret)}`;

  return new Response(JSON.stringify([
    {
      'description': '',
      'devtoolsFrontendUrl': '',
      'id': 'cloudflare-browser',
      'title': 'Cloudflare Browser Rendering',
      'type': 'page',
      'url': 'about:blank',
      'webSocketDebuggerUrl': wsUrl,
    },
  ]), { headers: { 'Content-Type': 'application/json' } });
}

function handleInfoEndpoint(authenticated: boolean): Response {
  if (!authenticated) {
    return new Response(JSON.stringify({
      error: 'WebSocket upgrade required',
      hint: 'Connect via WebSocket: ws://host?secret=<CDP_SECRET>',
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    error: 'WebSocket upgrade required',
    hint: 'Connect via WebSocket: ws://host?secret=<CDP_SECRET>',
    supported_methods: SUPPORTED_METHODS,
  }), { headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/json/version') {
      return handleJsonVersion(request, env);
    }

    if (path === '/json/list' || path === '/json') {
      return handleJsonList(request, env);
    }

    if (path === '/' || path === '') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        return handleWebSocketUpgrade(request, env);
      }
      // Only show supported_methods if authenticated
      const providedSecret = url.searchParams.get('secret');
      const authenticated = !!(env.CDP_SECRET && providedSecret && timingSafeEqual(providedSecret, env.CDP_SECRET));
      return handleInfoEndpoint(authenticated);
    }

    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
