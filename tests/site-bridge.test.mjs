import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const bridgeSource = read('utils/site-bridge.ts')
function policy(origin = 'https://flowpick.net') {
  const context = { exports: {}, URL }
  vm.runInNewContext(compile(bridgeSource.replace("import { SITE_ORIGIN } from './site'", `const SITE_ORIGIN = ${JSON.stringify(origin)}`)), context)
  return context.exports
}
const extensionId = 'test-extension'
const extensionUrl = `chrome-extension://${extensionId}/`
const siteSender = (url = 'https://flowpick.net/zh-Hans/m3u8-downloader', id = 1) => ({
  id: extensionId, url, origin: new URL(url).origin, frameId: 0, tab: { id }, documentId: `doc-${id}`,
})
const extensionSender = { id: extensionId, url: `${extensionUrl}popup.html` }

function find(source, predicate) {
  const ast = ts.createSourceFile('entrypoint.ts', source, ts.ScriptTarget.Latest, true)
  let result
  function visit(node) {
    if (predicate(node)) result = node.getText(ast)
    else ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(result)
  return result
}
const backgroundHandler = compile(find(read('entrypoints/background.ts'), node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'handleMessage').replaceAll('import.meta.env.FIREFOX', 'false'))
const listener = type => compile(find(read('entrypoints/content.ts'), node =>
  ts.isCallExpression(node) && node.expression.getText() === 'window.addEventListener'
    && node.arguments[1]?.getText().includes(`event.data?.type === '${type}'`)))

test('site messages require the exact configured origin and top frame; dev has a separate origin', () => {
  const p = policy()
  for (const type of ['FLOWPICK_PROXY_FETCH', 'FLOWPICK_FETCH', 'FLOWPICK_FETCH_CANCEL', 'FLOWPICK_PROXY_FETCH_CANCEL', 'EXT_DOWNLOAD_REQUEST', 'FLOWPICK_REQUEST_DOWNLOAD', 'FLOWPICK_NOTIFY', 'FLOWPICK_RECORDING_READY']) {
    assert.equal(p.allowsSitePageMessage(type, 'https://flowpick.net/ja/recording', true, 'https://flowpick.net'), true)
    for (const url of ['https://evil.example/', 'https://flowpick.net.evil.example/', 'https://flowpick.net@evil.example/', 'http://flowpick.net/', 'http://localhost:3001/', 'https://flowpick.net:444/']) {
      assert.equal(p.allowsSitePageMessage(type, url, true, new URL(url).origin), false, `${type}: ${url}`)
    }
    assert.equal(p.allowsSitePageMessage(type, 'https://flowpick.net/', false, 'https://flowpick.net'), false)
  }
  const dev = policy('http://localhost:3001')
  assert.equal(dev.allowsSitePageMessage('FLOWPICK_PROXY_FETCH', 'http://localhost:3001/en/video-downloader', true, 'http://localhost:3001'), true)
  assert.equal(dev.allowsSitePageMessage('FLOWPICK_PROXY_FETCH', 'https://flowpick.net/', true, 'https://flowpick.net'), false)
})

test('backend uses sender frame identity, preserves extension UIs and rejects spoofed/opaque senders', () => {
  const p = policy()
  for (const type of ['PROXY_FETCH', 'PROXY_FETCH_CANCEL', 'PREPARE_MEDIA_PLAYBACK', 'FLOWPICK_DOWNLOAD_READY', 'FLOWPICK_RECORDING_PAGE_READY']) {
    assert.equal(p.allowsSiteRuntimeMessage(type, siteSender(), extensionId, extensionUrl), true)
    assert.equal(p.allowsSiteRuntimeMessage(type, extensionSender, extensionId, extensionUrl), true)
    for (const sender of [
      siteSender('https://evil.example/'),
      { ...siteSender(), frameId: 2 },
      { ...siteSender(), url: 'https://evil.example/', tab: { id: 1, url: 'https://flowpick.net/' } },
      { ...siteSender(), origin: 'null' },
      { ...siteSender(), id: 'another-extension' },
      { id: extensionId, tab: { id: 1, url: 'https://flowpick.net/' } },
    ]) assert.equal(p.allowsSiteRuntimeMessage(type, sender, extensionId, extensionUrl), false)
  }
  const firefoxUrl = 'moz-extension://installation-uuid/'
  assert.equal(p.allowsSiteRuntimeMessage('PROXY_FETCH', { id: extensionId, url: `${firefoxUrl}sidepanel.html` }, extensionId, firefoxUrl), true)
})

test('source detection, recording hooks and source playback events still work in third-party frames', () => {
  const p = policy()
  for (const type of ['M3U8_DETECTED', 'PLATFORM_MEDIA_DETECTED', 'BILIBILI_DASH_DETECTED', 'FLOWPICK_INJECTED_READY', 'FLOWPICK_MSE_RECORDING_EVENT', 'FLOWPICK_MSE_RECORDING_FLUSH', 'FLOWPICK_REQUEST_SETTINGS']) {
    assert.equal(p.allowsSitePageMessage(type, 'https://player.example/', false), true, type)
  }
  for (const type of ['FLOWPICK_RECORDING_SOURCE_READY', 'FLOWPICK_RECORDING_STREAM_DATA', 'FLOWPICK_RECORDING_PLAYBACK_STATE', 'FLOWPICK_RECORDING_CAPTURE_REGION', 'FLOWPICK_RECORDING_HOOK_STATE', 'SAVE_PAGE_BLOB']) {
    assert.equal(p.allowsSiteRuntimeMessage(type, siteSender('https://player.example/'), extensionId, extensionUrl), true, type)
  }
})

function contentEnvironment(url, topFrame = true, type = 'FLOWPICK_PROXY_FETCH') {
  const forwarded = [], responses = []
  const window = {
    addEventListener: (_type, handler) => { window.handler = handler },
    postMessage: (...args) => responses.push(args),
  }
  window.top = topFrame ? window : {}
  const environment = {
    ...policy(), window, location: { href: url, origin: new URL(url).origin },
    isRecordingBridgeMessage: event => event.source === window,
    pageIdentity: value => value, TextDecoder, Uint8Array,
    b64ToArrayBuffer: value => Uint8Array.from(Buffer.from(value, 'base64')).buffer,
    browser: { runtime: { sendMessage: async msg => {
      forwarded.push(msg)
      return { ok: true, data: Buffer.from('media-test').toString('base64'), status: 200 }
    } } },
  }
  vm.runInNewContext(listener(type), environment)
  return { window, forwarded, responses }
}

test('actual content proxy listener rejects arbitrary pages and iframes before forwarding', async () => {
  for (const [url, topFrame] of [['https://evil.example/', true], ['https://flowpick.net/', false]]) {
    const env = contentEnvironment(url, topFrame)
    for (const type of ['FLOWPICK_PROXY_FETCH', 'FLOWPICK_FETCH', 'FLOWPICK_PROXY_FETCH_CANCEL', 'FLOWPICK_NOTIFY']) {
      await env.window.handler({ source: env.window, origin: 'https://flowpick.net', data: { type, url: 'https://media.example/', requestId: 'test', title: 'test' } })
    }
    assert.equal(env.forwarded.length, 0)
    assert.equal(env.responses.length, 0)
  }
})

test('actual content proxy listener retains URL, Range, referrer, authentication and text response', async () => {
  const env = contentEnvironment('https://flowpick.net/zh-Hans/m3u8-downloader')
  const options = { headers: { Range: 'bytes=0-100' }, referrer: 'https://source.example/', authHeaders: { Authorization: 'test' } }
  await env.window.handler({ source: env.window, origin: 'https://flowpick.net', data: { type: 'FLOWPICK_PROXY_FETCH', requestId: 'r1', url: 'https://cdn.example/segment', options, responseType: 'text' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(env.forwarded[0].options, options)
  assert.equal(env.responses[0][0].text, 'media-test')
  assert.equal(env.responses[0][1], 'https://flowpick.net')
})

test('a same-window message with a foreign or opaque origin cannot call the site bridge', async () => {
  const env = contentEnvironment('https://flowpick.net/m3u8-downloader')
  for (const origin of ['https://evil.example', 'null']) {
    await env.window.handler({ source: env.window, origin, data: { type: 'FLOWPICK_PROXY_FETCH', url: 'https://cdn.example/' } })
  }
  assert.equal(env.forwarded.length, 0)
})

test('actual download handshake listener blocks unauthorized pages without consuming a task', async () => {
  for (const [url, topFrame] of [['https://evil.example/', true], ['https://flowpick.net/', false]]) {
    const env = contentEnvironment(url, topFrame, 'FLOWPICK_REQUEST_DOWNLOAD')
    await env.window.handler({ source: env.window, origin: 'https://flowpick.net', data: { type: 'FLOWPICK_REQUEST_DOWNLOAD' } })
    assert.equal(env.forwarded.length, 0)
  }
})

function backgroundEnvironment() {
  const requests = [], rules = [], tabMessages = [], pendingProxyFetches = new Map()
  const env = {
    ...policy(), URL, AbortController, Uint8Array, Map, Set, TextEncoder,
    pendingProxyFetches, CACHE_HEADER_NAMES: new Set(),
    pendingDownloads: new Map([[1, { url: 'https://cdn.example/video.mp4', requestHeaders: { Cookie: 'test' } }]]),
    recordingStore: { ready: Promise.resolve(), save: async () => {} },
    recordingSessionsByTarget: new Map(),
    browser: {
      runtime: { id: extensionId, getURL: () => extensionUrl },
      tabs: { sendMessage: async (...args) => { tabMessages.push(args); return { ok: true } } },
    },
    proxyContexts: { acquire: async () => () => {} },
    ensureProxyHeaderRule: async (...args) => rules.push(args),
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode('media').buffer }
    },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
  }
  vm.runInNewContext(backgroundHandler, env)
  const send = (msg, sender) => new Promise((resolve, reject) => env.handleMessage(msg, sender, resolve).catch(reject))
  return { env, send, requests, rules, pendingProxyFetches, tabMessages }
}

test('existing MSE/MSR recording page handshakes and MSR source controls survive the sender checks', async () => {
  for (const mode of ['mse', 'msr']) {
    const { env, send, tabMessages } = backgroundEnvironment()
    env.recordingSessionsByTarget.set(1, { id: 'recording-1', mode, sourceTabId: 9, sourcePrepared: true })
    const sender = siteSender('https://flowpick.net/zh-Hans/recording?session=recording-1')
    const result = await send({ type: 'FLOWPICK_RECORDING_PAGE_READY', sessionId: 'recording-1' }, sender)
    assert.equal(result.ok, true)
    assert.equal(result.mode, mode)
    if (mode === 'msr') {
      assert.equal(tabMessages[0][0], 9)
      assert.equal(tabMessages[0][1].type, 'FLOWPICK_MSR_REGION_TRACKING_START')
      const control = await send({ type: 'FLOWPICK_RECORDING_PAGE_COMMAND', sessionId: 'recording-1', command: 'msr-state', state: 'recording' }, sender)
      assert.equal(control.ok, true)
      assert.equal(tabMessages[1][1].type, 'FLOWPICK_MSR_CONTROL_STATE')
    }
  }
})

test('actual backend rejects direct untrusted proxy and header preparation before network or DNR changes', async () => {
  const { send, requests, rules } = backgroundEnvironment()
  for (const type of ['PROXY_FETCH', 'PREPARE_MEDIA_PLAYBACK']) {
    const result = await send({ type, url: 'https://cdn.example/' }, siteSender('https://evil.example/'))
    assert.equal(result.error, 'untrusted-site-bridge-sender')
  }
  assert.equal(requests.length, 0)
  assert.equal(rules.length, 0)
})

test('actual backend preserves site/extension proxy downloads and captured request headers', async () => {
  const { send, requests, rules } = backgroundEnvironment()
  for (const sender of [siteSender(), extensionSender]) {
    const result = await send({ type: 'PROXY_FETCH', requestId: 'r1', url: 'https://cdn.example/segment', options: {
      referrer: 'https://source.example/', headers: { Range: 'bytes=1-4' }, authHeaders: { Cookie: 'test-cookie', Authorization: 'test-auth' },
    } }, sender)
    assert.equal(result.ok, true)
    assert.equal(Buffer.from(result.data, 'base64').toString(), 'media')
  }
  assert.equal(requests.length, 2)
  assert.equal(requests[0].options.headers.Range, 'bytes=1-4')
  assert.equal(requests[0].options.headers.Authorization, 'test-auth')
  assert.equal(rules[0][2].Cookie, 'test-cookie')
})

test('actual download handshake retains the existing one-time task and credential handoff', async () => {
  const { env, send } = backgroundEnvironment()
  assert.equal((await send({ type: 'FLOWPICK_DOWNLOAD_READY' }, siteSender('https://evil.example/'))).ok, false)
  assert.equal(env.pendingDownloads.size, 1)
  const result = await send({ type: 'FLOWPICK_DOWNLOAD_READY' }, siteSender())
  assert.equal(result.url, 'https://cdn.example/video.mp4')
  assert.equal(result.requestHeaders.Cookie, 'test')
  assert.equal(env.pendingDownloads.size, 0)
})

test('proxy cancellation cannot abort a different tab or document with the same request ID', async () => {
  const { env, send, pendingProxyFetches } = backgroundEnvironment()
  const owner = siteSender(), otherTab = siteSender(undefined, 2)
  const controller = new AbortController()
  pendingProxyFetches.set(env.proxyRequestKey(owner, 'same-id'), { controller, tabId: 1 })
  await send({ type: 'PROXY_FETCH_CANCEL', requestId: 'same-id' }, otherTab)
  await send({ type: 'PROXY_FETCH_CANCEL', requestId: 'same-id' }, { ...owner, documentId: 'new-document' })
  assert.equal(controller.signal.aborted, false)
  await send({ type: 'PROXY_FETCH_CANCEL', requestId: 'same-id' }, owner)
  assert.equal(controller.signal.aborted, true)
})

test('backend rejects non-HTTP proxy targets before issuing a request', async () => {
  const { send, requests } = backgroundEnvironment()
  for (const url of ['file:///private', 'data:text/plain,example', 'invalid']) {
    assert.equal((await send({ type: 'PROXY_FETCH', url }, siteSender())).error, 'unsupported-proxy-url')
  }
  assert.equal(requests.length, 0)
})
