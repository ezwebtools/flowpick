import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'
import { reactive } from 'vue'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const mediaMessage = { exports: {} }
vm.runInNewContext(compile(read('utils/media-message.ts')), mediaMessage)
const root = 'chrome-extension://test/'
const sender = { id: 'test', url: root + 'sidepanel.html' }
function setup() {
  let storage = {}, nextId = 10
  const tabs = new Map([[1, { id: 1, url: 'https://source.example/watch' }]])
  const opened = [], focused = []
  const api = {
    runtime: { id: 'test', getURL: path => root + path.replace(/^\//, '') },
    storage: { local: {
      get: async () => structuredClone(storage),
      set: async value => { storage = { ...storage, ...structuredClone(value) } },
    } },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id) },
      create: async options => { const tab = { id: nextId++, windowId: 2, ...options }; tabs.set(tab.id, tab); opened.push(tab); return tab },
      update: async id => { focused.push(id); return tabs.get(id) },
    },
    windows: { update: async () => {} },
  }
  const context = { exports: {}, crypto: webcrypto }
  vm.runInNewContext(compile(read('utils/media-player-tabs.ts')), context)
  const make = () => context.exports.createMediaPlayerTabs(api)
  return { make, tabs, opened, focused, api }
}
const request = () => ({ sourceTabId: 1, title: 'Example video', item: {
  url: 'https://cdn.example/video.m3u8', format: 'm3u8', requestHeaders: { Authorization: 'secret' },
} })
const sessionSender = tab => ({ id: 'test', url: tab.url, frameId: 0, tab: { id: tab.id } })
const sessionId = tab => new URL(tab.url).searchParams.get('session')

test('parallel opens and worker restarts focus the same player tab without credentials in its URL', async () => {
  const env = setup(), manager = env.make()
  const results = await Promise.all([manager.open(request(), sender), manager.open(request(), sender)])
  assert.equal(results[0].tabId, results[1].tabId)
  assert.equal(env.opened.length, 1)
  assert.ok(!env.opened[0].url.includes('secret'))
  assert.ok(!env.opened[0].url.includes('cdn.example'))
  await env.make().open(request(), sender)
  assert.equal(env.opened.length, 1)
  assert.equal(env.focused.length, 2)
})

test('only the owning extension player tab can read credentials, including after refresh', async () => {
  const env = setup(), manager = env.make()
  await manager.open(request(), sender)
  const tab = env.opened[0], id = sessionId(tab)
  const { session } = await env.make().get(id, sessionSender(tab))
  assert.equal(session.referrer, 'https://source.example/watch')
  assert.equal(session.item.requestHeaders.Authorization, 'secret')
  for (const invalid of [sender, { ...sessionSender(tab), tab: { id: 999 } },
    { ...sessionSender(tab), frameId: 1 }, { ...sessionSender(tab), id: 'other' },
    { ...sessionSender(tab), url: 'https://hostile.example/' }]) {
    await assert.rejects(manager.get(id, invalid), /unavailable/)
  }
  await assert.rejects(manager.open(request(), { ...sender, url: 'https://hostile.example/' }), /untrusted/)
})

test('closing or navigating a player tab discards its session and allows a fresh open', async () => {
  const env = setup(), manager = env.make()
  await manager.open(request(), sender)
  const first = env.opened[0], id = sessionId(first)
  await manager.remove(first.id)
  await assert.rejects(manager.get(id, sessionSender(first)), /unavailable/)
  await manager.open(request(), sender)
  env.tabs.set(env.opened[1].id, { ...env.opened[1], url: 'https://example.com' })
  await manager.open(request(), sender)
  assert.equal(env.opened.length, 3)
})

test('playback setting defaults off for new, legacy and malformed settings and survives save/reset', async () => {
  let data = {}
  const env = { exports: {}, browser: { storage: { local: {
    get: async () => structuredClone(data), set: async value => { data = structuredClone(value) },
  } } } }
  vm.runInNewContext(compile(read('utils/settings.ts')), env)
  const settings = env.exports
  for (const value of [undefined, {}, { openPlaybackInNewTab: 'true' }]) {
    data = { ext_settings: value }
    assert.equal((await settings.loadSettings()).openPlaybackInNewTab, false)
  }
  const enabled = { ...settings.createDefaultSettings(), openPlaybackInNewTab: true }
  await settings.saveSettings(enabled)
  assert.equal((await settings.loadSettings()).openPlaybackInNewTab, true)
  assert.equal(settings.cloneSettings(enabled).openPlaybackInNewTab, true)
  await settings.saveSettings(settings.createDefaultSettings())
  assert.equal((await settings.loadSettings()).openPlaybackInNewTab, false)
})

test('play clicks keep inline playback by default, stop inline players before tab opens and keep images inline', async () => {
  const source = read('entrypoints/popup/App.vue')
  const script = source.slice(source.indexOf('<script lang="ts" setup>') + 24, source.indexOf('</script>'))
  const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true)
  let declaration
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'playUrl') declaration = node.getText(ast)
    else ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(declaration)
  const actions = []
  const env = { exports: {}, settingsLoaded: true, settings: { value: { openPlaybackInNewTab: false } },
    cloneMediaItem: mediaMessage.exports.cloneMediaItem,
    playingKey: { value: null }, audioPlayingKey: { value: null }, currentTabId: 1,
    isStreamFormat: f => f === 'm3u8', isVideoFormat: f => f === 'mp4', isAudioFormat: f => f === 'mp3', isImageFormat: f => f === 'png',
    getMediaKey: item => item.url, getDisplayName: () => 'Video',
    stopPlayback: () => actions.push('stop-video'), stopAudioPlayback: () => actions.push('stop-audio'),
    previewImage: () => actions.push('image'), showToastMsg: msg => actions.push(msg), t: key => key,
    browser: { runtime: { sendMessage: async message => { structuredClone(message); actions.push(message.type); return { ok: true } } } },
  }
  vm.runInNewContext(compile(`const ${declaration}; exports.playUrl = playUrl`), env)
  const item = reactive({ url: 'https://example/video', format: 'mp4', requestHeaders: { Authorization: 'secret' },
    audioOptions: [{ url: 'https://example/audio', label: 'Audio' }] })
  await env.exports.playUrl(item.url, item.format, item)
  assert.equal(env.playingKey.value, 'https://example/video')
  assert.deepEqual(actions, [])
  env.audioPlayingKey.value = 'other-audio'
  env.settings.value.openPlaybackInNewTab = true
  await env.exports.playUrl(item.url, item.format, item)
  assert.deepEqual(actions, ['stop-video', 'stop-audio', 'OPEN_MEDIA_PLAYER'])
  actions.length = 0
  await env.exports.playUrl('https://example/image', 'png')
  assert.deepEqual(actions, ['image'])
})

test('player downloads send plain headers and audio choices even from a reactive session', async () => {
  const source = read('entrypoints/player/App.vue').split('</script>')[0].replace('<script setup lang="ts">', '')
  const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
  const download = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'download')
  assert.ok(download)
  const sent = []
  const env = {
    exports: {}, cloneMediaItem: mediaMessage.exports.cloneMediaItem,
    session: { value: reactive({ title: 'Video', referrer: 'https://source.example/', item: {
      ...request().item, audioOptions: [{ url: 'https://cdn.example/audio', label: 'Audio' }],
    } }) },
    status: { value: '' }, t: key => key,
    browser: { runtime: { sendMessage: async message => { sent.push(structuredClone(message)); return { ok: true } } } },
  }
  vm.runInNewContext(compile(`${download.getText(ast)}; exports.download = download`), env)
  await env.exports.download()
  assert.equal(env.status.value, '')
  assert.equal(sent[0].requestHeaders.Authorization, 'secret')
  assert.equal(sent[0].requestHeaders.Referer, 'https://source.example/')
  assert.equal(sent[0].audioOptions[0].url, 'https://cdn.example/audio')
  assert.equal(sent[0].audioUrl, 'https://cdn.example/audio')
})
