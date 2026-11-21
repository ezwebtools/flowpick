// Per-item removal and the differentiated empty state both hinge on behaviour
// that is easy to regress: a deleted row must stay deleted, and an empty list
// must explain the right reason.
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

function extract(names) {
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

/** Run the real DISMISS_MEDIA handler against a fake tab map. */
function harness() {
  const mediaMap = new Map()
  const saved = []
  const broadcasts = []
  const env = {
    exports: {},
    tabMap: new Map([[1, mediaMap]]),
    dismissedMedia: new Map(),
    saveTabList: async () => { saved.push(mediaMap.size) },
    updateBadge: () => {},
    broadcastDebounced: tabId => broadcasts.push(tabId),
    console,
  }
  // The handler is a branch inside `handleMessage`, so slice it out by brace
  // matching rather than reimplementing it here — the point is to test the real
  // code, not a copy that can drift.
  const marker = "if (msg.type === 'DISMISS_MEDIA') {"
  const start = source.indexOf(marker)
  assert.ok(start > 0, 'DISMISS_MEDIA handler not found')
  let depth = 0
  let end = start
  for (let index = start; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) { end = index + 1; break }
    }
  }
  assert.ok(end > start, 'could not find the end of the DISMISS_MEDIA block')
  // Strip the `if (msg.type === ...) {` wrapper and its closing brace: the
  // branch body is what needs testing, and keeping the guard means every test
  // has to repeat the message type just to get past it.
  const bodyStart = source.indexOf('{', start) + 1
  const body = source.slice(bodyStart, end - 1)

  vm.runInNewContext(compile(`
    exports.dismiss = (msg, sender) => {
      const sendResponse = value => { exports.response = value }
      // The branch uses bare \`return true\` to keep the channel open, so the body
      // has to live in its own function or it would exit before the recorded
      // response is read back.
      const run = () => { ${body} }
      run()
      return exports.response
    };
  `), env)
  return { env, mediaMap, saved, broadcasts }
}

const MASTER = 'https://cdn.example/master.mp4'
const VARIANT = 'https://cdn.example/720p.mp4'
const OTHER = 'https://cdn.example/other.mp4'

function seed(mediaMap) {
  mediaMap.set(MASTER, { format: 'm3u8', groupId: MASTER, groupRole: 'master' })
  mediaMap.set(VARIANT, { format: 'm3u8', groupMasterId: MASTER, groupRole: 'variant' })
  mediaMap.set(OTHER, { format: 'mp4' })
}

test('deleting a row removes it and remembers it', () => {
  const h = harness()
  seed(h.mediaMap)
  const result = h.env.exports.dismiss({ tabId: 1, urls: [OTHER] }, {})

  assert.equal(result.ok, true)
  assert.equal(result.removed, true)
  assert.equal(h.mediaMap.has(OTHER), false)
  assert.equal(h.mediaMap.size, 2, 'unrelated rows must survive')
  assert.equal(h.env.dismissedMedia.get(1).has(OTHER), true)
  assert.ok(h.broadcasts.length >= 1)
})

test('deleting a stream master takes its variants with it', () => {
  const h = harness()
  seed(h.mediaMap)
  h.env.exports.dismiss({ tabId: 1, urls: [MASTER] }, {})

  assert.equal(h.mediaMap.has(MASTER), false)
  assert.equal(h.mediaMap.has(VARIANT), false, 'an orphan variant would show as a ghost row')
  assert.equal(h.mediaMap.has(OTHER), true)
})

test('the dismissed set survives a repeated delete without double-reporting', () => {
  const h = harness()
  seed(h.mediaMap)
  h.env.exports.dismiss({ tabId: 1, urls: [OTHER] }, {})
  const second = h.env.exports.dismiss({ tabId: 1, urls: [OTHER] }, {})
  // Nothing left to remove, but the call still succeeds: the user's intent is
  // already satisfied, and an error here would surface as a broken button.
  assert.equal(second.ok, true)
  assert.equal(second.removed, false)
})

test('an empty or malformed url list is rejected', () => {
  const h = harness()
  seed(h.mediaMap)
  for (const msg of [
    { tabId: 1, urls: [] },
    { tabId: 1, urls: [42, null, ''] },
    { tabId: 1 },
  ]) {
    const result = h.env.exports.dismiss(msg, {})
    assert.equal(result.ok, false, JSON.stringify(msg))
  }
  assert.equal(h.mediaMap.size, 3)
})

test('the sender tab is used when the message omits tabId', () => {
  const h = harness()
  seed(h.mediaMap)
  const result = h.env.exports.dismiss({ urls: [OTHER] }, { tab: { id: 1 } })
  assert.equal(result.ok, true)
  assert.equal(h.mediaMap.has(OTHER), false)
})

test('addMedia refuses a row the user deleted', () => {
  // The queue/pause guards live in addMedia; deletion has to be enforced at the
  // same funnel or a re-sniff resurrects the row.
  const body = extract(['addMedia'])
  assert.match(body, /dismissedMedia\.get\(tabId\)\?\.has\(url\)/)
  // Both pause layers are consulted, and the combined check is the one used:
  // matching only the per-tab set would let a global pause leak rows through.
  assert.match(body, /sniffControl\.isPaused\(tabId\)/)
})
