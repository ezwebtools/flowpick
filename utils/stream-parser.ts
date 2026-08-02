export interface VariantStream {
  uri: string
  bandwidth?: number
  resolution?: string
  label: string
  audioUri?: string
}

export interface ParsedManifest {
  type: 'hls-master' | 'hls-media' | 'dash' | 'unknown'
  variants: VariantStream[]
  /** 总时长（秒）。Live 流可能拿不到。 */
  duration?: number
  /** 估算总大小（字节）。通过抽样 segment 大小 × segment 数量得出。 */
  estimatedSize?: number
}

function resolveUrl(base: string, rel: string): string {
  if (!rel) return base
  try {
    if (rel.startsWith('http://') || rel.startsWith('https://')) return rel
    if (rel.startsWith('//')) return new URL(base).protocol + rel
    if (rel.startsWith('/')) return new URL(base).origin + rel
    return base.substring(0, base.lastIndexOf('/') + 1) + rel
  } catch {
    return rel
  }
}

function formatBandwidth(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} Kbps`
  return `${bps} bps`
}

function makeVariantLabel(resolution?: string, bandwidth?: number): string {
  const height = resolution ? parseInt(resolution.split(/[xX×]/)[1] ?? '0', 10) : 0
  const parts: string[] = []
  if (height > 0) parts.push(`${height}p`)
  else if (resolution) parts.push(resolution)
  if (bandwidth) parts.push(formatBandwidth(bandwidth))
  return parts.join(' · ') || 'Unknown'
}

/**
 * 累加 m3u8 media playlist 中所有 #EXTINF 的时长。
 * 仅 VOD 流（有 #EXT-X-ENDLIST）的时长是固定的；live 流时长动态变化，仍返回当前累加值供参考。
 */
function sumExtinf(text: string): number | undefined {
  let total = 0
  let found = false
  for (const line of text.split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim())
    if (m) {
      total += parseFloat(m[1]!)
      found = true
    }
  }
  return found ? total : undefined
}

/**
 * 从 media playlist 文本中提取所有 segment URL（非 # 开头的非空行）。
 */
function extractSegmentUrls(text: string, baseUrl: string): string[] {
  const urls: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    urls.push(resolveUrl(baseUrl, t))
  }
  return urls
}

/**
 * 对使用 #EXT-X-BYTERANGE 的 media playlist，直接累加各分片的字节范围长度（n）作为总大小。
 * 所有分片指向同一资源文件的不同区间，总大小 = Σ 各区间长度，无需任何网络请求。
 * 结果接近真实总大小（忽略 EXT-X-MAP 初始化小段，通常仅几 KB）。
 * 不含 byterange 的 playlist 返回 undefined。
 */
function computeByterangeTotalSize(text: string, baseUrl: string): number | undefined {
  if (!text.includes('#EXT-X-BYTERANGE')) return undefined
  let total = 0
  let found = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('#EXT-X-BYTERANGE:')) continue
    const m = /^#EXT-X-BYTERANGE:(\d+)/.exec(t)
    if (m) {
      total += parseInt(m[1]!, 10)
      found = true
    }
  }
  // baseUrl 参数保留以备扩展（如校验资源唯一性），此处仅求和长度
  void baseUrl
  return found ? total : undefined
}

/**
 * 请求 segment 大小（字节），失败返回 undefined。
 * 策略：先 HEAD（省流量），失败或无 content-length 时 fallback 到 GET + Range: bytes=0-0
 *   - 206 响应：解析 Content-Range: bytes 0-0/12345 → 12345
 *   - 200 响应：取 Content-Length（整个文件大小）
 *   - body 立即 cancel，避免拉取完整分片
 */
async function fetchSegmentSize(url: string, headers: Record<string, string>): Promise<number | undefined> {
  const parseContentRange = (v: string | null): number | undefined => {
    if (!v) return undefined
    const m = v.match(/\/(\d+)$/)
    return m ? parseInt(m[1], 10) : undefined
  }

  try {
    // 1) HEAD
    const headResp = await fetch(url, { method: 'HEAD', headers, credentials: 'omit', cache: 'no-store' })
    if (headResp.ok) {
      const cl = headResp.headers.get('content-length')
      if (cl) return parseInt(cl, 10)
      const cr = parseContentRange(headResp.headers.get('content-range'))
      if (cr) return cr
    }

    // 2) HEAD 失败/无 length → GET + Range: bytes=0-0
    const getResp = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      credentials: 'omit',
      cache: 'no-store',
    })
    if (getResp.status === 206) {
      const cr = parseContentRange(getResp.headers.get('content-range'))
      if (cr) return cr
    }
    if (getResp.status === 200) {
      const cl = getResp.headers.get('content-length')
      if (cl) return parseInt(cl, 10)
    }
    // 取消 body 下载（避免无 Range 时拉取整个 segment）
    try { await getResp.body?.cancel() } catch {}
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 通过抽样多个分片估算整条 media playlist 的总大小（字节）。
 * - 在 playlist 内均匀选取若干位置（首 / 1/4 / 中 / 3/4 / 末）并发请求分片大小；
 * - 取成功样本的平均值 × 分片总数 作为估算值。
 * - 多点抽样避免「只抽中间一个」时单点失败导致整条没大小（常见：CDN 不支持 Range / 无 content-length / 403）。
 * 全部失败返回 undefined。
 */
async function estimateSizeFromSegments(
  segUrls: string[],
  fetchHeaders: Record<string, string>,
): Promise<number | undefined> {
  if (segUrls.length === 0) return undefined

  const pickIndex = (ratio: number) => Math.max(0, Math.min(segUrls.length - 1, Math.floor(segUrls.length * ratio)))
  const positions = Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map(pickIndex)))

  const sizes: number[] = []
  await Promise.all(positions.map(async (idx) => {
    const segSize = await fetchSegmentSize(segUrls[idx]!, fetchHeaders)
    if (segSize && segSize > 0) sizes.push(segSize)
  }))

  if (sizes.length > 0) {
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
    return Math.round(avg * segUrls.length)
  }

  // 兜底：所有轻量探测都拿不到 content-length（CDN 不返回/不支持 Range）时，
  // 此前会完整下载「一个」分片测量字节，对 10MB+ 的 TS 分片单次估算就吃 10MB 流量。
  // 改用 Range: bytes=0-1048575 限制最多拉 1MB，按比例或 content-range 估算。
  try {
    const mid = segUrls[pickIndex(0.5)]!
    const rangeResp = await fetch(mid, {
      headers: { ...fetchHeaders, Range: 'bytes=0-1048575' },
      credentials: 'omit',
      cache: 'no-store',
    })
    if (rangeResp.status === 206) {
      // CDN 支持 Range：优先用 content-range 的 total（精确）
      const cr = rangeResp.headers.get('content-range')
      const crMatch = cr ? /\/(\d+)$/.exec(cr) : null
      if (crMatch) {
        const total = parseInt(crMatch[1]!, 10)
        if (total > 0) {
          try { await rangeResp.body?.cancel() } catch {}
          return Math.round(total * segUrls.length)
        }
      }
      // 无 total（content-range 为 */* 形式）：无法估算，取消 body
      try { await rangeResp.body?.cancel() } catch {}
      return undefined
    }
    if (rangeResp.ok) {
      // 200：CDN 不支持 Range，返回完整分片。用 content-length 估算，不下载 body
      const cl = rangeResp.headers.get('content-length')
      try { await rangeResp.body?.cancel() } catch {}
      if (cl) {
        const n = parseInt(cl, 10)
        if (n > 0) return Math.round(n * segUrls.length)
      }
    }
  } catch {
    // 忽略：降级为不估算
  }
  return undefined
}

/**
 * 解析 ISO 8601 duration（如 PT1H30M10.5S）为秒数。
 * 用于 DASH 的 mediaPresentationDuration 属性。
 */
function parseIsoDuration(iso: string): number | undefined {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(iso)
  if (!m) return undefined
  const years = parseInt(m[1] ?? '0', 10)
  const months = parseInt(m[2] ?? '0', 10)
  const days = parseInt(m[3] ?? '0', 10)
  const hours = parseInt(m[4] ?? '0', 10)
  const minutes = parseInt(m[5] ?? '0', 10)
  const seconds = parseFloat(m[6] ?? '0')
  const total = years * 365 * 86400 + months * 30 * 86400 + days * 86400 + hours * 3600 + minutes * 60 + seconds
  return total > 0 ? total : undefined
}

export async function parseM3U8Manifest(
  url: string,
  fetchText: (u: string) => Promise<string>,
  fetchHeaders?: Record<string, string>
): Promise<ParsedManifest> {
  let text: string
  try {
    text = await fetchText(url)
  } catch {
    return { type: 'unknown', variants: [] }
  }

  if (!text.includes('#EXTM3U')) {
    return { type: 'unknown', variants: [] }
  }

  const isMaster = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA')

  if (!isMaster) {
    // media playlist（单码率）— 估算大小
    const duration = sumExtinf(text)
    const segUrls = extractSegmentUrls(text, url)
    // 1) byterange 形式：直接累加各区间长度，最准最稳
    // 2) 否则多点抽样分片取平均 × 片数（单点抽样易因 CDN 拦截失败导致没大小）
    const estimatedSize = computeByterangeTotalSize(text, url)
      ?? await estimateSizeFromSegments(segUrls, fetchHeaders ?? {})
    return { type: 'hls-media', variants: [], duration, estimatedSize }
  }

  const variants: VariantStream[] = []
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  const audioGroupUris = new Map<string, string>()
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      const groupIdMatch = /GROUP-ID="([^"]+)"/.exec(line)
      const uriMatch = /URI="([^"]+)"/.exec(line)
      if (groupIdMatch && uriMatch) {
        audioGroupUris.set(groupIdMatch[1]!, resolveUrl(url, uriMatch[1]!))
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const nextLine = lines[i + 1]
    if (!nextLine || nextLine.startsWith('#')) continue

    const variantUri = resolveUrl(url, nextLine)
    const bwMatch = /BANDWIDTH=(\d+)/.exec(line)
    const resMatch = /RESOLUTION=(\d+[xX×]\d+)/i.exec(line)
    const audioGroupMatch = /AUDIO="([^"]+)"/.exec(line)

    const bandwidth = bwMatch ? parseInt(bwMatch[1]!, 10) : undefined
    const resolution = resMatch ? resMatch[1] : undefined
    const audioUri = audioGroupMatch ? audioGroupUris.get(audioGroupMatch[1]!) : undefined

    variants.push({
      uri: variantUri,
      bandwidth,
      resolution,
      label: makeVariantLabel(resolution, bandwidth),
      audioUri,
    })
  }

  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))

  // master playlist：尝试 fetch 最高码率 variant 的 media playlist 取时长；
  // 若该 variant 没有 bandwidth，也尝试抽样 segment 大小估算
  let duration: number | undefined
  let estimatedSize: number | undefined
  if (variants.length > 0) {
    try {
      const topVariant = variants[0]!
      const mediaText = await fetchText(topVariant.uri)
      if (mediaText.includes('#EXTM3U')) {
        duration = sumExtinf(mediaText)
        if (!topVariant.bandwidth && duration && duration > 0) {
          // 无带宽的 variant：优先 byterange 求和，否则多点抽样 segment 取平均 × 片数估算大小
          estimatedSize = computeByterangeTotalSize(mediaText, topVariant.uri)
          if (estimatedSize === undefined) {
            const segUrls = extractSegmentUrls(mediaText, topVariant.uri)
            estimatedSize = await estimateSizeFromSegments(segUrls, fetchHeaders ?? {})
          }
        }
      }
    } catch { /* 忽略，duration 保持 undefined */ }
  }

  return { type: 'hls-master', variants, duration, estimatedSize }
}

export async function parseDashManifest(
  url: string,
  fetchText: (u: string) => Promise<string>
): Promise<ParsedManifest> {
  let text: string
  try {
    text = await fetchText(url)
  } catch {
    return { type: 'unknown', variants: [] }
  }

  if (!text.includes('<MPD') && !text.includes('<mpd')) {
    return { type: 'unknown', variants: [] }
  }

  // 读 <MPD mediaPresentationDuration="PT1H30M10.5S">
  let duration: number | undefined
  const durMatch = /mediaPresentationDuration="([^"]+)"/.exec(text)
  if (durMatch) {
    duration = parseIsoDuration(durMatch[1]!)
  }

  const variants: VariantStream[] = []

  let adaptationBlocks: string[] = []
  const videoByContent = [...text.matchAll(/<AdaptationSet[^>]*contentType="video"[^>]*>([\s\S]*?)<\/AdaptationSet>/gi)]
  const videoByMime = [...text.matchAll(/<AdaptationSet[^>]*mimeType="video[^"]*"[^>]*>([\s\S]*?)<\/AdaptationSet>/gi)]
  const allVideoAdapt = videoByContent.length > 0 ? videoByContent : videoByMime
  adaptationBlocks = allVideoAdapt.map(m => m[1] ?? '')

  if (adaptationBlocks.length === 0) {
    const allAdapt = [...text.matchAll(/<AdaptationSet[^>]*>([\s\S]*?)<\/AdaptationSet>/gi)]
    adaptationBlocks = allAdapt.map(m => m[1] ?? '')
  }

  for (const block of adaptationBlocks) {
    const repMatches = [...block.matchAll(/<Representation\s([^>]*?)(?:\/>|>)/gi)]
    for (const rep of repMatches) {
      const attrs = rep[1] ?? ''
      const bwMatch = /bandwidth="(\d+)"/i.exec(attrs)
      const wMatch = /width="(\d+)"/i.exec(attrs)
      const hMatch = /height="(\d+)"/i.exec(attrs)
      if (!bwMatch) continue
      const bandwidth = parseInt(bwMatch[1]!, 10)
      const width = wMatch ? wMatch[1] : undefined
      const height = hMatch ? hMatch[1] : undefined
      const resolution = width && height ? `${width}x${height}` : undefined
      variants.push({
        uri: url,
        bandwidth,
        resolution,
        label: makeVariantLabel(resolution, bandwidth),
      })
    }
  }

  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))

  return { type: 'dash', variants, duration }
}
