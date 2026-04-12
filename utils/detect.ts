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
  // 'video/mp2t': 'ts',
  'video/mpeg': 'mpeg',
  
  // 音频格式
  'audio/mpeg': 'mp3',
  // 'audio/mp4': 'm4a',
  // 'audio/x-m4a': 'm4a',
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
  
  // 其他媒体格式
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

function isExcludedExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  return EXCLUDED_EXTENSIONS.some(ext => lower.endsWith(ext))
}

// 根据content-type检测媒体格式
export function detectMediaFromContentType(contentType: string): string | null {
  console.log(contentType,"detectMediaFromContentType")
  if (!contentType) return null
  
  const normalizedType = contentType.toLowerCase().split(';')[0].trim()
  return (MEDIA_FORMATS as Record<string, string>)[normalizedType] || null
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
export function detectMedia(url: string, contentType?: string | null): string | null {
  // 1. 优先使用content-type检测（最准确）
  if (contentType) {
    const contentTypeFormat = detectMediaFromContentType(contentType)
    if (contentTypeFormat) {
      return contentTypeFormat
    }
  }
  
  // 2. 备选：使用URL检测（更严格的检测）
  return detectMediaFromUrl(url)
}
