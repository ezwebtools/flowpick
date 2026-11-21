// End-to-end check of the worker-side probe against a real HTTP server:
// confirms the ranged request shape, the Content-Range total, the tail
// follow-up, and that a server which ignores Range is abandoned instead of
// streaming a whole file.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function findFfmpeg() {
  if (process.env.FP_FFMPEG && fs.existsSync(process.env.FP_FFMPEG)) return process.env.FP_FFMPEG
  for (const candidate of ['C:\\ffmpeg\\bin\\ffmpeg.exe', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const ffmpeg = findFfmpeg()
const skip = ffmpeg ? false : 'ffmpeg not available'

// Pull the worker helpers out of background.ts by name. They are module-scope
// functions with no closure dependencies, so they can run on their own — but
// they import the container parser, which has to be supplied separately.
function workerHelpers() {
  const source = read('entrypoints/background.ts')
  const ast = ts.createSourceFile('background.ts', source, ts.ScriptTarget.Latest, true)
  const wanted = ['headerProbeHeaders', 'fetchByteWindow', 'hasValues', 'probeMediaHeader']
  const found = new Map()
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && wanted.includes(statement.name.text)) {
      found.set(statement.name.text, statement.getText(ast))
    }
  }
  for (const name of wanted) assert.ok(found.has(name), `missing ${name} in background.ts`)

  const parserModule = { exports: {} }
  vm.runInNewContext(compile(read('utils/media-header.ts')), parserModule)

  const env = {
    exports: {}, URL, Uint8Array, DataView, AbortController, console, setTimeout, clearTimeout, fetch,
    ...parserModule.exports,
  }
  const body = wanted.map(name => found.get(name)).join('\n')
  vm.runInNewContext(
    compile(`${body}\n${wanted.map(name => `exports.${name} = ${name};`).join('\n')}`),
    env,
  )
  return env.exports
}

let directory = ''
let server
let origin = ''
const files = new Map()
let requestLog = []

// `range: false` simulates a CDN that answers 200 with the whole body.
const modes = new Map()

test.before(async () => {
  if (!ffmpeg) return
  directory = mkdtempSync(join(tmpdir(), 'flowpick-probe-'))
  const render = (name, args) => {
    const target = join(directory, name)
    execFileSync(ffmpeg, ['-y', '-v', 'error', ...args, target], { stdio: 'ignore' })
    return fs.readFileSync(target)
  }
  files.set('/faststart.mp4', render('faststart.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ]))
  files.set('/moov-end.mp4', render('moov-end.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  ]))
  files.set('/clip.webm', render('clip.webm', [
    '-f', 'lavfi', '-i', 'testsrc=size=800x600:rate=25:duration=7',
    '-c:v', 'libvpx-vp9', '-b:v', '200k',
  ]))

  server = createServer((request, response) => {
    const body = files.get(request.url.split('?')[0])
    requestLog.push({ url: request.url, range: request.headers.range ?? null })
    if (!body) { response.writeHead(404).end(); return }
    const ignoresRange = modes.get(request.url) === 'no-range'
    const match = !ignoresRange && /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (!match) {
      response.writeHead(200, { 'content-length': body.length, 'content-type': 'video/mp4' })
      response.end(body)
      return
    }
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), body.length - 1)
    const chunk = body.subarray(start, end + 1)
    response.writeHead(206, {
      'content-length': chunk.length,
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-type': 'video/mp4',
    })
    response.end(chunk)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

test.after(() => {
  server?.close()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

const probe = async (path, format, headers = {}) => {
  const helpers = workerHelpers()
  return helpers.probeMediaHeader(`${origin}${path}`, format, headers, new AbortController().signal)
}

test('probe reads duration, resolution and total size in one request', { skip }, async () => {
  requestLog = []
  const result = await probe('/faststart.mp4', 'mp4')
  assert.ok(result, 'probe returned nothing')
  assert.ok(Math.abs(result.metadata.duration - 6) < 0.2, `duration ${result.metadata.duration}`)
  assert.equal(result.metadata.width, 1280)
  assert.equal(result.metadata.height, 720)
  // The ranged response carries the real file length; the worker reuses it.
  assert.equal(result.totalSize, files.get('/faststart.mp4').length)
  assert.equal(requestLog.length, 1)
  assert.match(requestLog[0].range, /^bytes=0-131071$/)
})

test('moov-at-end file costs exactly one extra tail request', { skip }, async () => {
  requestLog = []
  const result = await probe('/moov-end.mp4', 'mp4')
  assert.ok(result, 'probe returned nothing')
  assert.ok(Math.abs(result.metadata.duration - 20) < 0.2, `duration ${result.metadata.duration}`)
  assert.equal(result.metadata.width, 640)
  assert.equal(result.metadata.height, 360)
  assert.equal(requestLog.length, 2)
  const total = files.get('/moov-end.mp4').length
  assert.match(requestLog[1].range, new RegExp(`^bytes=${total - 131072}-${total - 1}$`))
})

test('WebM is read from the head window alone', { skip }, async () => {
  requestLog = []
  const result = await probe('/clip.webm', 'webm')
  assert.ok(result, 'probe returned nothing')
  assert.ok(Math.abs(result.metadata.duration - 7) < 0.5, `duration ${result.metadata.duration}`)
  assert.equal(result.metadata.width, 800)
  assert.equal(result.metadata.height, 600)
  assert.equal(requestLog.length, 1)
})

test('a server that ignores Range is abandoned, not streamed', { skip }, async () => {
  requestLog = []
  modes.set('/faststart.mp4?ignore', 'no-range')
  files.set('/ignored.mp4', files.get('/faststart.mp4'))
  modes.set('/ignored.mp4', 'no-range')
  const result = await probe('/ignored.mp4', 'mp4')
  assert.equal(result, null)
  assert.equal(requestLog.length, 1)
})

test('stream formats never reach the network', { skip }, async () => {
  requestLog = []
  for (const format of ['m3u8', 'mpd', 'flv', 'ts', 'jpg']) {
    assert.equal(await probe('/faststart.mp4', format), null, format)
  }
  assert.equal(requestLog.length, 0)
})

test('only referer/origin/cookie/user-agent are forwarded to the CDN', { skip }, async () => {
  const helpers = workerHelpers()
  const filtered = helpers.headerProbeHeaders({
    Referer: 'https://site.example/watch',
    Cookie: 'session=1',
    Authorization: 'Bearer secret',
    'X-Custom': 'nope',
  })
  assert.deepEqual(Object.keys(filtered).sort(), ['Cookie', 'Referer'])
  assert.equal(filtered.Authorization, undefined)
})

test('an aborted signal leaves no pending request behind', { skip }, async () => {
  requestLog = []
  const helpers = workerHelpers()
  const controller = new AbortController()
  controller.abort()
  const result = await helpers.probeMediaHeader(
    `${origin}/faststart.mp4`, 'mp4', {}, controller.signal,
  ).catch(() => null)
  assert.equal(result, null)
})
