import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { reactive } from 'vue'
import { DOMParser } from '@xmldom/xmldom'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const load = (path, extra = {}) => {
  const env = { exports: {}, URL, ...extra }
  vm.runInNewContext(compile(read(path)), env)
  return env.exports
}
const normalization = load('utils/instagram-media.ts')
const parser = load('utils/instagram-player.ts', { DOMParser, require: () => normalization })
const { cloneMediaItem } = load('utils/media-message.ts')
const { syncSeparatedAudio } = load('utils/separated-audio.ts')
const page = 'https://www.instagram.com/reels/Example-/'
const task = parser.extractInstagramMediaTasks(JSON.parse(read('tests/fixtures/instagram-hydration.json')), page)[0]
const audioUrl = task.candidates.find(candidate => candidate.role === 'audio').url
const items = task.candidates.filter(candidate => candidate.role === 'video').map(candidate => ({
  ...candidate, audioUrl, audioOptions: [{ url: audioUrl, label: 'Audio' }], requestHeaders: { Referer: page },
}))
const source = read('entrypoints/popup/App.vue').split('</script>')[0].replace('<script lang="ts" setup>', '')
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const declarations = new Map()
const visit = node => {
  if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), 'const ' + node.getText(ast))
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)

test('both quality buttons and batch queue carry the same audio through Firefox-cloneable messages', async () => {
  const sent = [], selected = items.map(item => reactive(cloneMediaItem(item)))
  // Also exercise the audioOptions fallback used by restored/legacy entries.
  selected[1].audioUrl = undefined
  const env = { cloneMediaItem, currentTabId: 1,
    getDownloadName: () => 'Reel', batchSubmitting: { value: false }, selectedDownloadItems: { value: selected },
    selectedKeys: { value: new Set() }, currentTabTitle: { value: 'Reel' },
    isStreamFormat: () => false, isVideoDownloadFormat: () => true, isAudioFormat: () => false,
    sanitizeDirectoryName: name => name, t: key => key, showToastMsg() {},
    browser: { runtime: { sendMessage: async message => { sent.push(structuredClone(message)); return { ok: true } } } },
  }
  vm.runInNewContext(compile(['getRecommendedAudioUrl', 'downloadStreamVariant', 'batchDownload'].map(name => declarations.get(name)).join('\n')
    + '\nthis.download = downloadStreamVariant; this.batch = batchDownload;'), env)
  for (const item of selected) env.download({ item })
  await env.batch()
  assert.deepEqual(sent.slice(0, 2).map(message => message.audioUrl), [audioUrl, audioUrl])
  assert.deepEqual(sent.slice(0, 2).map(message => message.url), Array.from(items, item => item.url))
  const queue = sent[2]
  assert.equal(queue.type, 'OPEN_DOWNLOAD_QUEUE')
  assert.deepEqual(queue.items.map(item => item.audioUrl), [audioUrl, audioUrl])
  assert.deepEqual(queue.items.map(item => item.url), Array.from(items, item => item.url))
})

class Media extends EventTarget {
  paused = true
  ended = false
  isConnected = true
  currentTime = 0
  playbackRate = 1
  muted = false
  volume = 1
  src = ''
  async play() { this.paused = false; this.dispatchEvent(new Event('play')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  removeAttribute() { this.src = '' }
  load() {}
}
test('inline playback prepares and plays the same audio for either quality and releases the old track', async () => {
  const audios = [], prepared = [], failures = []
  const env = { syncSeparatedAudio, playingKey: { value: null }, separatedAudioPlayers: new Map(),
    getPlaybackContext: async item => { prepared.push(structuredClone(item)); return { referrer: page, drm: false } },
    document: { createElement: () => { const audio = new Media(); audios.push(audio); return audio } },
    stopPlayback: () => failures.push('stopped'), showToastMsg: message => failures.push(message), t: key => key,
  }
  vm.runInNewContext(compile(['getPreviewAudioUrl', 'attachSeparatedAudioPlayback', 'stopSeparatedAudioPlayback'].map(name => declarations.get(name)).join('\n')), env)
  for (const item of items) {
    const video = new Media()
    env.playingKey.value = item.url
    await env.attachSeparatedAudioPlayback(item.url, video, item)
    await video.play()
    const audio = audios.at(-1)
    assert.equal(audio.src, audioUrl)
    assert.equal(audio.paused, false)
    env.stopSeparatedAudioPlayback(item.url)
    assert.equal(audio.paused, true)
    assert.equal(audio.src, '')
  }
  assert.deepEqual(prepared.map(item => item.url), [audioUrl, audioUrl])
  assert.deepEqual(failures, [])
})
