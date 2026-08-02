import type { PlatformMediaCandidate, PlatformMediaTask } from '../utils/platform-media'

export default defineContentScript({
  matches: [
    '*://www.douyin.com/*',
    '*://www.iesdouyin.com/*',
  ],
  runAt: 'document_idle',
  main() {
    const MAX_OBJECTS = 6_000
    const MAX_CANDIDATES = 24
    const announced = new Set<string>()
    let scheduled = false

    const mediaUrlPattern = /(^|\.)(douyinvod|douyincdn|bytecdn|bytego|byteimg|bytedance|amemv|iesdouyin|snssdk|pstatp|toutiaovod|ixigua)\.(com|cn|net)$/i
    const addressKeys = new Set(['playaddr', 'play_addr', 'playurl', 'play_url', 'url_list', 'downloadaddr', 'download_addr'])

    const asHttpUrl = (value: unknown): string | undefined => {
      if (typeof value !== 'string' || !value) return undefined
      try {
        const url = new URL(value, location.href)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
        return url.href
      } catch {
        return undefined
      }
    }

    const isMediaUrl = (url: string): boolean => {
      try {
        const parsed = new URL(url)
        return mediaUrlPattern.test(parsed.hostname) || /\/aweme\/v\d+\/play\//i.test(parsed.pathname)
      } catch {
        return false
      }
    }

    function collectUrls(value: unknown, result: string[], depth = 0): void {
      if (depth > 4 || result.length >= MAX_CANDIDATES) return
      const direct = asHttpUrl(value)
      if (direct) {
        if (isMediaUrl(direct) && !result.includes(direct)) result.push(direct)
        return
      }
      if (Array.isArray(value)) {
        for (const child of value) collectUrls(child, result, depth + 1)
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value as Record<string, unknown>)) collectUrls(child, result, depth + 1)
      }
    }

    function getText(value: unknown): string | undefined {
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }

    function numberValue(value: unknown): number | undefined {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }

    function candidateLabel(node: Record<string, unknown>): string | undefined {
      const label = getText(node.gear_name) || getText(node.quality) || getText(node.quality_name)
      if (label) return label
      const width = numberValue(node.width)
      const height = numberValue(node.height)
      return height ? `${height}p` : width ? `${width}px` : undefined
    }

    function candidateRole(node: Record<string, unknown>, parentKey: string): 'video' | 'audio' {
      const keys = `${parentKey} ${Object.keys(node).join(' ')}`.toLowerCase()
      if (/audio|music|sound/.test(keys)) return 'audio'
      return 'video'
    }

    function normalizeDuration(value: unknown): number | undefined {
      const duration = numberValue(value)
      if (!duration) return undefined
      // Douyin page payloads normally use milliseconds; retain seconds when
      // the source already supplies a short, human-scale duration.
      return duration > 1_000 ? duration / 1_000 : duration
    }

    function collectCandidates(root: unknown): PlatformMediaCandidate[] {
      const candidates = new Map<string, PlatformMediaCandidate>()
      const seen = new Set<unknown>()
      let visited = 0
      const visit = (value: unknown, parentKey = ''): void => {
        if (!value || typeof value !== 'object' || seen.has(value) || visited++ >= MAX_OBJECTS) return
        seen.add(value)
        if (Array.isArray(value)) {
          for (const child of value) visit(child, parentKey)
          return
        }
        const node = value as Record<string, unknown>
        const urls: string[] = []
        for (const [key, child] of Object.entries(node)) {
          if (addressKeys.has(key.toLowerCase())) collectUrls(child, urls)
        }
        if (urls.length && (parentKey.includes('video') || Object.keys(node).some(key => addressKeys.has(key.toLowerCase())))) {
          for (const url of urls) {
            if (candidates.size >= MAX_CANDIDATES) break
            candidates.set(url, {
              url,
              format: /\.m3u8(?:[?#]|$)/i.test(url) ? 'm3u8' : /\.mpd(?:[?#]|$)/i.test(url) ? 'mpd' : 'mp4',
              role: candidateRole(node, parentKey),
              label: candidateLabel(node),
              width: numberValue(node.width),
              height: numberValue(node.height),
              bandwidth: numberValue(node.bit_rate) || numberValue(node.bitrate),
              duration: normalizeDuration(node.duration),
            })
          }
        }
        for (const [key, child] of Object.entries(node)) visit(child, key.toLowerCase())
      }
      visit(root)
      return [...candidates.values()]
    }

    function parseJsonScript(script: HTMLScriptElement): unknown | undefined {
      const raw = script.textContent?.trim()
      if (!raw || raw.length > 4_000_000) return undefined
      const attempts = [raw]
      try { attempts.push(decodeURIComponent(raw)) } catch {}
      for (const text of attempts) {
        try {
          const parsed = JSON.parse(text)
          if (typeof parsed !== 'string') return parsed
          try { return JSON.parse(parsed) } catch { return parsed }
        } catch {}
      }
      return undefined
    }

    function extractTask(): PlatformMediaTask | undefined {
      const roots: unknown[] = []
      for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/json"], script[id="RENDER_DATA"], script[id="SIGI_STATE"], script[id="__NEXT_DATA__"]')) {
        const parsed = parseJsonScript(script)
        if (parsed) roots.push(parsed)
      }
      const candidates = roots.flatMap(collectCandidates)
      const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.url, candidate])).values()]
      if (!uniqueCandidates.length) return undefined

      const title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content
        || document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content
        || document.title
      const coverUrl = asHttpUrl(document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content)
      const key = `${location.pathname}${location.search}`
      const duration = uniqueCandidates.find(item => item.role === 'video' && item.duration)?.duration
      return { provider: 'douyin', key, title: title?.trim() || undefined, coverUrl, duration, referer: location.href, priority: 1, candidates: uniqueCandidates }
    }

    function announce(): void {
      scheduled = false
      const task = extractTask()
      if (!task) return
      const signature = `${task.key}:${task.candidates.map(item => item.url).sort().join('|')}`
      if (announced.has(signature)) return
      announced.add(signature)
      if (announced.size > 30) announced.clear()
      browser.runtime.sendMessage({ type: 'PLATFORM_MEDIA_FOUND', task }).catch(() => {})
    }

    function schedule(): void {
      if (scheduled) return
      scheduled = true
      setTimeout(announce, 300)
    }

    schedule()
    window.addEventListener('popstate', schedule)
    window.addEventListener('hashchange', schedule)
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
    setInterval(schedule, 2_500)
  },
})
