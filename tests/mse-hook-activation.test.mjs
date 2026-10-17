import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const injected = readFileSync(new URL('../entrypoints/injected.ts', import.meta.url), 'utf8')
const activation = injected.slice(injected.indexOf('  const mseArmed ='), injected.indexOf('  pageHook.ready = true'))
const compiled = ts.transpileModule(activation.replaceAll('import.meta.env.FIREFOX', 'false'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

test('ordinary documents leave MediaSource untouched; only an armed recording installs hooks', () => {
  class Script { constructor(dataset) { this.dataset = dataset } }
  for (const [script, firefox, expected] of [
    [null, false, 0],
    [new Script({ m3u8Injected: '1' }), false, 0],
    [new Script({ flowpickMseArmed: '0' }), false, 0],
    [new Script({ flowpickMseArmed: '1' }), false, 1],
    [new Script({ flowpickMseArmed: '1' }), true, 0],
  ]) {
    let installations = 0
    vm.runInNewContext(compiled, {
      document: { currentScript: script }, HTMLScriptElement: Script,
      navigator: { userAgent: 'test' }, isFirefoxFamily: () => firefox,
      installMseProxy: () => installations++,
    })
    assert.equal(installations, expected)
  }
})

const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
const hookQuery = background.slice(background.indexOf("    if (msg.type === 'FLOWPICK_RECORDING_HOOK_STATE') {"),
  background.indexOf("    if (msg.type === 'FLOWPICK_RECORDING_SOURCE_READY') {"))
const queryCode = ts.transpileModule(`(() => { ${hookQuery} })()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

test('hook authorization belongs to the sending source tab and requires an open MSE session', () => {
  for (const [tabId, session, firefox, expected] of [
    [1, undefined, false, false],
    [1, { mode: 'mse', cancelled: false }, false, true],
    [2, { mode: 'mse', cancelled: false }, false, false],
    [undefined, { mode: 'mse', cancelled: false }, false, false],
    [1, { mode: 'mse', cancelled: true }, false, false],
    [1, { mode: 'msr', cancelled: false }, false, false],
    [1, { mode: 'mse', cancelled: false }, true, false],
  ]) {
    let result
    vm.runInNewContext(queryCode, {
      msg: { type: 'FLOWPICK_RECORDING_HOOK_STATE', sourceTabId: 1 },
      sender: { tab: tabId === undefined ? undefined : { id: tabId } },
      recordingTargetBySource: new Map([[1, 10]]),
      recordingSessionsByTarget: new Map(session ? [[10, session]] : []),
      isFirefox: firefox, sendResponse: value => { result = value },
    })
    assert.equal(result.mse, expected)
  }
})
