import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {}, URL }
vm.runInNewContext(compile(read('utils/instagram-media.ts')), module)
const { normalizeInstagramMediaUrl } = module.exports
const player = { exports: {}, URL, require: () => module.exports }
vm.runInNewContext(compile(read('utils/instagram-player.ts')), player)
const page = 'https://www.instagram.com/reels/Example-/'
const full = 'https://scontent-itm1-1.cdninstagram.com/o1/v/t2/f2/m86/video.mp4?efg=encoded%3D&oh=sig%2fAb+Cd&oe=expiry'
const index = full + '&bytestart=893&byteend=960'

test('Instagram byte-query indexes resolve to a full track without changing signed query bytes', () => {
  assert.equal(normalizeInstagramMediaUrl(index, page), full)
  assert.equal(normalizeInstagramMediaUrl(full + '&bytestart=0&byteend=892#media'), full + '#media')
  assert.equal(normalizeInstagramMediaUrl(full), full)
  assert.equal(normalizeInstagramMediaUrl('https://cdninstagram.com/video.mp4?bytestart=0&byteend=67'), 'https://cdninstagram.com/video.mp4')
})

test('unrelated CDNs, spoofed domains, non-MP4s and Facebook pages keep their URLs', () => {
  for (const value of [
    'https://cdn.example/video.mp4?bytestart=0&byteend=67',
    'https://cdninstagram.com.evil.example/video.mp4?bytestart=0&byteend=67',
    'https://scontent.cdninstagram.com/image.jpg?bytestart=0&byteend=67',
    'https://scontent.fbcdn.net/video.mp4?bytestart=0&byteend=67',
    'not a URL',
  ]) assert.equal(normalizeInstagramMediaUrl(value), value)
  const facebookCdn = 'https://scontent.fbcdn.net/video.mp4?oh=signature&bytestart=0&byteend=67'
  assert.equal(normalizeInstagramMediaUrl(facebookCdn, 'https://www.facebook.com/'), facebookCdn)
  assert.equal(normalizeInstagramMediaUrl(facebookCdn, page), 'https://scontent.fbcdn.net/video.mp4?oh=signature')
})

const source = read('entrypoints/background.ts')
const ast = ts.createSourceFile('background.ts', source, ts.ScriptTarget.Latest, true)
const declarations = new Map()
let headersHandler
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast))
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'browser.webRequest.onHeadersReceived.addListener') {
    headersHandler = node.arguments[0].getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(headersHandler)
function backend() {
  const seenSizes = []
  const env = {
    URL, normalizeInstagramMediaUrl, instagramTrackIdentity: player.exports.instagramTrackIdentity,
    tabPageUrls: new Map([[1, page]]), tabPageTitles: new Map([[1, 'Instagram Reel']]),
    tabMap: new Map(), recentMedia: new Map(), bilibiliManagedUrls: new Map(), platformManagedUrls: new Map(),
    currentSettings: { maxItems: 1000 },
    pendingRequestHeaders: new Map(), pendingRequestSessions: new Map(), processedRequests: new Set(),
    pageSessions: { matchesDocument: () => true }, isMediaSegmentRequest: () => false,
    isBilibiliTab: () => false, isPotentialMediaRequest: () => true,
    isDomainExcluded: () => false, isFormatAllowed: () => true,
    isSizeAllowed: (_format, size) => { seenSizes.push(size); return size === undefined || size > 100_000 },
    detectMedia: () => 'mp4', detectMediaFromContentType: () => 'mp4',
    getStreamResourceIdentity: () => null,
    saveTabList: async () => {}, updateBadge() {}, broadcastDebounced() {}, tryGroupVideoAudio() {},
  }
  env.addProcessedRequest = key => env.processedRequests.add(key)
  vm.runInNewContext(compile([
    declarations.get('mergeCapturedRequestHeaders'), declarations.get('addMedia'),
    `const onHeaders = ${headersHandler}`,
    'this.onHeaders = onHeaders; this.addMedia = addMedia;',
  ].join('\n')), env)
  return { env, seenSizes }
}
const details = (url = index, headers = []) => ({
  url, tabId: 1, frameId: 0, requestId: url, type: 'xmlhttprequest', statusCode: 200,
  responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '68' }, ...headers],
})

test('actual response handler retains tiny HTTP 200 indexes as one full resource with unknown size', () => {
  const { env, seenSizes } = backend()
  env.pendingRequestHeaders.set(index, { referer: page })
  env.onHeaders(details())
  env.onHeaders(details(full + '&bytestart=1000&byteend=1999'))
  const list = env.tabMap.get(1)
  assert.equal(list.size, 1)
  assert.equal(list.has(full), true)
  assert.equal(list.get(full).size, undefined)
  assert.equal(list.get(full).requestHeaders.referer, page)
  assert.equal(list.get(full).contentType, 'video/mp4')
  assert.deepEqual(seenSizes, [undefined])
})

test('actual response handler uses Content-Range total and retains generic partial-response filtering', () => {
  const { env } = backend()
  env.onHeaders(details(index, [{ name: 'Content-Range', value: 'bytes 893-960/1870699' }]))
  assert.equal(env.tabMap.get(1).get(full).size, 1870699)
  const ordinary = 'https://cdn.example/video.mp4'
  env.onHeaders(details(ordinary, [{ name: 'Content-Range', value: 'bytes 893-960/1870699' }]))
  assert.equal(env.tabMap.get(1).has(ordinary), false)
})

test('DOM/media-message entrypoints also normalize and merge byte-query aliases without a fragment size', () => {
  const { env } = backend()
  env.addMedia(index, 1, 'mp4', 68)
  env.addMedia(full + '&bytestart=1000&byteend=2000', 1, 'mp4', 1001)
  assert.equal(env.tabMap.get(1).size, 1)
  assert.equal(env.tabMap.get(1).get(full).size, undefined)
  env.onHeaders(details(index, [{ name: 'Content-Range', value: 'bytes 893-960/1870699' }]))
  assert.equal(env.tabMap.get(1).get(full).size, 1870699)
})

test('native requests with refreshed signatures do not reintroduce already grouped Instagram tracks', () => {
  const { env } = backend()
  env.platformManagedUrls.set(1, new Set([full]))
  env.tabMap.set(1, new Map([[full, { format: 'mp4', groupRole: 'variant' }]]))
  const alias = full.replace('scontent-itm1-1', 'scontent-other').replace('sig%2fAb+Cd', 'new-signature')
  env.addMedia(alias + '&bytestart=893&byteend=960', 1, 'mp4', 68)
  assert.equal(env.tabMap.get(1).size, 1)
  assert.equal(env.tabMap.get(1).has(alias), false)
})
