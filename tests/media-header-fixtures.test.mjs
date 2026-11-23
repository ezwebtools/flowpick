// Validate the container-header parser against real encoder output rather than
// only hand-built boxes. ffmpeg is optional: without it every case is skipped,
// so the suite still passes on a machine that has never encoded a video.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const module = { exports: {} }
vm.runInNewContext(compile(read('utils/media-header.ts')), module)
const { probeContainerHeader, HEADER_WINDOW_BYTES, TAIL_WINDOW_BYTES } = module.exports

function findFfmpeg() {
  if (process.env.FP_FFMPEG && fs.existsSync(process.env.FP_FFMPEG)) return process.env.FP_FFMPEG
  for (const candidate of ['C:\\ffmpeg\\bin\\ffmpeg.exe', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const ffmpeg = findFfmpeg()
const skip = ffmpeg ? false : 'ffmpeg not available'

let directory = ''
const render = (name, args) => {
  const target = join(directory, name)
  execFileSync(ffmpeg, ['-y', '-v', 'error', ...args, target], { stdio: 'ignore' })
  return new Uint8Array(fs.readFileSync(target))
}

test.before(() => {
  if (!ffmpeg) return
  directory = mkdtempSync(join(tmpdir(), 'flowpick-header-'))
  // faststart: moov before mdat, the common streaming layout.
  render('faststart.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  // Default ffmpeg layout: moov after mdat. 20 s at this bitrate keeps the file
  // comfortably larger than one header window, which is what forces the tail.
  render('moov-end.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  ])
  render('audio.m4a', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
    '-c:a', 'aac', '-movflags', '+faststart',
  ])
  render('clip.webm', [
    '-f', 'lavfi', '-i', 'testsrc=size=800x600:rate=25:duration=7',
    '-c:v', 'libvpx-vp9', '-b:v', '200k',
  ])
})

test.after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

const near = (actual, expected, tolerance = 0.15) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `expected ~${expected}, got ${actual} (tolerance ${tolerance})`)

test('faststart MP4 head window', { skip }, () => {
  const bytes = new Uint8Array(fs.readFileSync(join(directory, 'faststart.mp4'))).slice(0, HEADER_WINDOW_BYTES)
  const verdict = probeContainerHeader(bytes, 'mp4')
  assert.equal(verdict.kind, 'found')
  near(verdict.metadata.duration, 6)
  assert.equal(verdict.metadata.width, 1280)
  assert.equal(verdict.metadata.height, 720)
})

test('moov-at-end MP4: head asks for the tail, the tail delivers', { skip }, () => {
  const file = new Uint8Array(fs.readFileSync(join(directory, 'moov-end.mp4')))
  assert.equal(probeContainerHeader(file.slice(0, HEADER_WINDOW_BYTES), 'mp4').kind, 'need-tail')

  const tailStart = Math.max(0, file.length - TAIL_WINDOW_BYTES)
  const verdict = probeContainerHeader(file.slice(tailStart), 'mp4', tailStart, 'tail')
  assert.equal(verdict.kind, 'found')
  near(verdict.metadata.duration, 20)
  assert.equal(verdict.metadata.width, 640)
  assert.equal(verdict.metadata.height, 360)
})

test('audio-only M4A reports duration and leaves dimensions undefined', { skip }, () => {
  const bytes = new Uint8Array(fs.readFileSync(join(directory, 'audio.m4a'))).slice(0, HEADER_WINDOW_BYTES)
  const verdict = probeContainerHeader(bytes, 'm4a')
  assert.equal(verdict.kind, 'found')
  near(verdict.metadata.duration, 9, 0.5)
  assert.equal(verdict.metadata.width, undefined)
  assert.equal(verdict.metadata.height, undefined)
})

test('WebM reports duration and pixel dimensions', { skip }, () => {
  const bytes = new Uint8Array(fs.readFileSync(join(directory, 'clip.webm'))).slice(0, HEADER_WINDOW_BYTES)
  const verdict = probeContainerHeader(bytes, 'webm')
  assert.equal(verdict.kind, 'found')
  near(verdict.metadata.duration, 7, 0.5)
  assert.equal(verdict.metadata.width, 800)
  assert.equal(verdict.metadata.height, 600)
})

test('a truncated real MP4 never throws and never invents numbers', { skip }, () => {
  const file = new Uint8Array(fs.readFileSync(join(directory, 'faststart.mp4')))
  for (const size of [0, 1, 7, 8, 16, 32, 64, 128]) {
    const verdict = probeContainerHeader(file.slice(0, size), 'mp4')
    assert.ok(['unknown', 'need-range', 'need-tail'].includes(verdict.kind), `size ${size}: ${verdict.kind}`)
  }
})
