import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const module = { exports: {} }
vm.runInNewContext(compile(read('utils/media-header.ts')), module)
const {
  probeContainerHeader, containerProbeFormat,
  HEADER_WINDOW_BYTES, TAIL_WINDOW_BYTES, MAX_FOLLOW_UP_BYTES,
} = module.exports

// ── ISO BMFF builders ────────────────────────────────────────────────────

const u32 = value => new Uint8Array([
  (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
])
const u64 = value => {
  const high = Math.floor(value / 0x100000000)
  const low = value >>> 0
  return new Uint8Array([...u32(high), ...u32(low)])
}
const ascii = text => new Uint8Array([...text].map(character => character.charCodeAt(0)))
const concat = parts => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}
const box = (type, ...payload) => {
  const body = concat(payload)
  return concat([u32(body.length + 8), ascii(type), body])
}
const largeBox = (type, ...payload) => {
  const body = concat(payload)
  return concat([u32(1), ascii(type), u64(body.length + 16), body])
}

function mvhdV0(timescale, duration) {
  return box('mvhd', new Uint8Array([0, 0, 0, 0]),
    u32(0), u32(0), u32(timescale), u32(duration), ...Array.from({ length: 80 }, () => u32(0)))
}
function mvhdV1(timescale, duration) {
  return box('mvhd', new Uint8Array([1, 0, 0, 0]),
    u64(0), u64(0), u32(timescale), u64(duration), ...Array.from({ length: 80 }, () => u32(0)))
}
function tkhdV0(width, height) {
  const lead = concat([new Uint8Array([0, 0, 0, 0]), u32(0), u32(0), u32(1), u32(0), u32(0)])
  const matrix = concat(Array.from({ length: 9 }, () => u32(0)))
  return box('tkhd', lead, u32(0), u32(0), u32(0), u32(0), matrix, u32(width * 65536), u32(height * 65536))
}
function tkhdV1(width, height) {
  const lead = concat([new Uint8Array([1, 0, 0, 0]), u64(0), u64(0), u32(1), u32(0), u64(0)])
  const matrix = concat(Array.from({ length: 9 }, () => u32(0)))
  return box('tkhd', lead, u32(0), u32(0), u32(0), u32(0), matrix, u32(width * 65536), u32(height * 65536))
}
const ftyp = () => box('ftyp', ascii('isom'), u32(512), ascii('isomiso2'))
const mdat = size => box('mdat', new Uint8Array(size))

// ── EBML builders ────────────────────────────────────────────────────────

const ebmlId = id => u32(id).slice(4 - (id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1))
const ebmlSize = value => {
  for (let length = 1; length <= 8; length++) {
    const max = 2 ** (7 * length) - 2
    if (value <= max) {
      const bytes = new Uint8Array(length)
      let rest = value
      for (let i = length - 1; i >= 0; i--) { bytes[i] = rest & 0xff; rest = Math.floor(rest / 256) }
      bytes[0] |= 0x80 >> (length - 1)
      return bytes
    }
  }
  throw new Error('EBML size too large')
}
const ebml = (id, ...payload) => {
  const body = concat(payload)
  return concat([ebmlId(id), ebmlSize(body.length), body])
}
const ebmlUint = (id, value, width = 4) => {
  const bytes = new Uint8Array(width)
  let rest = value
  for (let i = width - 1; i >= 0; i--) { bytes[i] = rest & 0xff; rest = Math.floor(rest / 256) }
  return concat([ebmlId(id), ebmlSize(width), bytes])
}
const ebmlFloat = (id, value) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value)
  return concat([ebmlId(id), ebmlSize(8), bytes])
}
const ebmlHeader = () => ebml(0x1a45dfa3, ebmlUint(0x4286, 1, 1), ebmlUint(0x42f7, 1, 1))

// ── Tests ────────────────────────────────────────────────────────────────

test('only containers with a parseable header are probed', () => {
  for (const format of ['mp4', 'MP4', '.mp4', 'm4v', 'mov', 'm4a', '3gp']) {
    assert.equal(containerProbeFormat(format), 'iso-bmff', format)
  }
  for (const format of ['webm', 'mkv', 'WEBM']) {
    assert.equal(containerProbeFormat(format), 'ebml', format)
  }
  for (const format of ['m3u8', 'mpd', 'flv', 'ts', 'mse', 'jpg', 'mp3', '']) {
    assert.equal(containerProbeFormat(format), null, format)
  }
})

test('faststart MP4 yields duration and display dimensions', () => {
  const bytes = concat([
    ftyp(),
    box('moov', mvhdV0(1000, 5000), box('trak', tkhdV0(1920, 1080))),
    mdat(64),
  ])
  const verdict = probeContainerHeader(bytes, 'mp4')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 5)
  assert.equal(verdict.metadata.width, 1920)
  assert.equal(verdict.metadata.height, 1080)
})

test('64-bit mvhd and tkhd are read with their version-specific offsets', () => {
  const bytes = concat([
    ftyp(),
    box('moov', mvhdV1(90000, 90000 * 42), box('trak', tkhdV1(3840, 2160))),
  ])
  const verdict = probeContainerHeader(bytes, 'mp4')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 42)
  assert.equal(verdict.metadata.width, 3840)
  assert.equal(verdict.metadata.height, 2160)
})

test('audio-only MP4 reports duration without inventing dimensions', () => {
  const bytes = concat([ftyp(), box('moov', mvhdV0(44100, 44100 * 3))])
  const verdict = probeContainerHeader(bytes, 'm4a')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 3)
  assert.equal(verdict.metadata.width, undefined)
  assert.equal(verdict.metadata.height, undefined)
})

test('media data that runs past the window asks for the tail', () => {
  // mdat is larger than the buffer, so moov cannot be inside this window.
  const bytes = concat([ftyp(), u32(200_000), ascii('mdat'), new Uint8Array(64)])
  assert.equal(probeContainerHeader(bytes, 'mp4').kind, 'need-tail')
})

test('a small file with moov after mdat is still answered from one window', () => {
  // Both boxes fit: no point spending a second request on the tail.
  const bytes = concat([ftyp(), mdat(256), box('moov', mvhdV0(1000, 7000))])
  const verdict = probeContainerHeader(bytes, 'mp4')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 7)
})

test('moov split by the window boundary produces an exact follow-up range', () => {
  const moov = box('moov', mvhdV0(1000, 9000), box('trak', tkhdV0(1280, 720)))
  const full = concat([ftyp(), moov])
  // ftyp is 24 bytes; a 40-byte window holds the moov header but not its body.
  const head = full.slice(0, 40)
  const verdict = probeContainerHeader(head, 'mp4')
  assert.equal(verdict.kind, 'need-range')
  // Offsets are absolute and identify the whole box, not just its header.
  assert.equal(verdict.start, 24)
  assert.equal(verdict.end, 24 + moov.length)

  const span = full.slice(verdict.start, verdict.end)
  const second = probeContainerHeader(span, 'mp4', verdict.start)
  assert.equal(second.kind, 'found')
  assert.equal(second.metadata.duration, 9)
  assert.equal(second.metadata.width, 1280)
  assert.equal(second.metadata.height, 720)
})

test('tail scan finds moov after mdat and keeps absolute offset handling honest', () => {
  const file = concat([ftyp(), mdat(50_000), box('moov', mvhdV0(600, 12_000), box('trak', tkhdV0(640, 480)))])
  const tailStart = file.length - TAIL_WINDOW_BYTES
  const tail = file.slice(Math.max(0, tailStart))
  const verdict = probeContainerHeader(tail, 'mp4', Math.max(0, tailStart), 'tail')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 20)
  assert.equal(verdict.metadata.width, 640)
  assert.equal(verdict.metadata.height, 480)
})

test('a 64-bit largest-size moov header does not derail the walk', () => {
  const moov = largeBox('moov', mvhdV0(1000, 2500))
  const verdict = probeContainerHeader(concat([ftyp(), moov]), 'mp4')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 2.5)
})

test('garbage and truncated buffers are reported as unknown, never thrown', () => {
  assert.equal(probeContainerHeader(new Uint8Array(0), 'mp4').kind, 'unknown')
  assert.equal(probeContainerHeader(new Uint8Array([1, 2, 3]), 'mp4').kind, 'unknown')
  // A single absurd size field is not a parsed box, so there is nothing to say.
  assert.equal(probeContainerHeader(u32(4096), 'mp4').kind, 'unknown')
  // Real boxes with no answer yet are worth one tail request instead of a shrug.
  assert.equal(probeContainerHeader(concat([ftyp(), box('mdat')]), 'mp4').kind, 'need-tail')
  // Zero-length mdat must not spin the walk on a null box size.
  assert.equal(probeContainerHeader(concat([ftyp(), box('mdat')]), 'mp4').kind, 'need-tail')
})

test('WebM yields duration scaled by TimecodeScale plus pixel dimensions', () => {
  // TimecodeScale is nanoseconds per tick; 1e6 (1 ms) with 30000 ticks = 30 s.
  const segment = ebml(0x18538067,
    ebml(0x1549a966, ebmlUint(0x2ad7b1, 1_000_000), ebmlFloat(0x4489, 30_000)),
    ebml(0x1654ae6b,
      ebml(0xae, ebml(0xe0, ebmlUint(0xb0, 1920, 2), ebmlUint(0xba, 1080, 2)))),
  )
  const verdict = probeContainerHeader(concat([ebmlHeader(), segment]), 'webm')
  assert.equal(verdict.kind, 'found')
  assert.equal(verdict.metadata.duration, 30)
  assert.equal(verdict.metadata.width, 1920)
  assert.equal(verdict.metadata.height, 1080)
})

test('WebM honours a non-default TimecodeScale', () => {
  const segment = ebml(0x18538067,
    ebml(0x1549a966, ebmlUint(0x2ad7b1, 1_000), ebmlFloat(0x4489, 8000)),
  )
  const verdict = probeContainerHeader(concat([ebmlHeader(), segment]), 'mkv')
  assert.equal(verdict.kind, 'found')
  // 8000 ticks at 1000 ns = 8 ms — the point is that the scale is applied.
  assert.equal(verdict.metadata.duration, 0.008)
})

test('a WebM tail window is not misread as a header', () => {
  const segment = ebml(0x18538067, ebml(0x1549a966, ebmlUint(0x2ad7b1, 1_000_000), ebmlFloat(0x4489, 1000)))
  const bytes = concat([ebmlHeader(), segment])
  assert.equal(probeContainerHeader(bytes, 'webm', 0, 'tail').kind, 'unknown')
})

test('stream and image formats are explicitly unsupported', () => {
  for (const format of ['m3u8', 'mpd', 'flv', 'ts', 'jpg', 'mp3']) {
    assert.equal(probeContainerHeader(new Uint8Array(64), format).kind, 'unsupported', format)
  }
})

test('probe budgets stay small enough to be a cheap background request', () => {
  assert.equal(HEADER_WINDOW_BYTES, 131_072)
  assert.equal(TAIL_WINDOW_BYTES, 131_072)
  assert.ok(MAX_FOLLOW_UP_BYTES <= 8 * 1024 * 1024)
})
