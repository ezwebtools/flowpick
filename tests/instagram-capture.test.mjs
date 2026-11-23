import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { DOMParser } from '@xmldom/xmldom'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const normalization = { exports: {}, URL }
vm.runInNewContext(compile(read('utils/instagram-media.ts')), normalization)
const player = { exports: {}, URL, DOMParser, require: () => normalization.exports }
vm.runInNewContext(compile(read('utils/instagram-player.ts')), player)
const sample = read('tests/fixtures/instagram-hydration.json')
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function setup({ initialText = sample, failFirst = false } = {}) {
  class Element {
    constructor(tagName, textContent = '') { Object.assign(this, { tagName, textContent }) }
    querySelectorAll() { return [] }
  }
  const script = new Element('SCRIPT', initialText)
  const reports = []
  let observe, tick, disconnected = false
  const context = { exports: {}, Element,
    location: { hostname: 'www.instagram.com', href: 'https://www.instagram.com/reels/Example-/' },
    document: { querySelectorAll: () => [script] },
    MutationObserver: class { constructor(callback) { observe = callback } observe() {} disconnect() { disconnected = true } },
    setInterval: callback => { tick = callback; return 1 }, clearInterval() {},
    // The page-world parser must never run, even when page hook injection fails.
    window: { DOMParser: class { parseFromString() { throw new TypeError('TrustedHTML required') } }, addEventListener() {} },
    require: () => player.exports,
  }
  vm.runInNewContext(compile(read('utils/instagram-capture.ts')), context)
  const capture = context.exports.installInstagramCapture(async task => {
    if (failFirst) { failFirst = false; throw new Error('bridge not ready') }
    reports.push(structuredClone(task))
  })
  return { capture, script, reports, context, mutate: records => observe(records), tick: () => tick(), disconnected: () => disconnected }
}

test('isolated capture reads supplied hydration without any page-world hook or TrustedHTML sink', async () => {
  const env = setup()
  await flush()
  assert.equal(env.reports.length, 1)
  assert.equal(env.reports[0].candidates.filter(item => item.role === 'video').length, 2)
  assert.equal(env.reports[0].candidates.filter(item => item.role === 'audio').length, 1)
  env.tick()
  await flush()
  assert.equal(env.reports.length, 1)
  env.capture.dispose()
  assert.equal(env.disconnected(), true)
})

test('scripts inserted empty and populated later still produce the paired media task', async () => {
  const env = setup({ initialText: '' })
  env.script.textContent = sample
  env.mutate([{ target: env.script, addedNodes: [] }])
  await flush()
  assert.equal(env.reports.length, 1)
  env.capture.dispose()
})

test('failed deliveries retry and SPA navigation selects the next Reel from cached hydration', async () => {
  const env = setup({ failFirst: true })
  await flush()
  assert.equal(env.reports.length, 0)
  env.tick()
  await flush()
  assert.equal(env.reports.length, 1)
  env.context.location.href = 'https://www.instagram.com/reels/Neighbor/'
  env.tick()
  await flush()
  assert.equal(env.reports.length, 2)
  assert.equal(env.reports[1].key, 'sample-neighbor')
  env.capture.dispose()
})

test('main-world adapter forwards text for isolated parsing without touching DOMParser', () => {
  const source = read('entrypoints/injected.ts')
  const ast = ts.createSourceFile('injected.ts', source, ts.ScriptTarget.Latest, true)
  let declaration
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseInstagramResponse') declaration = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(declaration)
  const sent = []
  const ctx = { location: { href: 'https://www.instagram.com/reels/Example-/' },
    window: { postMessage: message => sent.push(structuredClone(message)) },
    DOMParser: class { constructor() { throw new Error('page-world XML parsing is unavailable') } },
  }
  vm.runInNewContext(compile(declaration), ctx)
  ctx.parseInstagramResponse(sample)
  assert.equal(sent[0].type, 'INSTAGRAM_MEDIA_RESPONSE')
  assert.equal(sent[0].text, sample)
  ctx.parseInstagramResponse('{"unrelated":true}')
  assert.equal(sent.length, 1)
})
