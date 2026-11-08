/** Instagram's byte-query requests can return tiny MP4 indexes with HTTP 200. */
export function normalizeInstagramMediaUrl(value: string, pageUrl?: string): string {
  try {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol) || !/\.mp4$/i.test(url.pathname)) return value
    const instagramCdn = /(^|\.)cdninstagram\.com$/i.test(url.hostname)
    const instagramPage = pageUrl && /(^|\.)instagram\.com$/i.test(new URL(pageUrl).hostname)
    if (!instagramCdn && !(instagramPage && /(^|\.)fbcdn\.net$/i.test(url.hostname))) return value
    if (!url.searchParams.has('bytestart') && !url.searchParams.has('byteend')) return value

    // Keep signed query bytes unchanged; URLSearchParams can re-encode them.
    const queryStart = value.indexOf('?')
    const hashStart = value.indexOf('#', queryStart)
    const query = value.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart)
    const kept = query.split('&').filter(part => {
      const key = decodeURIComponent(part.split('=', 1)[0]!)
      return key !== 'bytestart' && key !== 'byteend'
    }).join('&')
    return value.slice(0, queryStart) + (kept ? `?${kept}` : '') + (hashStart < 0 ? '' : value.slice(hashStart))
  } catch { return value }
}
