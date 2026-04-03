const PREFIX = 'tab_'

function tabKey(tabId: number) {
  return `${PREFIX}${tabId}`
}

export async function loadAllTabData(): Promise<Map<number, Map<string, string>>> {
  const all = await browser.storage.session.get(null)
  const map = new Map<number, Map<string, string>>()
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const tabIdStr = key.slice(PREFIX.length)
      const tabId = parseInt(tabIdStr, 10)
      if (!isNaN(tabId)) {
        const mediaMap = new Map<string, string>()
        
        if (Array.isArray(value)) {
          // 旧数据格式：string[]，默认格式为'm3u8'
          value.forEach((url: string) => {
            mediaMap.set(url, 'm3u8')
          })
        } else if (typeof value === 'object' && value !== null) {
          // 新数据格式：{url: format}
          Object.entries(value).forEach(([url, format]) => {
            if (typeof format === 'string') {
              mediaMap.set(url, format)
            }
          })
        }
        
        map.set(tabId, mediaMap)
      }
    }
  }
  return map
}

export async function saveTabList(tabId: number, mediaMap: Map<string, string>) {
  // 将Map转换为普通对象
  const obj: Record<string, string> = {}
  mediaMap.forEach((format, url) => {
    obj[url] = format
  })
  await browser.storage.session.set({ [tabKey(tabId)]: obj })
}

export async function deleteTabList(tabId: number) {
  await browser.storage.session.remove(tabKey(tabId))
}
