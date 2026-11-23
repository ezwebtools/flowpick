import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function sniff() {
  const env = { exports: {} }
  vm.runInNewContext(compile(read('utils/sniff-control.ts')), env)
  return env.exports
}

const s = sniff()

test('the two pause layers are independent', () => {
  const control = s.createSniffControl()
  control.setGlobal(true)
  control.setTab(7, true)
  // Resuming one tab must not switch the whole extension back on.
  control.setTab(7, false)
  assert.equal(control.isGlobalPaused(), true)
  assert.equal(control.isPaused(7), true, 'the global layer still applies to tab 7')
  // …and clearing the global layer must not clear a tab the user paused.
  control.setTab(9, true)
  control.setGlobal(false)
  assert.equal(control.isPaused(9), true)
  assert.equal(control.isPaused(7), false)
})

test('scopeFor names which layer is responsible', () => {
  const control = s.createSniffControl()
  assert.equal(control.scopeFor(1), 'none')
  control.setTab(1, true)
  assert.equal(control.scopeFor(1), 'tab')
  assert.equal(control.scopeFor(2), 'none')
  control.setGlobal(true)
  assert.equal(control.scopeFor(1), 'both')
  assert.equal(control.scopeFor(2), 'global')
})

test('setters report whether anything actually changed', () => {
  const control = s.createSniffControl()
  assert.equal(control.setGlobal(true), true)
  assert.equal(control.setGlobal(true), false, 'no-op writes must not trigger a persist')
  assert.equal(control.setTab(3, true), true)
  assert.equal(control.setTab(3, true), false)
  assert.equal(control.setTab(Number.NaN, true), false, 'a bogus tab id is rejected')
  assert.equal(control.isPaused(3), true, 'the rejected id did not disturb real state')
})

test('forgetTab drops a closed tab and leaves the others alone', () => {
  const control = s.createSniffControl({ tabs: [1, 2, 3] })
  assert.equal(control.forgetTab(2), true)
  assert.equal(control.forgetTab(2), false)
  // Spread first: values built inside the vm realm have foreign prototypes, and\n  // a cross-realm deepEqual compares those too.\n  assert.deepEqual([...control.pausedTabIds()].sort(), [1, 3])
  assert.equal(control.isGlobalPaused(), false)
})

test('a snapshot round-trips through the constructor', () => {
  const control = s.createSniffControl({ global: true, tabs: [4, 5] })
  const snapshot = control.snapshot()
  // Spread before comparing: values built inside the vm realm carry that realm's
  // Object/Array prototypes, and deepEqual compares prototypes too.
  assert.equal(snapshot.global, true)
  assert.deepEqual([...snapshot.tabs], [4, 5])
  const restored = s.createSniffControl(snapshot)
  assert.equal(restored.isPaused(4), true)
  assert.equal(restored.isGlobalPaused(), true)
  // Unknown junk in storage must not become a phantom paused tab.
  const junk = s.createSniffControl({ tabs: ['x', null, 1.5, 6] })
  assert.deepEqual([...junk.pausedTabIds()], [6])
})

test('the page menu never claims a resume it cannot perform', () => {
  // "Resume this tab" would clear the flag and leave detection off, because the
  // global layer outranks it — so under a global pause the item says so instead.
  assert.equal(s.pageMenuLabelFor('none'), 'pauseThisTab')
  assert.equal(s.pageMenuActionFor('none'), 'pauseTab')
  assert.equal(s.pageMenuLabelFor('tab'), 'resumeThisTab')
  assert.equal(s.pageMenuActionFor('tab'), 'resumeTab')
  assert.equal(s.pageMenuLabelFor('global'), 'resumeAllSites')
  assert.equal(s.pageMenuActionFor('global'), 'resumeGlobal')
  assert.equal(s.pageMenuLabelFor('both'), 'resumeAllSites')
  assert.equal(s.pageMenuActionFor('both'), 'resumeGlobal')
})

test('the toolbar menu toggles the global layer', () => {
  assert.equal(s.globalMenuLabelKey(false), 'pauseAllSites')
  assert.equal(s.globalMenuLabelKey(true), 'resumeAllSites')
})

test('a paused tab shows no count', () => {
  // A red "12" beside a blocked icon reads as "12 things blocked", which is the
  // opposite of what a pause means.
  // Spread for the same realm reason as above.
  assert.deepEqual({ ...s.toolbarVisualFor(true, 12) }, { paused: true, badgeText: '' })
  assert.deepEqual({ ...s.toolbarVisualFor(false, 12) }, { paused: false, badgeText: '12' })
  assert.deepEqual({ ...s.toolbarVisualFor(false, 0) }, { paused: false, badgeText: '' })
})

test('icon paths cover every manifest size and resolve from the extension root', () => {
  const paused = s.pausedIconPath()
  const normal = s.normalIconPath()
  assert.deepEqual(Object.keys(paused).map(Number).sort((a, b) => a - b), [16, 32, 48, 96, 128])
  for (const [size, path] of Object.entries(paused)) {
    assert.equal(path, `icon/paused-${size}.png`)
    assert.equal(path.startsWith('/'), false, 'Firefox rejects a leading slash')
  }
  for (const [size, path] of Object.entries(normal)) {
    assert.equal(path, `icon/${size}.png`)
  }
})

test('the generated paused icons exist and are not blank', () => {
  // A missing file would leave setIcon() failing silently and the toolbar stuck
  // on the active icon while the extension claims to be paused.
  for (const size of s.PAUSED_ICON_SIZES) {
    const file = new URL(`../public/icon/paused-${size}.png`, import.meta.url)
    assert.ok(fs.existsSync(file), `missing paused-${size}.png`)
    const bytes = fs.statSync(file).size
    assert.ok(bytes > 200, `paused-${size}.png looks empty (${bytes} bytes)`)
    // PNG signature, so a stray text file cannot pass this check.
    const head = fs.readFileSync(file).subarray(0, 8)
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }
})

test('background wires both menus and honours the global layer', () => {
  const source = read('entrypoints/background.ts')
  // A menu created only in onInstalled disappears on a Firefox restart, so it is
  // also created from the worker's own start-up path.
  assert.match(source, /ensureSniffMenus\(\)/)
  assert.match(source, /contexts: \['page', 'frame'\]/)
  assert.match(source, /contexts: \[actionContext\]/)
  // MV2 spells the toolbar context differently from MV3.
  assert.match(source, /firefox \? 'browser_action' : 'action'/)
  // Both funnel guards consult the combined pause check, not just the tab set.
  assert.match(source, /if \(sniffControl\.isPaused\(tabId\)\) return/)
  // Pausing has to abort in-flight header reads; otherwise "paused" still issues
  // requests to the page's media servers.
  assert.match(source, /if \(msg\.paused === true\) cancelHeaderProbes\(tabId\)/)
  assert.match(source, /cancelAllHeaderProbes\(\)/)
})

test('the panel cannot resume a global pause by accident', () => {
  const source = read('entrypoints/popup/App.vue')
  // Clicking the per-tab button while everything is off explains where the real
  // switch is instead of guessing which layer the user meant.
  assert.match(source, /if \(globalPaused\.value\) \{\s*showToastMsg\(t\('pauseAllHint'\)\)/)
  assert.match(source, /SET_GLOBAL_SNIFFING|SNIFF_STATE_CHANGED/)
  // The empty state distinguishes the two reasons detection is off.
  assert.match(source, /globalPaused \? 'emptyGlobalPausedHint' : 'emptyPausedHint'/)
})
