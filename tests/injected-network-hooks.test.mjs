import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// Exercise the actual hook installer without booting the unrelated DOM/MSE
// observers in this WXT unlisted entrypoint.
const source = readFileSync(new URL('../entrypoints/injected.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('injected.ts', source, ts.ScriptTarget.Latest, true)
let installer
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'installNetworkHooks') installer = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(installer, 'network hook installer exists')
const compiled = ts.transpileModule(installer, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function install(hostname) {
  const requests = []
  const parsed = []
  const response = { ok: true, clone: () => ({ json: async () => ({ data: { id: 1 } }) }) }
  const nativePromise = Promise.resolve(response)
  function nativeFetch(...args) { requests.push({ receiver: this, args }); return nativePromise }
  class XHR {
    open(...args) { this.openArgs = args }
    send(...args) { this.sendArgs = args }
    addEventListener(type, listener) { this.listeners ??= {}; this.listeners[type] = listener }
  }
  const nativeOpen = XHR.prototype.open
  const nativeSend = XHR.prototype.send
  const window = { fetch: nativeFetch }
  const context = vm.createContext({
    window, location: { hostname, href: `https://${hostname}/` },
    isBilibiliPage: /(^|\.)bilibili\.com$/i.test(hostname),
    originalFetch: nativeFetch, XMLHttpRequest: XHR, URL, Request,
    checkPage() {}, tryDetect() {},
    getBilibiliRouteKey: () => '/video/example',
    pageIdentity: value => value,
    isDouyinMediaApi: value => /\/aweme\/.*detail/.test(value),
    parseBilibiliPlayurl: (...args) => parsed.push(args),
    parseDouyinAwemeResponse: (...args) => parsed.push(args),
  })
  vm.runInContext(`${compiled}\ninstallNetworkHooks()`, context)
  return { window, XHR, nativeFetch, nativeOpen, nativeSend, nativePromise, response, requests, parsed }
}

test('ordinary sites keep their original Fetch and XHR functions', async () => {
  for (const hostname of ['chatgpt.com', 'example.org', 'youtube.com', 'douyin.com.example.org', 'notbilibili.com']) {
    const env = install(hostname)
    assert.equal(env.window.fetch, env.nativeFetch, hostname)
    assert.equal(env.XHR.prototype.open, env.nativeOpen, hostname)
    assert.equal(env.XHR.prototype.send, env.nativeSend, hostname)
    const options = { method: 'POST', body: 'event' }
    assert.equal(env.window.fetch('/ces/v1/rgstr', options), env.nativePromise)
    assert.equal(env.requests[0].args[1], options)
  }
})

test('supported platforms still parse Fetch API responses and return the original response', async () => {
  for (const [hostname, url] of [
    ['www.bilibili.com', 'https://api.bilibili.com/x/player/playurl'],
    ['www.douyin.com', 'https://www.douyin.com/aweme/v1/web/aweme/detail/'],
    ['www.iesdouyin.com', 'https://www.iesdouyin.com/aweme/v1/aweme/detail/'],
  ]) {
    const env = install(hostname)
    assert.notEqual(env.window.fetch, env.nativeFetch)
    const options = { credentials: 'include' }
    assert.equal(await env.window.fetch(url, options), env.response)
    assert.equal(env.requests.length, 1)
    assert.equal(env.requests[0].args[0], url)
    assert.equal(env.requests[0].args[1], options)
    assert.equal(env.parsed.length, 1)
    assert.equal(env.parsed[0][1], url)
  }
})

test('platform hooks forward unrelated Fetch calls without replacing their promise', () => {
  const env = install('www.bilibili.com')
  assert.equal(env.window.fetch('/ordinary-api'), env.nativePromise)
  assert.equal(env.parsed.length, 0)
})

test('supported platform XHR hooks preserve arguments and parse successful responses', () => {
  const env = install('www.bilibili.com')
  const xhr = new env.XHR()
  const url = 'https://api.bilibili.com/x/player/playurl'
  xhr.open('GET', url, true)
  xhr.send(null)
  assert.deepEqual(xhr.openArgs, ['GET', url, true])
  assert.deepEqual(xhr.sendArgs, [null])
  xhr.status = 200
  xhr.responseText = '{"data":{"id":1}}'
  xhr.listeners.load.call(xhr)
  assert.equal(env.parsed.length, 1)
  assert.equal(env.parsed[0][1], url)
})
