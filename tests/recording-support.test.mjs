import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../utils/recording-support.ts', import.meta.url), 'utf8')
const context = vm.createContext({})
vm.runInContext(ts.transpileModule(source.replace('export function', 'function'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context)

test('Firefox and Gecko-based forks cannot record', () => {
  for (const ua of [
    'Mozilla/5.0 Gecko/20100101 Firefox/143.0',
    'Mozilla/5.0 Gecko/20100101 Waterfox/6.5',
    'LibreWolf', 'Floorp', 'Zen/1.0', 'FxiOS/143.0',
    'Mozilla/5.0 Gecko/20100101 CustomBrowser/1.0',
  ]) assert.equal(context.isFirefoxFamily(ua), true, ua)
})

test('Chrome, Edge and other non-Firefox UAs are not misidentified', () => {
  for (const ua of [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0 Safari/537.36',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0 Safari/537.36 Edg/143.0',
    'Mozilla/5.0 AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  ]) assert.equal(context.isFirefoxFamily(ua), false, ua)
})
