import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { randomUUID } from 'node:crypto'

function setup() {
  let next = 1
  const tabs = new Map(), stored = {}, changes = []
  const browser = {
    storage: { session: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, value) } },
    i18n: { getUILanguage: () => 'zh-CN' },
    tabs: {
      create: async options => { const tab = { ...options, id: next++ }; tabs.set(tab.id, tab); return tab },
      get: async id => { if (!tabs.has(id)) throw Error('closed'); return tabs.get(id) },
      update: async (id, value) => Object.assign(tabs.get(id), value),
      sendMessage: async (id, value) => { changes.push({ id, value }) },
    },
  }
  const source = fs.readFileSync(new URL('../utils/download-queue.ts', import.meta.url), 'utf8').replace("import { SITE_ORIGIN } from './site'", "const SITE_ORIGIN = 'https://flowpick.net'")
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const context = { exports: {}, browser, URL, crypto: { randomUUID }, Date, Promise }
  vm.runInNewContext(code, context)
  return { ...context.exports, tabs, stored, changes }
}
const item = { url: 'https://media.example/video.mp4', format: 'mp4', filename: 'video', sourceUrl: 'https://source.example/', requestHeaders: { Authorization: 'test-only' }, audioUrl: 'https://media.example/audio.m4a' }

test('simultaneous multi-select submissions reuse one queue tab and deduplicate tasks', async () => {
  const store = setup()
  await Promise.all([store.openDownloadQueue([item], 10), store.openDownloadQueue([item, { ...item, url: 'https://media.example/second.mp4' }], 10)])
  assert.equal(store.tabs.size, 1)
  const [tab] = store.tabs.values()
  assert.equal(tab.url, 'https://flowpick.net/zh-Hans/download-queue')
  assert.equal(tab.url.includes('Authorization'), false)
  const result = await store.readDownloadQueue(tab.id, tab.url)
  assert.equal(result.tasks.length, 2)
  assert.equal(result.tasks[0].audioUrl, item.audioUrl)
  assert.equal(result.tasks[0].requestHeaders.Authorization, 'test-only')
})
test('task credentials are returned only to the exact trusted queue tab', async () => {
  const store = setup()
  const { tabId } = await store.openDownloadQueue([item], 1)
  for (const url of ['https://other.example/download-queue', 'https://flowpick.net/video-downloader', 'https://flowpick.net/download-queue-evil']) {
    assert.equal((await store.readDownloadQueue(tabId, url)).ok, false)
  }
  assert.equal((await store.readDownloadQueue(12345, 'https://flowpick.net/download-queue')).ok, false)
})
test('closing a queue removes credentials and a later submission creates a new queue', async () => {
  const store = setup()
  const first = await store.openDownloadQueue([item], 1)
  await store.removeDownloadQueue(first.tabId)
  assert.equal((await store.readDownloadQueue(first.tabId, store.tabs.get(first.tabId).url)).ok, false)
  store.tabs.delete(first.tabId)
  const second = await store.openDownloadQueue([item], 1)
  assert.notEqual(first.tabId, second.tabId)
})
