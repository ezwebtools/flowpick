import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const env = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../utils/separated-audio.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, env)
const { syncSeparatedAudio } = env.exports
class Media extends EventTarget {
  paused = true
  ended = false
  currentTime = 0
  playbackRate = 1
  volume = 1
  muted = false
  src = 'track.mp4'
  async play() { this.paused = false; this.dispatchEvent(new Event('play')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  removeAttribute() { this.src = '' }
  load() {}
}
test('paired audio follows play, seek, speed, volume, mute, buffering and disposal', async () => {
  const video = new Media(), audio = new Media(), errors = []
  video.volume = 0.4; video.playbackRate = 1.25
  const dispose = syncSeparatedAudio(video, audio, () => errors.push('audio-failed'))
  assert.equal(audio.volume, 0.4)
  assert.equal(audio.playbackRate, 1.25)
  await video.play()
  assert.equal(audio.paused, false)
  video.muted = true; video.dispatchEvent(new Event('volumechange'))
  assert.equal(audio.muted, true)
  video.currentTime = 8; video.dispatchEvent(new Event('seeking'))
  assert.equal(audio.currentTime, 8)
  assert.equal(audio.paused, true)
  video.dispatchEvent(new Event('seeked'))
  assert.equal(audio.paused, false)
  video.dispatchEvent(new Event('waiting'))
  assert.equal(audio.paused, true)
  video.dispatchEvent(new Event('playing'))
  assert.equal(audio.paused, false)
  video.playbackRate = 2; video.dispatchEvent(new Event('ratechange'))
  assert.equal(audio.playbackRate, 2)
  video.pause()
  assert.equal(audio.paused, true)
  dispose()
  assert.equal(audio.src, '')
  await video.play()
  assert.equal(audio.paused, true)
  assert.deepEqual(errors, [])
})

test('intentional buffering cancellation is ignored and actual audio errors are surfaced', async () => {
  const video = new Media(), audio = new Media(), errors = []
  let reject
  audio.play = () => new Promise((_, fail) => { reject = fail })
  const dispose = syncSeparatedAudio(video, audio, () => errors.push('audio-failed'))
  await video.play()
  video.dispatchEvent(new Event('waiting'))
  reject(new Error('play cancelled by pause'))
  await Promise.resolve()
  assert.deepEqual(errors, [])
  audio.dispatchEvent(new Event('error'))
  assert.deepEqual(errors, ['audio-failed'])
  dispose()
  audio.dispatchEvent(new Event('error'))
  assert.equal(errors.length, 1)
})
