import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { reactive } from 'vue'

const source = fs.readFileSync(new URL('../entrypoints/player/playback.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const mediaMessage = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../utils/media-message.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, mediaMessage)
const separatedAudio = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../utils/separated-audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, separatedAudio)
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
class Media extends EventTarget {
  isConnected = true
  paused = true
  currentTime = 0
  playbackRate = 1
  volume = 1
  muted = false
  src = ''
  async play() { this.paused = false; this.dispatchEvent(new Event('play')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  load() {}
  removeAttribute() { this.src = '' }
}
function setup({ prepare, hlsLoader } = {}) {
  const requests = [], instances = [], audio = [], errors = []
  class Hls {
    static Events = { MANIFEST_PARSED: 'ready', ERROR: 'error' }
    static ErrorTypes = { NETWORK_ERROR: 'network' }
    static isSupported = () => true
    handlers = {}
    constructor(options) { this.options = options; instances.push(this) }
    on(type, fn) { this.handlers[type] = fn }
    loadSource(url) { this.url = url }
    attachMedia(media) { this.media = media }
    destroy() { this.destroyed = true }
  }
  const env = {
    exports: {}, queueMicrotask,
    Audio: class extends Media { constructor() { super(); audio.push(this) } },
    browser: { runtime: { sendMessage: async msg => { requests.push(structuredClone(msg)); return prepare ? prepare(msg) : { ok: true } } } },
    require: path => {
      if (path.endsWith('/media-message')) return mediaMessage.exports
      if (path.endsWith('/separated-audio')) return separatedAudio.exports
      if (path.endsWith('/i18n')) return { t: key => key }
      if (path.endsWith('/useStreamThumbnails')) return { loadHls: hlsLoader || (async () => Hls) }
      if (path.endsWith('/hlsProxyLoader')) return { createHlsProxyLoader: options => ({ proxy: options }) }
      throw new Error(path)
    },
  }
  vm.runInNewContext(compiled, env)
  const session = { id: '1', title: 'Video', referrer: 'https://source.example/', item: {
    url: 'https://cdn.example/master.m3u8', format: 'm3u8', requestHeaders: { Authorization: 'secret' },
  } }
  const media = new Media()
  return { attach: env.exports.attachPlayer, session, media, requests, instances, audio, errors }
}

test('HLS prepares captured headers, falls back to proxy and destroys all instances on close', async () => {
  const env = setup()
  const dispose = env.attach(env.media, env.session, msg => env.errors.push(msg))
  await flush()
  assert.equal(env.requests[0].referrer, env.session.referrer)
  assert.equal(env.requests[0].requestHeaders.Authorization, 'secret')
  const direct = env.instances[0]
  direct.handlers.error(null, { fatal: true, type: 'network' })
  await flush()
  assert.equal(direct.destroyed, true)
  const proxy = env.instances[1]
  assert.equal(proxy.options.loader.proxy.requestHeaders.Authorization, 'secret')
  proxy.handlers.ready()
  await flush()
  assert.equal(env.media.paused, false)
  dispose()
  assert.equal(proxy.destroyed, true)
  assert.equal(env.media.paused, true)
  assert.equal(env.media.src, '')
})

test('closing during async preparation never starts network playback later', async () => {
  let resolve
  const env = setup({ prepare: () => new Promise(done => { resolve = done }) })
  const dispose = env.attach(env.media, env.session, msg => env.errors.push(msg))
  dispose()
  resolve({ ok: true })
  await flush()
  assert.equal(env.instances.length, 0)
  assert.equal(env.media.src, '')
})

test('direct video prepares and synchronizes separate audio, then releases both tracks', async () => {
  const env = setup()
  env.session.item.format = 'mp4'
  env.session.item.audioUrl = 'https://audio.example/track.m4a'
  const dispose = env.attach(env.media, env.session, msg => env.errors.push(msg))
  await flush()
  assert.equal(env.requests.length, 2)
  assert.equal(env.requests[1].url, env.session.item.audioUrl)
  assert.equal(env.audio[0].paused, false)
  env.media.currentTime = 40
  env.media.dispatchEvent(new Event('seeking'))
  assert.equal(env.audio[0].currentTime, 40)
  env.media.playbackRate = 1.5
  env.media.dispatchEvent(new Event('ratechange'))
  assert.equal(env.audio[0].playbackRate, 1.5)
  env.media.pause()
  assert.equal(env.audio[0].paused, true)
  dispose()
  assert.equal(env.audio[0].src, '')
  assert.equal(env.media.src, '')
})

test('DRM preflight rejection does not assign a source', async () => {
  const env = setup({ prepare: async () => ({ ok: true, drm: true }) })
  env.attach(env.media, env.session, msg => env.errors.push(msg))
  await flush()
  assert.deepEqual(env.errors, ['drmProtected'])
  assert.equal(env.media.src, '')
  assert.equal(env.instances.length, 0)
})

test('Vue reactive sessions can cross Firefox structured-clone messaging boundaries', async () => {
  const env = setup()
  const session = reactive(env.session)
  const dispose = env.attach(env.media, session, msg => env.errors.push(msg))
  await flush()
  assert.deepEqual(env.errors, [])
  assert.equal(env.requests[0].requestHeaders.Authorization, 'secret')
  assert.equal(env.instances.length, 1)
  env.instances[0].handlers.error(null, { fatal: true, type: 'network' })
  await flush()
  const proxyOptions = structuredClone(env.instances[1].options.loader.proxy)
  assert.equal(proxyOptions.requestHeaders.Authorization, 'secret')
  dispose()
})
