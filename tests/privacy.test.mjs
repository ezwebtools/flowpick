import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function privacy() {
  const env = { exports: {}, URL, setTimeout, clearTimeout }
  vm.runInNewContext(compile(read('utils/privacy.ts')), env)
  return env.exports
}
const p = privacy()
const root = 'chrome-extension://test/'
const extensionSender = { id: 'test', url: root + 'popup.html' }
test('unrelated requests and excluded sites never cache request credentials', () => {
  for (const type of ['xmlhttprequest', 'main_frame', 'sub_frame', 'image', 'other']) {
    assert.equal(p.mayCaptureRequestHeaders(type, false, false), false, type)
    assert.equal(p.mayCaptureRequestHeaders(type, true, false), true, type)
    assert.equal(p.mayCaptureRequestHeaders(type, true, true), false, type)
  }
  assert.equal(p.mayCaptureRequestHeaders('media', false, false), true)
  assert.equal(p.mayCaptureRequestHeaders('media', true, true), false)
})

function backend() {
  const source = read('entrypoints/background.ts')
  const ast = ts.createSourceFile('background.ts', source, ts.ScriptTarget.Latest, true)
  let handler
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleMessage') handler = node.getText(ast)
    else ts.forEachChild(node, visit)
  }
  visit(ast)
  const tabs = new Map(), opened = [], queues = []
  let next = 10
  const env = {
    ...p, URL, structuredClone, SITE_ORIGIN: 'https://flowpick.net',
    allowsSiteRuntimeMessage: () => true,
    recordingStore: { ready: Promise.resolve(), save: async () => {} },
    recordingSessionsByTarget: new Map(), recordingTargetBySource: new Map(),
    navigator: { userAgent: 'Edge' }, isFirefoxFamily: () => false,
    crypto: { randomUUID: () => 'test-recording-session' },
    pendingDownloads: new Map(), tabMap: new Map(), getFormatGroup: () => 'video',
    openDownloadQueue: async (items, windowId) => { queues.push({ items, windowId }); return { ok: true } },
    browser: {
      runtime: { id: 'test', getURL: path => root + path.replace(/^\//, '') },
      i18n: { getUILanguage: () => 'en' },
      tabs: {
        create: async options => { const tab = { ...options, id: next++ }; tabs.set(tab.id, tab); opened.push(tab.url); return tab },
        update: async (id, options) => { Object.assign(tabs.get(id), options); if (options.url) opened.push(options.url); return tabs.get(id) },
        query: async () => [{ id: 5, windowId: 1, url: 'https://source.example/watch', title: 'Source' }],
        get: async id => id === 5 ? { id, windowId: 1, url: 'https://source.example/watch' } : tabs.get(id),
        remove: async id => tabs.delete(id),
      },
    },
  }
  vm.runInNewContext(compile(handler.replaceAll('import.meta.env.FIREFOX', 'false')), env)
  const send = (msg, sender = extensionSender) => new Promise((resolve, reject) => env.handleMessage(msg, sender, resolve).catch(reject))
  return { env, send, opened, queues }
}

test('downloads open directly on repeated actions and keep credentials out of page URLs', async () => {
  const b = backend()
  for (let i = 0; i < 2; i++) {
    const result = await b.send({ type: 'OPEN_DOWNLOAD_PAGE', url: 'https://cdn.example/file.mp4?token=secret',
      format: 'mp4', filename: 'file.mp4', requestHeaders: { Cookie: 'secret-cookie' } })
    assert.equal(result.ok, true)
    assert.equal(result.pendingConsent, undefined)
  }
  assert.equal(b.opened.length, 2)
  assert.ok(b.opened.every(url => url === 'https://flowpick.net/video-downloader'))
  assert.equal(b.env.pendingDownloads.size, 2)
  const task = [...b.env.pendingDownloads.values()][0]
  assert.equal(task.sourceUrl, 'https://source.example/watch')
  assert.equal(task.requestHeaders.Cookie, 'secret-cookie')
})

test('batch downloads pass selected tasks directly to the existing queue', async () => {
  const b = backend()
  const result = await b.send({ type: 'OPEN_DOWNLOAD_QUEUE', sourceTabId: 5,
    items: [{ url: 'https://cdn.example/a.mp4', format: 'mp4', requestHeaders: { Authorization: 'test' } }] })
  assert.equal(result.ok, true)
  assert.equal(b.opened.length, 0)
  assert.equal(b.queues.length, 1)
  assert.equal(b.queues[0].items[0].requestHeaders.Authorization, 'test')
  assert.equal(b.queues[0].items[0].sourceUrl, 'https://source.example/watch')
})

test('both quality downloads deliver the same separate audio to their own downloader pages', async () => {
  const b = backend()
  const audioUrl = 'https://scontent.cdninstagram.com/common-audio.mp4'
  for (const quality of ['720p', '360p']) {
    const url = `https://scontent.cdninstagram.com/${quality}.mp4`
    await b.send({ type: 'OPEN_DOWNLOAD_PAGE', url, format: 'mp4', filename: quality, audioUrl })
    const [tabId] = [...b.env.pendingDownloads.keys()]
    const payload = await b.send({ type: 'FLOWPICK_DOWNLOAD_READY' }, { id: 'test', url: 'https://flowpick.net/video-downloader', tab: { id: tabId } })
    assert.equal(payload.url, url)
    assert.equal(payload.audioUrl, audioUrl)
    assert.equal((await b.send({ type: 'FLOWPICK_DOWNLOAD_READY' }, { tab: { id: tabId } })).ok, false)
  }
})

test('recording opens its actual recording page without a privacy interstitial', async () => {
  const b = backend()
  const result = await b.send({ type: 'OPEN_RECORDING_PAGE', sourceTabId: 5, mode: 'mse' })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'test-recording-session')
  assert.equal(b.opened.at(-1), 'https://flowpick.net/recording?session=test-recording-session')
  assert.equal(b.env.recordingSessionsByTarget.get(result.targetTabId).sourceTabId, 5)
})

test('live resources route directly to the hosted downloader inside the worker', async () => {
  const b = backend()
  const result = await b.send({ type: 'OPEN_RESOURCE_DOWNLOAD', resourceKind: 'live', sourceTabId: 5,
    url: 'https://cdn.example/live.flv', format: 'flv', filename: 'live.flv', requestHeaders: { Cookie: 'live' } })
  assert.equal(result.ok, true)
  assert.deepEqual(b.opened, ['https://flowpick.net/video-downloader'])
  assert.equal([...b.env.pendingDownloads.values()][0].requestHeaders.Cookie, 'live')
})

test('privacy strings cover every selectable locale and agree with welcome-page resources', () => {
  const copy = JSON.parse(read('utils/privacy-copy.json'))
  const locales = [...read('utils/i18n.ts').matchAll(/\{ code: '([^']+)'/g)].map(m => m[1]).filter(x => x !== 'system')
  const keys = ['privacyTitle', 'privacySummary', 'privacyWebsite', 'privacyRecording', 'privacyWebsiteBoundary', 'privacyControls', 'privacyPolicy']
  assert.equal(locales.length, 23)
  for (const locale of locales) {
    assert.equal(copy[locale].length, keys.length, locale)
    const messages = JSON.parse(read(`public/_locales/${locale}/messages.json`))
    keys.forEach((key, i) => assert.equal(messages[key].message, copy[locale][i], `${locale}/${key}`))
    assert.ok(messages.extDescription.message.length <= 132)
  }
})
