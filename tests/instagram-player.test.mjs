import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { DOMParser } from '@xmldom/xmldom'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const normalization = { exports: {}, URL }
vm.runInNewContext(compile(read('utils/instagram-media.ts')), normalization)
const env = { exports: {}, URL, DOMParser, require: () => normalization.exports }
vm.runInNewContext(compile(read('utils/instagram-player.ts')), env)
const parser = env.exports
const page = 'https://www.instagram.com/reels/Example-/'
const video = 'https://scontent.cdninstagram.com/video.mp4?oh=signature'
const audio = 'https://scontent.fbcdn.net/audio.mp4?oh=audio-signature'
const manifest = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>
  <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f"><Representation id="v1" width="720" height="1280" bandwidth="1100000">
    <BaseURL>${video}&amp;bytestart=893&amp;byteend=960</BaseURL><SegmentBase indexRange="893-960"><Initialization range="0-892" /></SegmentBase>
  </Representation></AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" lang="en"><Representation id="a1" codecs="mp4a.40.2" bandwidth="128000">
    <BaseURL>${audio}</BaseURL><SegmentBase indexRange="800-900" />
  </Representation></AdaptationSet>
</Period></MPD>`
const media = (code = 'Example-', xml = manifest) => ({ pk: code + '-id', code, video_duration: 12,
  caption: { text: 'Example Reel' }, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/cover.jpg' }] },
  video_dash_manifest: xml,
})

test('per-Reel DASH metadata pairs complete video and audio URLs without fetching byte indexes', () => {
  const tasks = parser.extractInstagramMediaTasks({ data: { edges: [{ node: { media: media() } }] } }, page)
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.title, 'Example Reel')
  assert.equal(task.duration, 12)
  assert.equal(task.candidates.find(item => item.role === 'video').url, video)
  assert.equal(task.candidates.find(item => item.role === 'video').height, 1280)
  assert.equal(task.candidates.find(item => item.role === 'audio').url, audio)
})

test('feed preloads and delayed responses never pair a neighboring Reel or carry over an old route', () => {
  const payload = { items: [media('Neighbor'), media()] }
  assert.equal(parser.extractInstagramMediaTasks(payload, page).length, 1)
  assert.equal(parser.extractInstagramMediaTasks({ items: [media('Neighbor')] }, page).length, 0)
  const next = page.replace('Example-', 'Neighbor')
  assert.equal(parser.extractInstagramMediaTasks(payload, next)[0].key, 'Neighbor-id')
  assert.equal(parser.extractInstagramMediaTasks(payload, 'https://instagram.com.evil.example/').length, 0)
})

test('video-only, protected, segmented and multi-period manifests are never paired with unrelated audio', () => {
  const videoOnly = manifest.replace(/<AdaptationSet mimeType="audio[\s\S]*?<\/AdaptationSet>/, '')
  for (const xml of [videoOnly, manifest.replace('<Period>', '<Period><ContentProtection schemeIdUri="drm"/>'),
    manifest.replace('<Period>', '<Period><SegmentTemplate media="$Number$.m4s"/>'),
    manifest.replace('</MPD>', '<Period /></MPD>')]) {
    assert.equal(parser.extractInstagramMediaTasks(media('Example-', xml), page).length, 0)
  }
  assert.equal(parser.parseInstagramDash('<!DOCTYPE MPD><MPD />', page).length, 0)
})

test('only Instagram media API endpoints and trusted media CDNs are accepted', () => {
  assert.equal(parser.isInstagramMediaApi('/graphql/query/'), true)
  assert.equal(parser.isInstagramMediaApi('https://www.instagram.com/api/v1/clips/item/'), true)
  assert.equal(parser.isInstagramMediaApi('https://instagram.com.evil.example/graphql/query/'), false)
  assert.equal(parser.isInstagramMediaApi('https://www.instagram.com/static/script.js'), false)
  assert.equal(parser.isAllowedInstagramMediaUrl(video), true)
  assert.equal(parser.isAllowedInstagramMediaUrl('https://cdninstagram.com.evil.example/video.mp4'), false)
})

test('Relay hydration, streamed GraphQL lines and JSON XHR share the same parsing path', () => {
  const hydration = { require: [['RelayPrefetchedStreamCache', null, [], [{ __bbox: { result: { data: { media: media() } } } }]]] }
  const payloads = parser.parseInstagramPayloadText('for (;;);' + JSON.stringify(hydration))
  assert.equal(parser.extractInstagramMediaTasks(payloads[0], page).length, 1)
  assert.equal(parser.parseInstagramPayloadText('{"first":1}\n{"second":2}').length, 2)
  assert.equal(parser.parseInstagramPayloadText('not JSON').length, 0)
})

const background = read('entrypoints/background.ts')
const ast = ts.createSourceFile('background.ts', background, ts.ScriptTarget.Latest, true)
const declarations = new Map()
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast))
  ts.forEachChild(node, visit)
}
visit(ast)

test('background accepts only Instagram-owned tasks and replaces raw tracks with one playable/downloadable pair', () => {
  const task = parser.extractInstagramMediaTasks(media(), page)[0]
  const mediaMap = new Map([[video, { format: 'mp4' }], [audio, { format: 'mp4' }]])
  const ctx = { URL, isAllowedInstagramMediaUrl: parser.isAllowedInstagramMediaUrl,
    instagramTrackIdentity: parser.instagramTrackIdentity,
    tabMap: new Map([[1, mediaMap]]), platformTaskPriorities: new Map(), platformManagedUrls: new Map(),
    DOUYIN_PAGE_HOST: /(^|\.)douyin\.com$/, saveTabList: async () => {}, updateBadge() {}, broadcastDebounced() {},
  }
  vm.runInNewContext(compile(declarations.get('isValidPlatformTask') + '\n' + declarations.get('upsertPlatformMediaTask')), ctx)
  assert.equal(ctx.isValidPlatformTask(task, page), true)
  assert.equal(ctx.isValidPlatformTask(task, 'https://other.example/'), false)
  assert.equal(ctx.isValidPlatformTask({ ...task, candidates: [{ url: 'https://evil.example/video.mp4', role: 'video' }, task.candidates[1]] }, page), false)
  ctx.upsertPlatformMediaTask(1, task, 'Reel')
  assert.equal(mediaMap.size, 2)
  assert.equal(mediaMap.has(audio), false)
  assert.equal(mediaMap.get(video).audioUrl, audio)
  assert.equal(mediaMap.get(video).audioOptions[0].url, audio)
  assert.equal(mediaMap.get(video).groupRole, 'variant')
  assert.equal(ctx.platformManagedUrls.get(1).has(audio), true)
})

// Sanitized from the supplied ScheduledServerJS/Relay hydration script.
const hydrationSample = read('tests/fixtures/instagram-hydration.json')
test('actual hydration shape resolves two nominal qualities to the same audio and manifest duration', () => {
  const tasks = parser.extractInstagramMediaTasks(JSON.parse(hydrationSample), page)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].duration, 13.4)
  const videos = tasks[0].candidates.filter(item => item.role === 'video')
  const audios = tasks[0].candidates.filter(item => item.role === 'audio')
  assert.deepEqual(Array.from(videos, item => item.label), ['720p', '360p'])
  assert.deepEqual(Array.from(videos, item => item.height), [718, 358])
  assert.equal(audios.length, 1)
})

test('all qualities share one audio while differently signed raw tracks collapse into the group', () => {
  const task = parser.extractInstagramMediaTasks(JSON.parse(hydrationSample), page)[0]
  const tracks = task.candidates.map(item => item.url)
  const alias = url => url.replace('scontent.cdninstagram.com', 'scontent-alt.cdninstagram.com').replace('sample-signature', 'refreshed-signature')
  const mediaMap = new Map(tracks.map(url => [alias(url), { format: 'mp4' }]))
  const progressive = tracks[0] + '&vs=progressive&_nc_vs=audio-recipe'
  mediaMap.set(progressive, { format: 'mp4' })
  const ctx = { URL, instagramTrackIdentity: parser.instagramTrackIdentity,
    tabMap: new Map([[1, mediaMap]]), platformTaskPriorities: new Map(), platformManagedUrls: new Map(),
    saveTabList: async () => {}, updateBadge() {}, broadcastDebounced() {},
  }
  vm.runInNewContext(compile(declarations.get('upsertPlatformMediaTask')), ctx)
  ctx.upsertPlatformMediaTask(1, task, 'Reel')
  const audioUrl = task.candidates.find(item => item.role === 'audio').url
  for (const video of task.candidates.filter(item => item.role === 'video')) {
    assert.equal(mediaMap.get(video.url).audioUrl, audioUrl)
    assert.equal(mediaMap.has(alias(video.url)), false)
  }
  assert.equal(mediaMap.has(alias(audioUrl)), false)
  assert.equal(mediaMap.has(progressive), true)
  assert.equal(ctx.platformManagedUrls.get(1).has(alias(audioUrl)), true)
})

test('list download hands the explicitly paired audio to the existing merger', async () => {
  const popup = read('entrypoints/popup/App.vue').split('</script>')[0].replace('<script lang="ts" setup>', '')
  const tree = ts.createSourceFile('App.ts', popup, ts.ScriptTarget.Latest, true)
  let download
  const find = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'downloadUrl') download = node.getText(tree)
    ts.forEachChild(node, find)
  }
  find(tree)
  assert.ok(download)
  const sent = []
  const ctx = { exports: {}, mediaByUrl: { value: new Map([[video, { audioUrl: audio }]]) },
    getDownloadName: () => 'Reel', isStreamFormat: () => false, isVideoDownloadFormat: () => true,
    browser: { runtime: { sendMessage: async message => { sent.push(structuredClone(message)); return { ok: true } } } },
  }
  vm.runInNewContext(compile(`const ${download}; exports.download = downloadUrl;`), ctx)
  ctx.exports.download(video, 'mp4', { Referer: page })
  await Promise.resolve()
  assert.equal(sent[0].url, video)
  assert.equal(sent[0].audioUrl, audio)
  assert.equal(sent[0].type, 'OPEN_DOWNLOAD_PAGE')
})
