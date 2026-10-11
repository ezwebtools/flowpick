import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../utils/recording-session-store.ts', import.meta.url), 'utf8')
const context = vm.createContext({ console })
vm.runInContext(ts.transpileModule(source.replace('export interface', 'interface').replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context)
const makeStore = context.createRecordingSessionStore
const key = 'flowpick_recording_sessions_v1'
const sample = () => ({ id: 'record-1', mode: 'mse', sourceTabId: 1, targetTabId: 2,
  cancelled: false, active: true, sourcePrepared: true, playingFrames: new Set([0, 3]), preparePromise: Promise.resolve({ ok: true }) })
function memoryStorage(initial = {}) {
  let data = structuredClone(initial)
  return { get: async () => structuredClone(data), set: async value => { data = structuredClone(value) } }
}

test('worker restart restores ownership and playback without promises or reloading prepared sources', async () => {
  const storage = memoryStorage()
  const original = new Map(), sources = new Map()
  const store = makeStore(original, sources, storage, async () => true)
  await store.ready
  original.set(2, sample()); sources.set(1, 2)
  await store.save()
  const saved = (await storage.get())[key][0]
  assert.equal(saved.preparePromise, undefined)
  assert.deepEqual(saved.playingFrames, [0, 3])
  const restored = new Map(), restoredSources = new Map()
  await makeStore(restored, restoredSources, storage, async () => true).ready
  assert.equal(restoredSources.get(1), 2)
  assert.equal(restored.get(2).sourcePrepared, true)
  assert.deepEqual([...restored.get(2).playingFrames], [0, 3])
})

test('closed/malformed/stale tabs are not restored', async () => {
  const sessions = new Map(), sources = new Map()
  const { preparePromise: _promise, ...metadata } = sample()
  const storage = memoryStorage({ [key]: [
    { ...metadata, playingFrames: [0], cancelled: true },
    { ...metadata, playingFrames: [0], id: 'stale' },
    { ...metadata, playingFrames: [0], sourceTabId: -1 },
  ] })
  await makeStore(sessions, sources, storage, async () => false).ready
  assert.equal(sessions.size, 0)
  assert.equal(sources.size, 0)
})

test('serialized saves cannot resurrect a removed recording', async () => {
  const storage = memoryStorage(), sessions = new Map(), sources = new Map()
  const store = makeStore(sessions, sources, storage, async () => true)
  await store.ready
  sessions.set(2, sample())
  const first = store.save()
  sessions.delete(2)
  await Promise.all([first, store.save()])
  assert.deepEqual((await storage.get())[key], [])
})

test('storage failures reject rather than reporting a successful save', async () => {
  const store = makeStore(new Map(), new Map(), { get: async () => ({}), set: async () => { throw new Error('storage unavailable') } }, async () => true)
  await store.ready
  await assert.rejects(store.save(), /storage unavailable/)
})

const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
const openFlow = background.slice(background.indexOf("    if (msg.type === 'OPEN_RECORDING_PAGE') {"),
  background.indexOf("    if (msg.type === 'FLOWPICK_RECORDING_PAGE_READY') {"))
  .replaceAll('import.meta.env.FIREFOX', 'false')

for (const mode of ['mse', 'msr']) {
  test(`${mode}: session is saved before navigating to the production recording page`, async () => {
    const sessions = new Map(), sources = new Map()
    let saved = false, response
    const page = vm.createContext({
      msg: { type: 'OPEN_RECORDING_PAGE', sourceTabId: 1, mode }, navigator: { userAgent: 'Chrome' },
      isFirefoxFamily: () => false, crypto: { randomUUID: () => 'session-test' },
      SITE_ORIGIN: 'https://flowpick.net',
      recordingSessionsByTarget: sessions, recordingTargetBySource: sources,
      recordingStore: { save: async () => { saved = true } },
      sendResponse: value => { response = value },
      browser: { i18n: { getUILanguage: () => 'zh-CN' }, tabs: {
        get: async () => ({ title: 'Source' }),
        create: async options => { assert.equal(options.url, 'about:blank'); return { id: 2 } },
        update: async (id, options) => {
          assert(saved); assert.equal(sessions.get(id).id, 'session-test'); assert.equal(sources.get(1), id)
          assert.equal(options.url, 'https://flowpick.net/zh-Hans/recording?session=session-test')
        },
      } },
    })
    const code = ts.transpileModule(`(async () => { ${openFlow} })()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    await vm.runInContext(code, page)
    assert.equal(response.ok, true)
  })
}
