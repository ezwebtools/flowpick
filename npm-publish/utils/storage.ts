const PREFIX = 'tab_'

export interface MediaEntry {
  format: string
  size?: number
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
  await setSessionData({ [tabKey(tabId)]: obj })
}

export async function deleteTabList(tabId: number) {
  await removeSessionData(tabKey(tabId))
}
