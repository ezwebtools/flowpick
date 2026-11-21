// The worker-side header queue is the only thing that now fills in size for
// MP4/WebM, so its guard rails deserve direct tests: what it schedules, what it
// refuses to schedule, and what it does with the answer.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const source = read('entrypoints/background.ts')
const ast = ts.createSourceFile('background.ts', source, ts.ScriptTarget.Latest, true)

/** Grab a named function from background.ts, with its dependencies. */
function extract(names) {
  // The queue lives inside `defineBackground(() => { ... })`, so the AST has to
  // be walked recursively rather than only over top-level statements.
  const found = new Map()
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)

  const missing = names.filter(name => !found.has(name))
  assert.deepEqual(missing, [], `missing from background.ts: ${missing.join(', ')}`)
  return names.map(name => found.get(name)).join('\n')
}

/**
 * Build a stand-in for the module scope of background.ts: the queue helpers,
 * the state they close over, and a fake `probeMediaHeader` that records calls.
 */
function harness(options = {}) {
  const settings = {
    prefetchMetadata: options.prefetchMetadata ?? true,
    sniffingRules: options.sniffingRules ?? { video: { enabled: true, minSizeKB: 100 } },
  }
  const probed = []
  const broadcasts = []
  const saved = []
  const mediaMap = new Map()
  const env = {
    exports: {},
    // Module-level state the helpers touch.
    tabMap: new Map([[1, mediaMap]]),
    currentSettings: settings,
    console,
    setTimeout,
    clearTimeout,
    // Collaborators, stubbed.
    containerProbeFormat: format => (['mp4', 'm4v', 'mov', 'm4a', 'webm', 'mkv'].includes(format) ? 'iso-bmff' : null),
    getFormatGroup: format => (['mp4', 'm4v', 'mov'].includes(format) ? 'video' : format === 'm4a' ? 'audio' : null),
    saveTabList: async (tabId, map) => { saved.push({ tabId, size: map.size }) },
    updateBadge: () => {},
    broadcastDebounced: tabId => broadcasts.push(tabId),
    probeMediaHeader: async (url, format) => {
      probed.push({ url, format })
      const answer = options.answers?.[url]
      return answer === undefined ? null : answer
    },
    AbortController,
  }
  const body = extract([
    'headerProbeHeaders', 'headerProbeSet', 'cancelHeaderProbes', 'queueHeaderProbe',
    'pumpHeaderProbes', 'runHeaderProbe',
  ])
  vm.runInNewContext(compile(`
    const sniffingPausedTabs = new Set();
    const headerProbeQueue = [];
    const headerProbeQueued = new Map();
    const headerProbeDone = new Map();
    const headerProbeFailed = new Map();
    const headerProbeControllers = new Map();
    const HEADER_PROBE_CONCURRENCY = 2;
    const HEADER_PROBE_PER_TAB_MAX = 120;
    let headerProbeActive = 0;
    ${body}
    exports.state = {
      queue: headerProbeQueue, queued: headerProbeQueued, done: headerProbeDone,
      failed: headerProbeFailed, controllers: headerProbeControllers,
      active: () => headerProbeActive, max: HEADER_PROBE_PER_TAB_MAX,
    };
    exports.queueHeaderProbe = queueHeaderProbe;
    exports.cancelHeaderProbes = cancelHeaderProbes;
    exports.idle = () => new Promise(resolve => {
      const tick = () => (headerProbeActive === 0 && headerProbeQueue.length === 0)
        ? resolve() : setTimeout(tick, 4);
      tick();
    });
  `), env)
  return { env, mediaMap, probed, broadcasts, saved, settings }
}

const ENTRY = { format: 'mp4', detectedAt: Date.now() }

test('an MP4 with no metadata is queued and its answer is stored', async () => {
  const h = harness({ answers: { 'https://cdn.example/a.mp4': { metadata: { duration: 42, width: 1920, height: 1080 }, totalSize: 8_000_000 } } })
  h.mediaMap.set('https://cdn.example/a.mp4', { ...ENTRY })
  h.env.exports.queueHeaderProbe(1, 'https://cdn.example/a.mp4', 'mp4', h.mediaMap.get('https://cdn.example/a.mp4'))
  await h.env.exports.idle()

  assert.equal(h.probed.length, 1)
  const stored = h.mediaMap.get('https://cdn.example/a.mp4')
  assert.equal(stored.duration, 42)
  assert.equal(stored.width, 1920)
  assert.equal(stored.height, 1080)
  assert.equal(stored.size, 8_000_000)
  assert.ok(h.broadcasts.length >= 1, 'the list should have been broadcast')
})

test('streams and images are never probed', async () => {
  const h = harness({ answers: {} })
  for (const format of ['m3u8', 'mpd', 'flv', 'ts', 'jpg', 'mp3']) {
    h.mediaMap.set(`https://cdn.example/${format}`, { format })
    h.env.exports.queueHeaderProbe(1, `https://cdn.example/${format}`, format, h.mediaMap.get(`https://cdn.example/${format}`))
  }
  await h.env.exports.idle()
  assert.equal(h.probed.length, 0)
})

test('entries that already have everything are skipped', async () => {
  const h = harness({ answers: {} })
  const url = 'https://cdn.example/known.mp4'
  h.mediaMap.set(url, { ...ENTRY, duration: 10, width: 640, height: 480 })
  h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.probed.length, 0)
})

test('a partially known entry is still probed for the missing fields', async () => {
  const h = harness({ answers: { 'https://cdn.example/half.mp4': { metadata: { width: 1280, height: 720 } } } })
  const url = 'https://cdn.example/half.mp4'
  h.mediaMap.set(url, { ...ENTRY, duration: 12 })
  h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.probed.length, 1)
  const stored = h.mediaMap.get(url)
  assert.equal(stored.duration, 12, 'the known duration must not be overwritten')
  assert.equal(stored.width, 1280)
  assert.equal(stored.height, 720)
})

test('the same URL is queued once even when the list broadcasts repeatedly', async () => {
  const h = harness({ answers: { 'https://cdn.example/a.mp4': { metadata: { duration: 5 } } } })
  const url = 'https://cdn.example/a.mp4'
  h.mediaMap.set(url, { ...ENTRY })
  for (let i = 0; i < 5; i++) h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.probed.length, 1)
})

test('a failed probe is remembered and never retried for that tab', async () => {
  const h = harness({ answers: {} }) // probeMediaHeader returns null
  const url = 'https://cdn.example/dead.mp4'
  h.mediaMap.set(url, { ...ENTRY })
  h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.probed.length, 1)

  h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.probed.length, 1, 'a dead CDN must not be retried per broadcast')
  assert.equal(h.env.exports.state.failed.get(1).has(url), true)
})

test('the prefetch switch stops the queue before any request is made', async () => {
  const h = harness({ prefetchMetadata: false, answers: { 'https://cdn.example/a.mp4': { metadata: { duration: 5 } } } })
  const url = 'https://cdn.example/a.mp4'
  h.mediaMap.set(url, { ...ENTRY })
  h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.probed.length, 0)
})

test('a probed size below the sniffing minimum removes the entry', async () => {
  const h = harness({
    answers: { 'https://cdn.example/tiny.mp4': { metadata: { duration: 1 }, totalSize: 20 * 1024 } },
    sniffingRules: { video: { enabled: true, minSizeKB: 100 } },
  })
  const url = 'https://cdn.example/tiny.mp4'
  h.mediaMap.set(url, { ...ENTRY })
  h.env.exports.queueHeaderProbe(1, url, 'mp4', h.mediaMap.get(url))
  await h.env.exports.idle()
  assert.equal(h.mediaMap.has(url), false, 'a 20 KB file must not survive a 100 KB rule')
  assert.ok(h.broadcasts.length >= 1)
})

test('cancelling a tab drops its queue and forgets its bookkeeping', async () => {
  const h = harness({ answers: {} })
  for (let i = 0; i < 4; i++) {
    h.mediaMap.set(`https://cdn.example/${i}.mp4`, { ...ENTRY })
    h.env.exports.queueHeaderProbe(1, `https://cdn.example/${i}.mp4`, 'mp4', h.mediaMap.get(`https://cdn.example/${i}.mp4`))
  }
  h.env.exports.cancelHeaderProbes(1)
  await h.env.exports.idle()
  assert.equal(h.env.exports.state.queued.size, 0)
  assert.equal(h.env.exports.state.failed.size, 0)
})

test('per-tab queue length is capped', async () => {
  const h = harness({ answers: {} })
  const max = h.env.exports.state.max
  for (let i = 0; i < max + 20; i++) {
    h.mediaMap.set(`https://cdn.example/${i}.mp4`, { ...ENTRY })
    h.env.exports.queueHeaderProbe(1, `https://cdn.example/${i}.mp4`, 'mp4', h.mediaMap.get(`https://cdn.example/${i}.mp4`))
  }
  assert.ok(h.env.exports.state.queued.get(1).size <= max)
})
