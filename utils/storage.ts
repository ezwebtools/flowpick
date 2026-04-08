const PREFIX = 'tab_'

export interface MediaEntry {
  format: string
  size?: number
}

function tabKey(tabId: number) {
  return `${PREFIX}${tabId}`
}

export async function loadAllTabData(): Promise<Map<number, Map<string, MediaEntry>>> {
  const all = await browser.storage.session.get(null)
  const map = new Map<number, Map<string, MediaEntry>>()
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const tabIdStr = key.slice(PREFIX.length)
      const tabId = parseInt(tabIdStr, 10)
      if (!isNaN(tabId)) {
        const mediaMap = new Map<string, MediaEntry>()
        
        if (Array.isArray(value)) {
          value.forEach((url: string) => {
            mediaMap.set(url, { format: 'm3u8' })
          })
        } else if (typeof value === 'object' && value !== null) {
          Object.entries(value).forEach(([url, entry]) => {
            if (typeof entry === 'string') {
              mediaMap.set(url, { format: entry })
            } else if (entry && typeof entry === 'object') {
              const e = entry as any
              mediaMap.set(url, { format: e.format || 'm3u8', size: typeof e.size === 'number' ? e.size : undefined })
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
    obj[url] = entry
  })
  await browser.storage.session.set({ [tabKey(tabId)]: obj })
}

export async function deleteTabList(tabId: number) {
  await browser.storage.session.remove(tabKey(tabId))
}
