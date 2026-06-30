export default defineUnlistedScript(() => {
  // 媒体文件扩展名列表（排除DASH/HLS片段格式）
  const mediaExtensions = [
    '.m3u8', '.mp4', '.mp3', '.flv', '.mkv', '.webm', '.mov',
    '.avi', '.wmv', '.aac', '.ogg', '.wav', '.mpd'
  ]
  
  // 排除的片段格式
  const excludedExtensions = ['.m4s', '.m4v', '.m4a', '.m4f', '.m4i', '.cmfv', '.cmfa', '.cmft', '.ts']
  
  // 检查URL是否包含媒体扩展名
  function isMediaUrl(url: string): boolean {
    const urlLower = url.toLowerCase()
    // 先检查是否是排除的格式
    if (excludedExtensions.some(ext => urlLower.includes(ext))) {
      return false
    }
    return mediaExtensions.some(ext => urlLower.includes(ext))
  }
  
  // 从URL中提取媒体格式
  function getMediaFormat(url: string): string {
    const urlLower = url.toLowerCase()
    for (const ext of mediaExtensions) {
      if (urlLower.includes(ext)) {
        return ext.replace('.', '')
      }
    }
    return 'm3u8' // 默认
  }

  const originalFetch = window.fetch

  window.fetch = async (...args) => {
    try {
      const url = normalizeArg(args[0])
      if (url && isMediaUrl(url)) {
        send(url, getMediaFormat(url))
      }
    } catch {}
    return originalFetch(...args)
  }

  const originalOpen = XMLHttpRequest.prototype.open

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    try {
      const urlStr = url instanceof URL ? url.toString() : url
      if (urlStr && isMediaUrl(urlStr)) {
        send(urlStr, getMediaFormat(urlStr))
      }
    } catch {}
    return originalOpen.call(this, method, url, async, username, password)
  }

  function normalizeArg(input: unknown): string | null {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.toString()
    if (input instanceof Request) return input.url
    return null
  }

  function send(url: string, format: string) {
    window.postMessage({ type: 'M3U8_DETECTED', url, format })
  }
})
