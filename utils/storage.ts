import type { MediaCategory } from './detect'

const PREFIX = 'tab_'

export interface MediaEntry {
  format: string
  size?: number
  detectedAt?: number
  category?: MediaCategory
  requestHeaders?: Record<string, string>
  captureId?: string
  /** Frame that owns the in-page MSE capture. */
  frameId?: number
  trackCount?: number
  mseComplete?: boolean
  contentType?: string
  groupId?: string
  groupRole?: 'master' | 'variant' | 'audio' | 'segment'
  groupLabel?: string
  groupMasterId?: string
  variantBandwidth?: number
  audioUrl?: string
  audioOptions?: Array<{ url: string; label: string }>
  width?: number
  height?: number
  duration?: number
  /** Page/API supplied poster, used when a stream itself has no thumbnail. */
  coverUrl?: string
  /** 嗅探到该资源时的网页标题（用于在列表中显示，避免页面跳转后旧资源标题错乱） */
  tabTitle?: string
  /** 直播流标记（HTTP-FLV/MPEG-TS 无 Content-Length/Duration 时为 true） */
  isLiveStream?: boolean
}

function tabKey(tabId: number) {
  return `${PREFIX}${tabId}`
}

const useSessionStorage = typeof browser !== 'undefined' && !!browser.storage?.session

async function getSessionData(): Promise<Record<string, any>> {
  if (useSessionStorage) {
    return await browser.storage.session.get(null)
  }
  const result = await browser.storage.local.get('__session__')
  return (result['__session__'] as Record<string, any>) || {}
}

async function setSessionData(data: Record<string, any>): Promise<void> {
  if (useSessionStorage) {
    await browser.storage.session.set(data)
  } else {
    const existing = await browser.storage.local.get('__session__')
    const merged = { ...(existing['__session__'] as Record<string, any> || {}), ...data }
    await browser.storage.local.set({ '__session__': merged })
  }
}

async function removeSessionData(keys: string | string[]): Promise<void> {
  if (useSessionStorage) {
    await browser.storage.session.remove(keys)
  } else {
    const existing = await browser.storage.local.get('__session__')
    const data = existing['__session__'] as Record<string, any> || {}
    const keyArr = Array.isArray(keys) ? keys : [keys]
    for (const k of keyArr) {
      delete data[k]
    }
    await browser.storage.local.set({ '__session__': data })
  }
}

export async function loadAllTabData(): Promise<Map<number, Map<string, MediaEntry>>> {
  const all = await getSessionData()
  const map = new Map<number, Map<string, MediaEntry>>()
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const tabIdStr = key.slice(PREFIX.length)
      const tabId = parseInt(tabIdStr, 10)
      if (!isNaN(tabId)) {
        const mediaMap = new Map<string, MediaEntry>()
        
        if (Array.isArray(value)) {
          value.forEach((url: string) => {
            if (url.startsWith('blob:') || url.startsWith('data:')) return
            mediaMap.set(url, { format: 'm3u8' })
          })
        } else if (typeof value === 'object' && value !== null) {
          Object.entries(value).forEach(([url, entry]) => {
            if (url.startsWith('blob:') || url.startsWith('data:')) return
            if (typeof entry === 'string') {
              mediaMap.set(url, { format: entry })
            } else if (entry && typeof entry === 'object') {
              const e = entry as any
              // Keep grouping/task metadata across service-worker restarts.
              mediaMap.set(url, { ...e, format: e.format || 'm3u8', size: typeof e.size === 'number' ? e.size : undefined })
            }
          })
        }
        
        map.set(tabId, mediaMap)
      }
    }
  }
  return map
}

export async function saveTabList(tabId: number, mediaMap: Map<string, MediaEntry>) {
  const obj: Record<string, MediaEntry> = {}
  mediaMap.forEach((entry, url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return
    obj[url] = entry
  })
  await setSessionData({ [tabKey(tabId)]: obj })
}

export async function deleteTabList(tabId: number) {
  await removeSessionData(tabKey(tabId))
}
