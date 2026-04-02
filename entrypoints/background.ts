export default defineBackground(() => {
  const tabMap = new Map<number, Set<string>>()

  // SW 重启后从 session storage 恢复数据
  loadAllTabData().then(data => {
    data.forEach((set, tabId) => tabMap.set(tabId, set))
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) updateBadge(tabs[0].id)
    })
  })

  browser.tabs.onRemoved.addListener((tabId) => {
    tabMap.delete(tabId)
    deleteTabList(tabId)
  })

  browser.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId > 0 && isM3U8(details.url)) {
        addM3U8(details.url, details.tabId)
      }
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  )

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'M3U8_FOUND') {
      const tabId = sender.tab?.id
      if (tabId) addM3U8(msg.url, tabId)
    }

    if (msg.type === 'GET_LIST') {
      const tabId = msg.tabId as number
      return Promise.resolve([...(tabMap.get(tabId) ?? [])])
    }

    if (msg.type === 'CLEAR_LIST') {
      const tabId = msg.tabId as number
      tabMap.delete(tabId)
      deleteTabList(tabId)
      updateBadge(tabId)
      broadcast(tabId, [])
    }
  })

  function addM3U8(url: string, tabId: number) {
    if (!tabMap.has(tabId)) tabMap.set(tabId, new Set())
    const set = tabMap.get(tabId)!
    if (set.has(url)) return
    set.add(url)
    const list = [...set]
    saveTabList(tabId, list)
    updateBadge(tabId)
    broadcast(tabId, list)
  }

  function updateBadge(tabId: number) {
    const count = tabMap.get(tabId)?.size ?? 0
    browser.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId })
    browser.action.setBadgeTextColor({ color: '#FFFFFF', tabId })
    browser.action.setBadgeBackgroundColor({ color: '#3B82F6', tabId })
  }

  function broadcast(tabId: number, list: string[]) {
    browser.runtime.sendMessage({ type: 'LIST_UPDATED', tabId, list }).catch(() => {})
  }
})
