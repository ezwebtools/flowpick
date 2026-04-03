import { isMediaFormat, detectMediaFromUrl, detectMediaFromContentType, detectMedia } from '../utils/detect'
import { loadAllTabData, saveTabList, deleteTabList } from '../utils/storage'

// 语言映射配置
const LANGUAGE_MAP: Record<string, string> = {
  'zh_CN': 'zh-CN',
  'en': 'en-us',
  // 可以添加更多语言映射
}

// 默认语言（不添加语言代码）
const DEFAULT_LANGUAGE = 'en'

// 基础URL配置
const URL_CONFIG = {
  welcome: 'https://example.com',
  changelog: 'https://example.com/changelog',
  uninstallFeedback: 'https://example.com/uninstall-feedback'
}

// 获取用户语言代码
function getUserLanguage(): string {
  // 首先尝试从浏览器UI语言获取
  const uiLanguage = browser.i18n.getUILanguage()
  console.log('Browser UI language:', uiLanguage)
  
  // 标准化语言代码（例如：zh-CN -> zh_CN）
  const normalizedLang = uiLanguage.replace('-', '_')
  return normalizedLang
}

// 根据语言构建URL
function buildUrl(baseUrl: string, language: string): string {
  // 如果是默认语言，不添加语言代码
  if (language === DEFAULT_LANGUAGE) {
    return baseUrl
  }
  
  // 检查语言是否在映射表中
  const mappedLang = LANGUAGE_MAP[language]
  if (mappedLang) {
    // 确保URL以斜杠结尾，然后添加语言代码
    const url = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
    return url + mappedLang
  }
  
  // 如果语言不在映射表中，使用默认语言（不添加语言代码）
  console.log(`Language ${language} not in language map, using default language`)
  return baseUrl
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    console.log('Extension installed/updated:', details.reason)
    
    // 获取用户语言
    const userLanguage = getUserLanguage()
    console.log('User language:', userLanguage)
    
    if (details.reason === 'install') {
      const welcomeUrl = buildUrl(URL_CONFIG.welcome, userLanguage)
      browser.tabs.create({ url: welcomeUrl })
      console.log('Opened welcome page:', welcomeUrl)
    } else if (details.reason === 'update') {
      const changelogUrl = buildUrl(URL_CONFIG.changelog, userLanguage)
      browser.tabs.create({ url: changelogUrl })
      console.log('Opened changelog page:', changelogUrl)
    }
  })

  // 卸载反馈URL也需要支持多语言
  const userLanguage = getUserLanguage()
  const uninstallUrl = buildUrl(URL_CONFIG.uninstallFeedback, userLanguage)
  browser.runtime.setUninstallURL(uninstallUrl)
  console.log('Set uninstall URL:', uninstallUrl)

  const tabMap = new Map<number, Map<string, string>>()
  let isDataLoaded = false
  const pendingMessages: Array<{msg: any, sender: any, sendResponse: (response?: any) => void}> = []

  loadAllTabData().then(data => {
    console.log('Background: Data loaded, tab count:', data.size)
    data.forEach((urls, tabId) => {
      console.log(`Background: Tab ${tabId} has ${urls.size} items`)
      // 将数组转换为Map格式
      const mediaMap = new Map<string, string>()
      // 旧数据格式：string[]，新数据格式：Map<string, string>
      if (Array.isArray(urls)) {
        // 旧数据格式，默认格式为'm3u8'
        urls.forEach(url => {
          mediaMap.set(url, 'm3u8')
        })
      } else if (urls instanceof Map) {
        // 新数据格式
        urls.forEach((format, url) => {
          mediaMap.set(url, format)
        })
      }
      tabMap.set(tabId, mediaMap)
    })
    isDataLoaded = true
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) {
        console.log(`Background: Updating badge for tab ${tabs[0].id}`)
        updateBadge(tabs[0].id)
      }
    })
    
    console.log(`Background: Processing ${pendingMessages.length} pending messages`)
    pendingMessages.forEach(({msg, sender, sendResponse}) => {
      handleMessage(msg, sender, sendResponse)
    })
    pendingMessages.length = 0
  })

  // 用于跟踪已经处理过的请求，避免重复添加
  const processedRequests = new Set<string>()
  
  // 在接收到响应头时检测媒体格式（优先使用content-type）
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId > 0) {
        const requestKey = `${details.tabId}:${details.url}`
        
        // 如果已经处理过这个请求，跳过
        if (processedRequests.has(requestKey)) {
          return
        }
        
        // 提取content-type
        let contentType: string | null = null
        if (details.responseHeaders) {
          for (const header of details.responseHeaders) {
            if (header.name.toLowerCase() === 'content-type' && header.value) {
              contentType = header.value
              break
            }
          }
        }
        
        // 使用综合检测函数：优先content-type，备选URL检测
        const detectedFormat = detectMedia(details.url, contentType)
        if (detectedFormat) {
          console.log('Detected media format:', detectedFormat, 
                     contentType ? 'from content-type' : 'from URL (fallback)', 
                     'URL:', details.url)
          addMedia(details.url, details.tabId, detectedFormat)
          processedRequests.add(requestKey)
        }
      }
      return undefined // 返回undefined表示不修改响应头
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  )
  
  // 在请求开始前检测URL中的媒体格式（对于没有content-type或content-type不明确的请求）
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId > 0) {
        const requestKey = `${details.tabId}:${details.url}`
        
        // 如果已经处理过这个请求，跳过
        if (processedRequests.has(requestKey)) {
          return
        }
        
        // 对于某些类型的请求，可能在onHeadersReceived阶段没有content-type
        // 这里使用URL检测作为补充
        const urlFormat = detectMediaFromUrl(details.url)
        if (urlFormat) {
          console.log('Detected media format from URL (pre-request):', urlFormat, 'URL:', details.url)
          addMedia(details.url, details.tabId, urlFormat)
          processedRequests.add(requestKey)
        }
      }
      return undefined // 返回undefined表示不阻塞请求
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  )
  
  // 清理已处理的请求记录（当标签页关闭时）
  browser.tabs.onRemoved.addListener((tabId) => {
    // 移除该标签页的所有请求记录
    for (const key of processedRequests) {
      if (key.startsWith(`${tabId}:`)) {
        processedRequests.delete(key)
      }
    }
    tabMap.delete(tabId)
    deleteTabList(tabId)
  })

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isDataLoaded) {
      pendingMessages.push({msg, sender, sendResponse})
      return true
    }
    return handleMessage(msg, sender, sendResponse)
  })

  function handleMessage(msg: any, sender: any, sendResponse: (response?: any) => void) {
    console.log('Background: Received message:', msg.type, 'from tab:', sender.tab?.id)
    
    if (msg.type === 'MEDIA_FOUND') {
      const tabId = msg.tabId || sender.tab?.id
      const format = msg.format || 'm3u8'
      console.log('Background: MEDIA_FOUND for tab', tabId, 'url:', msg.url, 'format:', format)
      if (tabId) addMedia(msg.url, tabId, format)
    }

    if (msg.type === 'GET_LIST') {
      const tabId = msg.tabId as number
      const mediaMap = tabMap.get(tabId)
      const list: Array<{url: string, format: string}> = []
      if (mediaMap) {
        mediaMap.forEach((format, url) => {
          list.push({ url, format })
        })
      }
      console.log('Background: GET_LIST for tab', tabId, 'returning', list.length, 'items')
      sendResponse(list)
      return true
    }

    if (msg.type === 'GET_CURRENT_TAB') {
      return Promise.resolve(sender.tab)
    }
    return false
  }

  function addMedia(url: string, tabId: number, format: string) {
    console.log('Background: addMedia for tab', tabId, 'url:', url, 'format:', format)
    if (!tabMap.has(tabId)) {
      console.log('Background: Creating new map for tab', tabId)
      tabMap.set(tabId, new Map())
    }
    const mediaMap = tabMap.get(tabId)!
    if (mediaMap.has(url)) {
      console.log('Background: URL already exists for tab', tabId)
      return
    }
    mediaMap.set(url, format)
    const list: Array<{url: string, format: string}> = []
    mediaMap.forEach((format, url) => {
      list.push({ url, format })
    })
    console.log('Background: Tab', tabId, 'now has', list.length, 'items')
    saveTabList(tabId, mediaMap)
    updateBadge(tabId)
    broadcast(tabId, list)
  }

  function updateBadge(tabId: number) {
    const mediaMap = tabMap.get(tabId)
    const count = mediaMap?.size ?? 0
    console.log('Background: updateBadge for tab', tabId, 'count:', count)
    browser.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId })
    browser.action.setBadgeTextColor({ color: '#FFFFFF', tabId })
    browser.action.setBadgeBackgroundColor({ color: '#3B82F6', tabId })
  }

  function broadcast(tabId: number, list: Array<{url: string, format: string}>) {
    browser.runtime.sendMessage({ type: 'LIST_UPDATED', tabId, list }).catch(() => {})
  }
})
