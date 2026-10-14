import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const code = ts.transpileModule(fs.readFileSync(new URL('../utils/proxy-context-gate.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const context = { exports: {}, URL, DOMException, Promise }
vm.runInNewContext(code, context)
const { ProxyContextGate } = context.exports

test('matching contexts remain parallel; different headers on the same host wait', async () => {
  const gate = new ProxyContextGate(), signal = new AbortController().signal
  const a = await gate.acquire('https://cdn.example/one', 'referer-a', signal)
  const a2 = await gate.acquire('https://cdn.example/two', 'referer-a', signal)
  let started = false
  const waiting = gate.acquire('https://cdn.example/three', 'referer-b', signal).then(release => { started = true; return release })
  await Promise.resolve(); assert.equal(started, false)
  a(); await Promise.resolve(); assert.equal(started, false)
  a2(); const b = await waiting; assert.equal(started, true); b()
})
test('aborting a waiting header context does not leak or block the next context', async () => {
  const gate = new ProxyContextGate(), signal = new AbortController().signal
  const a = await gate.acquire('https://cdn.example/one', 'a', signal)
  const controller = new AbortController()
  const cancelled = gate.acquire('https://cdn.example/two', 'b', controller.signal)
  controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' })
  const next = gate.acquire('https://cdn.example/three', 'c', signal)
  a(); const release = await next; release()
  const other = await gate.acquire('https://other.example/one', 'd', signal); other()
})
