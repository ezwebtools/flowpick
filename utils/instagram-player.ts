import type { PlatformMediaCandidate, PlatformMediaTask } from './platform-media'
import { normalizeInstagramMediaUrl } from './instagram-media'

export function isAllowedInstagramMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)
  } catch { return false }
}

/** Signatures and CDN shards can change while the encoded track stays the same. */
export function instagramTrackIdentity(value: string): string | undefined {
  if (!isAllowedInstagramMediaUrl(value)) return undefined
  const url = new URL(value)
  if (!/\.mp4$/i.test(url.pathname)) return undefined
  // Progressive recipes can share a path with a video-only DASH track.
  return JSON.stringify([url.pathname, url.searchParams.get('vs'), url.searchParams.get('_nc_vs')])
}

export function isInstagramMediaApi(value: string): boolean {
  try {
    const url = new URL(value, 'https://www.instagram.com/')
    return /(^|\.)instagram\.com$/i.test(url.hostname) && /^\/(?:graphql(?:\/|$)|api\/graphql(?:\/|$)|api\/v1\/)/i.test(url.pathname)
  } catch { return false }
}

/** Only pair tracks declared together in one single-period DASH manifest. */
export function parseInstagramDash(text: string, pageUrl: string): PlatformMediaCandidate[] {
  if (!text || text.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(text)) return []
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml')
    const elements = (name: string) => Array.from(xml.getElementsByTagName(name))
    if (xml.documentElement.localName !== 'MPD' || elements('parsererror').length
      || elements('ContentProtection').length || elements('SegmentTemplate').length
      || elements('SegmentList').length || elements('Period').length !== 1) return []
    const directBase = (node: Element) => Array.from(node.childNodes)
      .find(child => child.nodeType === 1 && (child as Element).localName === 'BaseURL')?.textContent?.trim()
    const candidates: PlatformMediaCandidate[] = []
    const durationParts = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(xml.documentElement.getAttribute('mediaPresentationDuration') || '')
    const duration = durationParts ? Number(durationParts[1] || 0) * 3600 + Number(durationParts[2] || 0) * 60 + Number(durationParts[3] || 0) : undefined
    for (const representation of elements('Representation')) {
      const adaptation = representation.parentNode as Element
      const mime = representation.getAttribute('mimeType') || adaptation.getAttribute('mimeType') || ''
      const content = representation.getAttribute('contentType') || adaptation.getAttribute('contentType') || ''
      const codecs = representation.getAttribute('codecs') || adaptation.getAttribute('codecs') || ''
      const role = /audio/i.test(mime + content) || /^(?:mp4a|opus|vorbis)/i.test(codecs) ? 'audio'
        : /video/i.test(mime + content) || /^(?:avc|av01|hev|hvc|vp0?[89])/i.test(codecs) ? 'video' : undefined
      if (!role) continue
      const ancestors: Element[] = []
      for (let node: Element | null = representation; node; node = node.parentNode?.nodeType === 1 ? node.parentNode as Element : null) ancestors.unshift(node)
      let url = pageUrl
      for (const node of ancestors) {
        const base = directBase(node)
        if (base) url = new URL(base, url).href
      }
      if (!isAllowedInstagramMediaUrl(url) || !/\.mp4$/i.test(new URL(url).pathname)) continue
      url = normalizeInstagramMediaUrl(url, pageUrl)
      if (candidates.some(candidate => candidate.url === url)) continue
      const width = Number(representation.getAttribute('width') || adaptation.getAttribute('width')) || undefined
      const height = Number(representation.getAttribute('height') || adaptation.getAttribute('height')) || undefined
      candidates.push({ url, format: 'mp4', role, width, height,
        bandwidth: Number(representation.getAttribute('bandwidth')) || undefined, duration,
        label: role === 'video' ? representation.getAttribute('FBQualityLabel') || (height ? `${height}p` : role) : adaptation.getAttribute('lang') || role,
      })
    }
    return candidates.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))
  } catch { return [] }
}

/** Relay hydration and API responses share the same per-media manifest fields. */
export function extractInstagramMediaTasks(payload: unknown, pageUrl: string): PlatformMediaTask[] {
  try { if (!/(^|\.)instagram\.com$/i.test(new URL(pageUrl).hostname)) return [] } catch { return [] }
  const currentCode = /\/(?:reels?|p|tv)\/([^/?#]+)/.exec(new URL(pageUrl).pathname)?.[1]
  const tasks = new Map<string, PlatformMediaTask>()
  const seen = new WeakSet<object>()
  let remaining = 30_000
  const visit = (node: any, depth = 0, parentCode?: string) => {
    if (!node || typeof node !== 'object' || depth > 35 || --remaining < 0 || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1, parentCode); return }
    const code = typeof (node.code || node.shortcode) === 'string' ? node.code || node.shortcode : parentCode
    const key = node.pk || node.id || node.code || node.shortcode
    const manifest = node.video_dash_manifest || node.dash_info?.video_dash_manifest || node.dash_manifest
    if ((typeof key === 'string' || typeof key === 'number') && (!currentCode || code === currentCode)) {
      const candidates = typeof manifest === 'string' ? parseInstagramDash(manifest, pageUrl) : []
      if (candidates.some(candidate => candidate.role === 'video') && candidates.some(candidate => candidate.role === 'audio')) {
        const task: PlatformMediaTask = {
          provider: 'instagram', key: String(key), referer: pageUrl, priority: 3,
          title: node.caption?.text || node.title || undefined,
          duration: Number(node.video_duration) || candidates[0]?.duration,
          coverUrl: node.image_versions2?.candidates?.[0]?.url || node.display_url || undefined,
          candidates,
        }
        tasks.set(task.key, task)
      }
    }
    for (const child of Object.values(node)) visit(child, depth + 1, code)
  }
  visit(payload)
  return [...tasks.values()]
}

export function parseInstagramPayloadText(text: string): unknown[] {
  if (!text || text.length > 8_000_000) return []
  const clean = text.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, '')
  try { return [JSON.parse(clean)] } catch {}
  const payloads: unknown[] = []
  for (const line of clean.split('\n').slice(0, 100)) {
    try { payloads.push(JSON.parse(line)) } catch {}
  }
  return payloads
}
