export function normalizeUrl(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.toString()
  if (typeof Request !== 'undefined' && value instanceof Request) return value.url
  return null
}

// 媒体格式配置
const MEDIA_FORMATS = {
  // 视频格式
  'video/mp4': 'mp4',
  'video/x-m4v': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-flv': 'flv',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/mp2t': 'ts',
  'video/mpeg': 'mpeg',

  // 音频格式
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
  'audio/ogg': 'oga',
  'audio/webm': 'weba',
  'audio/x-wav': 'wav',
  'audio/wav': 'wav',
  'audio/x-flac': 'flac',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',

  // 流媒体格式
  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'application/x-mpegURL': 'm3u8',

  // 图片
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

// 文件扩展名到格式的映射
const EXTENSION_MAP: Record<string, string> = {
  // 视频
  '.mp4': 'mp4',
  // '.m4v': 'mp4',
  '.webm': 'webm',
  '.ogv': 'ogv',
  '.flv': 'flv',
  '.mkv': 'mkv',
  '.mov': 'mov',
  '.avi': 'avi',
  '.3gp': '3gp',
  '.3g2': '3g2',
  // '.ts': 'ts',
  '.mpeg': 'mpeg',
  '.mpg': 'mpeg',
  
  // 音频
  '.mp3': 'mp3',
  // '.m4a': 'm4a',
  '.oga': 'oga',
  '.weba': 'weba',
  '.wav': 'wav',
  '.flac': 'flac',
  '.aac': 'aac',
  
  // 流媒体
  '.m3u8': 'm3u8',
  '.m3u': 'm3u8',
  '.mpd': 'mpd',
  
  // 图片
  '.gif': 'gif',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.png': 'png',
  '.webp': 'webp',
  '.svg': 'svg',
}

// 支持的媒体类型（用于过滤）
export const SUPPORTED_MEDIA_TYPES = [
  'm3u8', 'mpd', 'mp4', 'webm', 'ogv', 'flv', 'mkv', 'mov', 'avi', '3gp', '3g2', 'mpeg',
  'mp3',  'oga', 'weba', 'wav', 'flac', 'aac',
  'gif', 'jpg', 'png', 'webp', 'svg'
]

// 排除的媒体类型（DASH/HLS片段格式，不单独显示）
const EXCLUDED_EXTENSIONS = ['.m4s', '.m4v', '.m4a', '.m4f', '.m4i', '.cmfv', '.cmfa', '.cmft', '.ts']

// application/octet-stream 视为媒体的最小文件大小（1MB），低于此阈值视为非媒体
export const MIN_OCTET_STREAM_SIZE = 1 * 1024 * 1024

// 已知媒体 CDN 域名特征（无扩展名 URL + octet-stream 时按域名兜底识别）
// 抖音/字节系：douyinvod, bytecdn, byteimg, bytego, bytedns, amemv, iesdouyin, snssdk
// 其他常见媒体 CDN：polyv, qiniu(my-qiniu), ks-cdn(快手), taobao/alicdn
const MEDIA_CDN_PATTERNS: RegExp[] = [
  /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance)\.(?:com|cn|net|org)\b/i,
  /\.(pstatp|toutiaovod|ixigua|xituovod|西瓜视频)\.(?:com|cn)\b/i,
  /\.(ks-yxcdn|kwaixiaodian|yx-fes|kscdn|qiniucdn|qcloudcdn)\.(?:com|cn)\b/i,
  /\.(polyv|videocc|myqcloud|alicdn|taobao|mmcdn)\.(?:com|cn)\b/i,
]

function isKnownMediaCdn(url: string): boolean {
  if (!url) return false
  try {
    const hostname = new URL(url).hostname
    return MEDIA_CDN_PATTERNS.some(re => re.test(hostname))
  } catch {
    return MEDIA_CDN_PATTERNS.some(re => re.test(url))
  }
}

function isExcludedExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  return EXCLUDED_EXTENSIONS.some(ext => lower.endsWith(ext))
}

// 根据content-type检测媒体格式
export function detectMediaFromContentType(contentType: string): string | null {
  if (!contentType) return null
  
  const normalizedType = contentType.toLowerCase().split(';')[0].trim()
  return (MEDIA_FORMATS as Record<string, string>)[normalizedType] || null
}

// data: URL 内嵌图片检测
// 解析 data:image/png;base64,... 形式，返回图片格式（png/jpg/gif/webp/svg）
// 非 data: URL 或非图片类型返回 null
const DATA_IMAGE_PREFIX = /^data:image\/([a-z0-9.+-]+)\s*(?:;([^,]*))?\s*,/i
export function detectDataImageUrl(url: string): string | null {
  if (!url || !url.startsWith('data:')) return null
  const match = url.match(DATA_IMAGE_PREFIX)
  if (!match) return null
  const subtype = match[1]!.toLowerCase()
  const map: Record<string, string> = {
    png: 'png',
    jpeg: 'jpg',
    jpg: 'jpg',
    gif: 'gif',
    webp: 'webp',
    'svg+xml': 'svg',
    bmp: 'bmp',
    'x-icon': 'ico',
    'vnd.microsoft.icon': 'ico',
    avif: 'avif',
    heic: 'heic',
    heif: 'heif',
  }
  return map[subtype] || null
}

// 估算 data: URL 的字节大小（解码 base64 后的真实字节数）
export function estimateDataUrlBytes(url: string): number {
  if (!url || !url.startsWith('data:')) return 0
  const commaIdx = url.indexOf(',')
  if (commaIdx < 0) return 0
  const meta = url.slice(0, commaIdx)
  const payload = url.slice(commaIdx + 1)
  // base64 编码：每 4 字符 ≈ 3 字节，忽略 padding 与换行
  if (meta.includes('base64')) {
    const cleaned = payload.replace(/\s/g, '')
    const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0
    return Math.floor((cleaned.length * 3) / 4) - padding
  }
  // URL 编码：解码后近似等于字符数
  try {
    return decodeURIComponent(payload).length
  } catch {
    return payload.length
  }
}

// 根据URL检测媒体格式（更严格的检测，避免误判）
export function detectMediaFromUrl(url: string): string | null {
  if (!url) return null
  
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    
    // 排除DASH/HLS片段格式
    if (isExcludedExtension(pathname)) {
      return null
    }
    
    // 只检查路径末尾的完整文件扩展名
    // 避免匹配URL路径中间或查询参数中的关键词
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      // 严格匹配：路径必须以扩展名结尾
      if (pathname.endsWith(ext)) {
        return format
      }
    }
    
    // 对于没有扩展名的URL，检查常见的媒体文件路径模式
    const lastSegment = pathname.split('/').pop() || ''
    
    // 检查是否是常见的媒体文件命名模式（如video.mp4?token=xxx）
    // 这种情况下，扩展名可能在查询参数之前
    const lastSegmentWithoutQuery = lastSegment.split('?')[0]
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      if (lastSegmentWithoutQuery.endsWith(ext)) {
        return format
      }
    }
    
    // 检查是否是流媒体播放列表（m3u8/mpd通常在查询参数中指定）
    const searchParams = parsed.searchParams
    for (const [key, value] of searchParams) {
      const lowerKey = key.toLowerCase()
      const lowerValue = value.toLowerCase()
      
      // 检查常见的流媒体参数
      if (lowerKey.includes('url') || lowerKey.includes('file') || 
          lowerKey.includes('path') || lowerKey.includes('stream')) {
        
        // 检查值中是否包含流媒体扩展名
        for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
          if (lowerValue.includes(ext) && (format === 'm3u8' || format === 'mpd')) {
            return format
          }
        }
      }
    }
    
    return null
  } catch {
    // 如果URL解析失败，进行保守的检测
    const lowerUrl = url.toLowerCase()
    
    // 排除DASH/HLS片段格式
    if (isExcludedExtension(lowerUrl)) {
      return null
    }
    
    // 只检查明显的扩展名模式（前面有点号，后面是查询参数或结束）
    for (const [ext, format] of Object.entries(EXTENSION_MAP)) {
      const extPattern = new RegExp(`\\${ext}(?:[?#]|$)`, 'i')
      if (extPattern.test(lowerUrl)) {
        return format
      }
    }
    
    return null
  }
}

// 检测是否是支持的媒体格式
export function isMediaFormat(value: unknown): boolean {
  const url = normalizeUrl(value)
  if (!url) return false
  
  const format = detectMediaFromUrl(url)
  return format !== null && SUPPORTED_MEDIA_TYPES.includes(format)
}

// 检测是否是视频格式
export function isVideoFormat(value: unknown): boolean {
  const url = normalizeUrl(value)
  if (!url) return false
  
  const format = detectMediaFromUrl(url)
  const videoFormats = ['mp4', 'webm']
  return format !== null && videoFormats.includes(format)
}

// 检测是否是音频格式
export function isAudioFormat(value: unknown): boolean {
  const url = normalizeUrl(value)
  if (!url) return false
  
  const format = detectMediaFromUrl(url)
  const audioFormats = ['mp3',  'oga', 'weba', 'wav', 'flac', 'aac']
  return format !== null && audioFormats.includes(format)
}

// 检测是否是图片格式
export function isImageFormat(value: unknown): boolean {
  const url = normalizeUrl(value)
  if (!url) return false
  
  const format = detectMediaFromUrl(url)
  const imageFormats = ['gif', 'jpg', 'png', 'webp', 'svg']
  return format !== null && imageFormats.includes(format)
}

// 向后兼容的M3U8检测函数
export function isM3U8(value: unknown): boolean {
  const url = normalizeUrl(value)
  if (!url) return false
  
  const format = detectMediaFromUrl(url)
  return format === 'm3u8'
}

// 综合检测函数：优先使用content-type，备选使用URL检测
// contentLength: 文件大小（字节），用于 application/octet-stream 的大小过滤
export function detectMedia(url: string, contentType?: string | null, contentLength?: number): string | null {
  // 0. 优先排除 DASH/HLS 分片
  if (url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase()
      if (isExcludedExtension(pathname)) return null
    } catch {
      if (isExcludedExtension(url.toLowerCase())) return null
    }
  }

  // 1. 优先使用 Content-Type 检测（最准确）
  if (contentType) {
    const normalized = contentType.toLowerCase().split(';')[0].trim()

    // application/octet-stream：通用二进制流，靠文件大小 + URL 扩展名二次判断
    if (normalized === 'application/octet-stream') {
      const sizeOk = contentLength === undefined || contentLength >= MIN_OCTET_STREAM_SIZE
      if (sizeOk) {
        const urlFmt = detectMediaFromUrl(url)
        if (urlFmt) return urlFmt
        // URL 无扩展名但来自已知媒体 CDN（抖音/字节/快手等）：兜底按 mp4 识别
        // 这些 CDN 的视频 URL 常无扩展名，且 content-type 多为 octet-stream
        if (isKnownMediaCdn(url)) return 'mp4'
      }
      return null
    }

    const contentTypeFormat = detectMediaFromContentType(contentType)
    if (contentTypeFormat) return contentTypeFormat
  }

  // 2. 备选：使用 URL 检测
  return detectMediaFromUrl(url)
}

// ============ 文档 / 字幕格式检测 ============
export type MediaCategory = 'media' | 'stream' | 'document' | 'subtitle'

// 文档（Office / PDF）的 Content-Type → 简码 映射
const DOC_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/epub+zip': 'epub',
  'text/csv': 'csv',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
}

// 字幕的 Content-Type → 简码 映射
const SUBTITLE_FORMATS: Record<string, string> = {
  'application/x-subrip': 'srt',
  'text/vtt': 'vtt',
  'text/x-ssa': 'ssa',
  'text/x-ass': 'ass',
  'application/ttml+xml': 'ttml',
}

// 文档 / 字幕 文件扩展名 → 简码 映射
const DOC_EXTENSION_MAP: Record<string, string> = {
  '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'docx',
  '.xls': 'xls', '.xlsx': 'xlsx',
  '.ppt': 'ppt', '.pptx': 'pptx',
  '.epub': 'epub',
  '.csv': 'csv',
  '.rtf': 'rtf',
  '.srt': 'srt', '.vtt': 'vtt', '.ass': 'ass', '.ssa': 'ssa', '.ttml': 'ttml',
}

const SUBTITLE_CODES = ['srt', 'vtt', 'ass', 'ssa', 'ttml']

// 根据 content-type 检测文档/字幕格式
export function detectDocFromContentType(contentType: string): string | null {
  if (!contentType) return null
  const normalized = contentType.toLowerCase().split(';')[0].trim()
  return DOC_FORMATS[normalized] || SUBTITLE_FORMATS[normalized] || null
}

// 根据 URL 检测文档/字幕格式（严格扩展名匹配）
export function detectDocFromUrl(url: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (pathname.endsWith(ext)) return format
    }
    const lastSegment = pathname.split('/').pop()?.split('?')[0] || ''
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (lastSegment.endsWith(ext)) return format
    }
    return null
  } catch {
    const lower = url.toLowerCase()
    for (const [ext, format] of Object.entries(DOC_EXTENSION_MAP)) {
      if (new RegExp(`\\${ext}(?:[?#]|$)`, 'i').test(lower)) return format
    }
    return null
  }
}

// 从 Content-Disposition 头解析文件名，提取扩展名并映射格式
// 支持 filename="foo.pdf"、filename*=UTF-8''foo.pdf 两种写法
export function detectDocFromContentDisposition(contentDisposition: string): string | null {
  if (!contentDisposition) return null
  const lower = contentDisposition.toLowerCase()
  if (!lower.includes('attachment') && !lower.includes('inline')) return null

  // 优先匹配 filename*=UTF-8''xxx 或 filename*=xxx
  let filename: string | null = null
  const rfc5987 = contentDisposition.match(/filename\*\s*=\s*(?:[^']*'[^']*')?([^;"\s]+)/i)
  if (rfc5987?.[1]) {
    try { filename = decodeURIComponent(rfc5987[1]) } catch { filename = rfc5987[1] }
  }

  // 回退到 filename="xxx" 或 filename=xxx
  if (!filename) {
    const plain = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i) ??
                  contentDisposition.match(/filename\s*=\s*([^;"\s]+)/i)
    if (plain?.[1]) {
      try { filename = decodeURIComponent(plain[1]) } catch { filename = plain[1] }
    }
  }

  if (!filename) return null

  // 提取扩展名，查文档/字幕映射
  const ext = ('.' + filename.split('.').pop()!.toLowerCase()) as string
  return DOC_EXTENSION_MAP[ext] ?? null
}

// 综合检测文档/字幕：优先 content-type，次选 Content-Disposition，备选 URL 扩展名
export function detectDoc(
  url: string,
  contentType?: string | null,
  contentDisposition?: string | null,
): { format: string; category: MediaCategory } | null {
  // 排除 DASH/HLS 分片，避免 .m4s 等被误判为文档
  if (url) {
    try {
      if (isExcludedExtension(new URL(url).pathname.toLowerCase())) return null
    } catch {
      if (isExcludedExtension(url.toLowerCase())) return null
    }
  }

  let format: string | null = null
  if (contentType) format = detectDocFromContentType(contentType)
  if (!format && contentDisposition) format = detectDocFromContentDisposition(contentDisposition)
  if (!format) format = detectDocFromUrl(url)
  if (!format) return null

  const category: MediaCategory = SUBTITLE_CODES.includes(format) ? 'subtitle' : 'document'
  return { format, category }
}
