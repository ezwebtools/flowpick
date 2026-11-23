import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../utils/message-response.ts', import.meta.url), 'utf8')
const context = { exports: {}, console }
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context)
const { withMessageResponse } = context.exports
const flush = () => new Promise(resolve => setImmediate(resolve))

test('old Chromium receives literal true followed by an asynchronous callback', async () => {
  let finish
  const replies = []
  const listener = withMessageResponse(() => new Promise(resolve => { finish = resolve }))
  assert.equal(listener({}, {}, value => replies.push(value)), true)
  assert.equal(replies.length, 0)
  finish({ ok: true })
  await flush()
  assert.equal(replies.length, 1)
  assert.equal(replies[0].ok, true)
})

test('both thrown and rejected failures produce one explicit response', async () => {
  for (const handle of [() => { throw new Error('failed') }, () => Promise.reject(new Error('failed'))]) {
    const replies = []
    withMessageResponse(handle)({}, {}, value => replies.push(value))
    await flush()
    assert.equal(replies.length, 1)
    assert.equal(replies[0].ok, false)
    assert.match(replies[0].error, /failed/)
  }
})

test('synchronous acknowledgements work and unrelated messages remain unclaimed', async () => {
  const replies = []
  const reply = value => replies.push(value)
  assert.equal(withMessageResponse(() => undefined)({}, {}, reply), undefined)
  assert.equal(withMessageResponse(() => ({ ok: true }))({}, {}, reply), true)
  await flush()
  assert.equal(replies.length, 1)
  assert.equal(replies[0].ok, true)
})