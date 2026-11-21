/**
 * Container-header metadata probing.
 *
 * A `<video preload="metadata">` element is the usual way to learn a clip's
 * duration and dimensions, but it needs a renderer: it decodes, allocates a
 * media pipeline per element, and dies with the page that hosts it. For plain
 * MP4/WebM files the answer is already written in the first few kilobytes of
 * the container, so a service worker can read it with one ranged request.
 *
 * The parsers below are pure functions over a byte window. They never touch
 * `browser`, `document` or `fetch`, which keeps them unit-testable and lets the
 * caller decide how many bytes to spend and when to give up.
 *
 * Absolute offsets are threaded through every function because the tail of a
 * file is fetched as its own window: a `moov` atom that lives after `mdat` can
 * only be located in a buffer that knows where it starts.
 */

export interface HeaderMetadata {
  duration?: number
  width?: number
  height?: number
}

/**
 * `need-range` is a precise follow-up request, not a failure: the parser found
 * the box it needs but the window ended before it did.
 */
export type HeaderProbe =
  | { kind: 'found'; metadata: HeaderMetadata }
  | { kind: 'need-range'; start: number; end: number }
  | { kind: 'need-tail' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' }

/** 128 KiB covers every faststart MP4 we have seen and all sane WebM headers. */
export const HEADER_WINDOW_BYTES = 131_072
/** A `moov` atom at the end of a non-faststart file is usually well under this. */
export const TAIL_WINDOW_BYTES = 131_072
/** Hard ceiling for a follow-up range request (a huge `moov` is still bounded). */
export const MAX_FOLLOW_UP_BYTES = 4 * 1024 * 1024

const ISO_BMFF_FORMATS = new Set(['mp4', 'm4v', 'mov', 'm4a', '3gp', '3g2', 'f4v', 'ismv'])
const EBML_FORMATS = new Set(['webm', 'mkv'])

export function containerProbeFormat(format: string): 'iso-bmff' | 'ebml' | null {
  const normalized = String(format || '').toLowerCase().replace(/^\./, '')
  if (ISO_BMFF_FORMATS.has(normalized)) return 'iso-bmff'
  if (EBML_FORMATS.has(normalized)) return 'ebml'
  return null
}

export function probeContainerHeader(
  bytes: Uint8Array,
  format: string,
  absoluteOffset = 0,
  region: 'head' | 'tail' = 'head',
): HeaderProbe {
  const kind = containerProbeFormat(format)
  if (kind === 'iso-bmff') return parseIsoBmff(bytes, absoluteOffset, region)
  if (kind === 'ebml') return region === 'tail' ? { kind: 'unknown' } : parseEbml(bytes)
  return { kind: 'unsupported' }
}

// ── ISO BMFF (MP4 / MOV / M4A) ───────────────────────────────────────────

interface BoxHeader {
  type: string
  /** Absolute offset of the box's first byte. */
  start: number
  /** Absolute offset just past the box. */
  end: number
  /** Absolute offset of the first payload byte. */
  payload: number
}

function readU32(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.length) return -1
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
}

function readU64(bytes: Uint8Array, at: number): number {
  const high = readU32(bytes, at)
  const low = readU32(bytes, at + 4)
  if (high < 0 || low < 0) return -1
  return high * 0x100000000 + low
}

function readBoxHeader(bytes: Uint8Array, at: number, absoluteOffset: number): BoxHeader | null {
  if (at + 8 > bytes.length) return null
  const size32 = readU32(bytes, at)
  if (size32 < 0) return null
  const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
  let headerSize = 8
  let size = size32
  if (size32 === 1) {
    if (at + 16 > bytes.length) return null
    size = readU64(bytes, at + 8)
    headerSize = 16
  } else if (size32 === 0) {
    // "To end of file": only meaningful for the last box in a complete file.
    size = bytes.length - at
  }
  if (!Number.isFinite(size) || size < headerSize) return null
  const start = absoluteOffset + at
  return {
    type,
    start,
    end: absoluteOffset + at + size,
    payload: absoluteOffset + at + headerSize,
  }
}

function iterateBoxes(
  bytes: Uint8Array,
  absoluteOffset: number,
  startAt: number,
  endAt: number,
  visit: (box: BoxHeader, payloadStart: number, payloadEnd: number) => 'stop' | 'continue' | void,
): void {
  let offset = startAt
  const limit = Math.min(endAt, bytes.length)
  while (offset + 8 <= limit) {
    const box = readBoxHeader(bytes, offset, absoluteOffset)
    if (!box) return
    const payloadStart = offset + (box.payload - box.start)
    const payloadEnd = box.end - absoluteOffset
    // A box that runs past this window is still worth visiting; the visitor
    // decides whether it can work with a truncated payload or needs more bytes.
    const visitResult = visit(box, payloadStart, Math.min(payloadEnd, bytes.length))
    if (visitResult === 'stop') return
    const nextOffset = box.end - absoluteOffset
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) return
    offset = nextOffset
  }
}

function parseMoovPayload(
  bytes: Uint8Array,
  absoluteOffset: number,
  payloadStart: number,
  payloadEnd: number,
): HeaderMetadata | null {
  let timescale: number | undefined
  let rawDuration: number | undefined
  let width: number | undefined
  let height: number | undefined
  let sawMvhd = false

  const readContainer = (start: number, end: number, onChild: (type: string, childStart: number, childEnd: number) => void) => {
    iterateBoxes(bytes, absoluteOffset, start, Math.min(end, bytes.length), (box, childStart, childEnd) => {
      onChild(box.type, childStart, childEnd)
    })
  }

  readContainer(payloadStart, payloadEnd, (type, childStart, childEnd) => {
    if (type === 'mvhd') {
      sawMvhd = true
      const version = bytes[childStart]
      if (version === 1) {
        const scale = readU32(bytes, childStart + 20)
        const duration = readU64(bytes, childStart + 24)
        if (scale > 0) timescale = scale
        if (duration >= 0) rawDuration = duration
      } else {
        const scale = readU32(bytes, childStart + 12)
        const duration = readU32(bytes, childStart + 16)
        if (scale > 0) timescale = scale
        if (duration >= 0 && duration !== 0xffffffff) rawDuration = duration
      }
      return
    }
    if (type !== 'trak' || width) return
    readContainer(childStart, childEnd, (trackType, trackStart) => {
      if (trackType !== 'tkhd' || width) return
      const version = bytes[trackStart]
      // width/height are 16.16 fixed-point display dimensions at the end of the
      // box; both versions share the trailing layout, only the lead differs.
      const dimensionOffset = version === 1 ? 88 : 76
      const boxWidth = readU32(bytes, trackStart + dimensionOffset)
      const boxHeight = readU32(bytes, trackStart + dimensionOffset + 4)
      if (boxWidth > 0 && boxHeight > 0) {
        width = Math.round(boxWidth / 65536)
        height = Math.round(boxHeight / 65536)
      }
    })
  })

  if (!sawMvhd && width === undefined) return null
  const metadata: HeaderMetadata = {}
  if (timescale && timescale > 0 && rawDuration && rawDuration > 0) {
    metadata.duration = rawDuration / timescale
  }
  if (width && height) { metadata.width = width; metadata.height = height }
  return metadata
}

function parseIsoBmff(bytes: Uint8Array, absoluteOffset: number, region: 'head' | 'tail'): HeaderProbe {
  if (region === 'tail') return findMoovInTail(bytes, absoluteOffset)

  let verdict: HeaderProbe = { kind: 'unknown' }
  let sawBox = false
  iterateBoxes(bytes, absoluteOffset, 0, bytes.length, (box, payloadStart, payloadEnd) => {
    sawBox = true
    if (box.type === 'moov') {
      if (box.end - absoluteOffset > bytes.length) {
        // The window ended inside `moov`; ask for exactly the missing span.
        verdict = { kind: 'need-range', start: box.start, end: box.end }
        return 'stop'
      }
      const metadata = parseMoovPayload(bytes, absoluteOffset, payloadStart, payloadEnd)
      verdict = metadata ? { kind: 'found', metadata } : { kind: 'unknown' }
      return 'stop'
    }
    if (box.type === 'mdat') {
      // A short file can hold both `mdat` and a trailing `moov` inside one
      // window; only ask for the tail when the media data runs past the buffer.
      if (box.end - absoluteOffset <= bytes.length) {
        verdict = { kind: 'need-tail' }
        return 'continue'
      }
      verdict = { kind: 'need-tail' }
      return 'stop'
    }
    return 'continue'
  })
  // Boxes parsed fine but the window ran out before a verdict: `moov` may still
  // be waiting at the end of the file, which is one cheap request to rule out.
  if (verdict.kind === 'unknown' && sawBox) return { kind: 'need-tail' }
  return verdict
}

/**
 * `moov` after `mdat` means the buffer we have is an arbitrary slice of the
 * file, so there is no box boundary to start walking from. Instead, look for
 * the four ASCII bytes and validate the size field backwards from them.
 */
function findMoovInTail(bytes: Uint8Array, absoluteOffset: number): HeaderProbe {
  for (let typeAt = 4; typeAt + 4 <= bytes.length; typeAt++) {
    if (bytes[typeAt] !== 0x6d || bytes[typeAt + 1] !== 0x6f
      || bytes[typeAt + 2] !== 0x6f || bytes[typeAt + 3] !== 0x76) continue
    const boxAt = typeAt - 4
    const size32 = readU32(bytes, boxAt)
    if (size32 < 16) continue
    const boxEnd = boxAt + size32
    if (boxEnd > bytes.length) continue
    const metadata = parseMoovPayload(bytes, absoluteOffset, boxAt + 8, boxEnd)
    if (metadata) return { kind: 'found', metadata }
  }
  return { kind: 'unknown' }
}

// ── EBML (WebM / MKV) ────────────────────────────────────────────────────

const EBML_SEGMENT = 0x18538067
const EBML_INFO = 0x1549a966
const EBML_TRACKS = 0x1654ae6b
const EBML_TRACK_ENTRY = 0xae
const EBML_VIDEO = 0xe0
const EBML_TIMECODE_SCALE = 0x2ad7b1
const EBML_DURATION = 0x4489
const EBML_PIXEL_WIDTH = 0xb0
const EBML_PIXEL_HEIGHT = 0xba

/** Returns the element id (marker bits kept) and its encoded length, or null. */
function readEbmlId(bytes: Uint8Array, at: number): { id: number; length: number } | null {
  if (at >= bytes.length) return null
  const first = bytes[at]!
  if (first === 0) return null
  let length = 1
  let mask = 0x80
  while (length <= 4 && (first & mask) === 0) { mask >>= 1; length++ }
  if (length > 4 || at + length > bytes.length) return null
  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + bytes[at + i]!
  return { id, length }
}

/** Returns the payload size (marker bits stripped) and its encoded length. */
function readEbmlSize(bytes: Uint8Array, at: number): { size: number; length: number; unknown: boolean } | null {
  if (at >= bytes.length) return null
  const first = bytes[at]!
  if (first === 0) return null
  let length = 1
  let mask = 0x80
  while (length <= 8 && (first & mask) === 0) { mask >>= 1; length++ }
  if (length > 8 || at + length > bytes.length) return null
  let value = first & (mask - 1)
  let allOnes = value === mask - 1
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!
    value = value * 256 + byte
    if (byte !== 0xff) allOnes = false
  }
  return { size: value, length, unknown: allOnes }
}

function readEbmlUint(bytes: Uint8Array, at: number, length: number): number {
  let value = 0
  for (let i = 0; i < length && at + i < bytes.length; i++) value = value * 256 + bytes[at + i]!
  return value
}

function readEbmlFloat(bytes: Uint8Array, at: number, length: number): number | undefined {
  if (at + length > bytes.length) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, length)
  if (length === 4) return view.getFloat32(0)
  if (length === 8) return view.getFloat64(0)
  return undefined
}

function parseEbml(bytes: Uint8Array): HeaderProbe {
  let timecodeScale = 1_000_000
  let rawDuration: number | undefined
  let width: number | undefined
  let height: number | undefined
  let sawAny = false

  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 6) return
    let offset = start
    const limit = Math.min(end, bytes.length)
    while (offset < limit) {
      const id = readEbmlId(bytes, offset)
      if (!id) return
      const size = readEbmlSize(bytes, offset + id.length)
      if (!size) return
      const payloadStart = offset + id.length + size.length
      const payloadEnd = size.unknown ? limit : Math.min(payloadStart + size.size, limit)
      if (payloadStart > limit) return
      sawAny = true

      switch (id.id) {
        case EBML_SEGMENT:
        case EBML_INFO:
        case EBML_TRACKS:
        case EBML_TRACK_ENTRY:
        case EBML_VIDEO:
          walk(payloadStart, payloadEnd, depth + 1)
          break
        case EBML_TIMECODE_SCALE:
          timecodeScale = readEbmlUint(bytes, payloadStart, size.size) || timecodeScale
          break
        case EBML_DURATION: {
          const value = readEbmlFloat(bytes, payloadStart, size.size)
          if (value !== undefined && Number.isFinite(value) && value > 0) rawDuration = value
          break
        }
        case EBML_PIXEL_WIDTH:
          width = readEbmlUint(bytes, payloadStart, size.size) || width
          break
        case EBML_PIXEL_HEIGHT:
          height = readEbmlUint(bytes, payloadStart, size.size) || height
          break
        default:
          break
      }
      if (size.unknown) return
      const next = payloadStart + size.size
      if (next <= offset) return
      offset = next
    }
  }

  walk(0, bytes.length, 0)
  if (!sawAny) return { kind: 'unknown' }

  const metadata: HeaderMetadata = {}
  // Duration is expressed in TimecodeScale units; the scale is nanoseconds.
  if (rawDuration !== undefined) metadata.duration = rawDuration * timecodeScale / 1e9
  if (width && height) { metadata.width = width; metadata.height = height }
  if (metadata.duration === undefined && metadata.width === undefined) return { kind: 'unknown' }
  return { kind: 'found', metadata }
}
