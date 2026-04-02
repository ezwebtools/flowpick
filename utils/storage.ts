const PREFIX = 'tab_'

function tabKey(tabId: number) {
  return `${PREFIX}${tabId}`
}

export async function loadAllTabData(): Promise<Map<number, Set<string>>> {
  const all = await browser.storage.session.get(null)
  const map = new Map<number, Set<string>>()
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PREFIX)) {
      const tabId = parseInt(key.slice(PREFIX.length))
      if (!isNaN(tabId)) {
        map.set(tabId, new Set(value as string[]))
      }
    }
  }
  return map
}

export async function saveTabList(tabId: number, list: string[]) {
  await browser.storage.session.set({ [tabKey(tabId)]: list })
}

export async function deleteTabList(tabId: number) {
  await browser.storage.session.remove(tabKey(tabId))
}
