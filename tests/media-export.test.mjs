import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

/** Load the module into a context that owns its own `browser` double. */
function exportModule(calls = []) {
  const env = {
    exports: {}, TextEncoder, btoa,
    browser: { downloads: { download: async options => { calls.push(options); return 1 } } },
  }
  vm.runInNewContext(compile(read('entrypoints/popup/utils/media-export.ts')), env)
  return env.exports
}

const m = exportModule()

const item = overrides => ({ url: 'https://cdn.example/a.mp4', format: 'mp4', ...overrides })
const nameOf = entry => entry.url.split('/').pop()

test('url list export is one bare URL per line', () => {
  const text = m.buildUrlListText([item(), item({ url: 'https://cdn.example/b.m3u8' })])
  assert.equal(text, 'https://cdn.example/a.mp4\r\nhttps://cdn.example/b.m3u8')
  // A trailing newline would become an empty entry in most download managers.
  assert.equal(text.endsWith('\n'), false)
})

test('csv export quotes separators, quotes and newlines', () => {
  const csv = m.buildCsv([
    item({ url: 'https://cdn.example/a.mp4?x=1,2', tabTitle: 'He said "hi"', size: 1024 }),
  ], nameOf)
  assert.ok(
    csv.startsWith('\uFEFFname,url,format,size_bytes,width,height,duration_seconds,page_title'),
    'header must carry the BOM for Excel',
  )
  // The comma in the URL and the quotes in the title must both be escaped,
  // otherwise the column count shifts for every following row.
  assert.ok(csv.includes('"https://cdn.example/a.mp4?x=1,2"'))
  assert.ok(csv.includes('"He said ""hi"""'))
})

test('csv keeps one row per item and leaves unknown fields empty', () => {
  const csv = m.buildCsv([item({ size: 0 }), item({ url: 'https://cdn.example/b.mp4' })], nameOf)
  const rows = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n')
  assert.equal(rows.length, 3)
  assert.equal(rows[1].split(',').length, 8)
  // A real zero is exported; only a missing size stays blank.
  assert.equal(rows[1].split(',')[3], '0')
  assert.equal(rows[2].split(',')[3], '')
})

test('text files are handed to the download manager as self-contained data URLs', async () => {
  const calls = []
  const files = exportModule(calls)
  await files.downloadTextFile('page-urls.csv', 'héllo,世界', 'text/csv;charset=utf-8')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].filename, 'page-urls.csv')
  assert.equal(calls[0].saveAs, true)
  assert.ok(calls[0].url.startsWith('data:text/csv;charset=utf-8;base64,'))
  // The popup can close immediately, so the bytes must already be in the URL.
  const decoded = Buffer.from(calls[0].url.split(',')[1], 'base64').toString('utf8')
  assert.equal(decoded, 'héllo,世界')
})
