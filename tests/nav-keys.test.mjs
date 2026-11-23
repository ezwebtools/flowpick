import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const mod = { exports: {} }
vm.runInNewContext(compile(read('entrypoints/popup/utils/nav-keys.ts')), mod)
const { resolveNavAction, isTypingTarget } = mod.exports

// The module runs in a separate realm, so its object literals have a different
// prototype than this file's. Compare values, not identities.
const key = (value, extra = {}) => JSON.parse(JSON.stringify(resolveNavAction({ key: value, ...extra })))

test('typing targets keep their own keys', () => {
  assert.equal(isTypingTarget('INPUT', false, 'text'), true)
  assert.equal(isTypingTarget('INPUT', false, 'checkbox'), false)
  assert.equal(isTypingTarget('TEXTAREA'), true)
  assert.equal(isTypingTarget('SELECT'), true)
  assert.equal(isTypingTarget('DIV', true), true)
  assert.equal(isTypingTarget('DIV'), false)
})

test('arrows move the selection and never fight a text field', () => {
  assert.deepEqual(key('ArrowDown', { hasFocus: true }), { type: 'move', step: 1 })
  assert.deepEqual(key('ArrowUp', { hasFocus: true }), { type: 'move', step: -1 })
  // Arrow keys inside the search box must move the caret, not the list.
  assert.deepEqual(key('ArrowDown', { typing: true, hasFocus: true }), { type: 'none' })
})

test('Home and End jump far enough to clamp to either end', () => {
  const home = key('Home', { hasFocus: true })
  assert.equal(home.type, 'move')
  assert.ok(home.step < -1000)
  const end = key('End', { hasFocus: true })
  assert.equal(end.type, 'move')
  assert.ok(end.step > 1000)
})

test('row actions need a focused row', () => {
  assert.deepEqual(key(' ', { hasFocus: false }), { type: 'none' })
  assert.deepEqual(key('D', { hasFocus: false }), { type: 'none' })
  assert.deepEqual(key(' ', { hasFocus: true }), { type: 'toggle' })
  assert.deepEqual(key('d', { hasFocus: true }), { type: 'download' })
  assert.deepEqual(key('C', { hasFocus: true }), { type: 'copy' })
  assert.deepEqual(key('Enter', { hasFocus: true }), { type: 'preview' })
})

test('a focused button keeps Space and Enter for itself', () => {
  // Tabbing to the download button and pressing Space must click it, not
  // toggle the row underneath it.
  assert.deepEqual(key(' ', { hasFocus: true, controlHandlesActivation: true }), { type: 'none' })
  assert.deepEqual(key('Enter', { hasFocus: true, controlHandlesActivation: true }), { type: 'none' })
})

test('slash focuses search but is ignored while typing', () => {
  assert.deepEqual(key('/'), { type: 'search' })
  assert.deepEqual(key('/', { typing: true }), { type: 'none' })
})

test('question mark opens the cheatsheet, but not while typing', () => {
  // "?" needs Shift on most layouts, so shiftKey must not cancel it.
  assert.deepEqual(key('?', { shiftKey: true }), { type: 'help' })
  assert.deepEqual(key('?', { typing: true }), { type: 'none' })
  // Ctrl/Cmd+? is a browser shortcut and stays with the browser.
  assert.deepEqual(key('?', { ctrlKey: true }), { type: 'none' })
})

test('escape leaves a text field to the browser, then unwinds the view', () => {
  // Blurring the field is an explicit action: the query text must survive so
  // the user can come back to it.
  assert.deepEqual(key('Escape', { typing: true }), { type: 'blur' })
  assert.deepEqual(key('Escape'), { type: 'escape' })
})

test('browser and OS shortcuts win over list navigation', () => {
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
    assert.deepEqual(key('d', { hasFocus: true, [modifier]: true }), { type: 'none' }, modifier)
    // Ctrl+F/Cmd+F must still open the browser's find, not ours.
    assert.deepEqual(key('/', { [modifier]: true }), { type: 'none' }, modifier)
  }
})

test('an already handled key is not handled twice', () => {
  assert.deepEqual(key('Escape', { defaultPrevented: true }), { type: 'none' })
  assert.deepEqual(key('ArrowDown', { hasFocus: true, defaultPrevented: true }), { type: 'none' })
})
