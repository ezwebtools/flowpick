import { detectMediaFromUrl, detectMedia } from '../utils/detect'
import { loadAllTabData, saveTabList, deleteTabList, type MediaEntry } from '../utils/storage'
import { loadSettings, saveSettings, isFormatAllowed, isSizeAllowed, isDomainExcluded, type Settings } from '../utils/settings'

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
  return baseUrl
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    // 获取用户语言
    const userLanguage = getUserLanguage()
    
    if (details.reason === 'install') {
      const welcomeUrl = buildUrl(URL_CONFIG.welcome, userLanguage)
      browser.tabs.create({ url: welcomeUrl })
    } else if (details.reason === 'update') {
      const changelogUrl = buildUrl(URL_CONFIG.changelog, userLanguage)
      browser.tabs.create({ url: changelogUrl })
    }
  })

  // 卸载反馈URL也需要支持多语言
  const userLanguage = getUserLanguage()
  const uninstallUrl = buildUrl(URL_CONFIG.uninstallFeedback, userLanguage)
  browser.runtime.setUninstallURL(uninstallUrl)

  const tabMap = new Map<number, Map<string, MediaEntry>>()
  const tabPageUrls = new Map<number, string>()
  let isDataLoaded = false
  const pendingMessages: Array<{msg: any, sender: any, sendResponse: (response?: any) => void}> = []

  interface DownloadSession {
    url: string
    format: string
    filename: string
  }
  const downloadSessions = new Map<string, DownloadSession>()

  let currentSettings: Settings
  loadSettings().then(s => { currentSettings = s })

  browser.storage.local.onChanged.addListener((changes) => {
    if (changes['ext_settings']) {
      loadSettings().then(s => { currentSettings = s })
    }
  })

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      tabPageUrls.set(tabId, changeInfo.url)
    } else if (tab.url) {
      tabPageUrls.set(tabId, tab.url)
    }
  })

  loadAllTabData().then(data => {
    data.forEach((mediaMap, tabId) => {
      tabMap.set(tabId, mediaMap)
    })
    isDataLoaded = true
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) {
        updateBadge(tabs[0].id)
      }
    })
    
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
        console.log('Background: onHeadersReceived:', requestKey, 'tabId:', details.tabId)
        console.log(details, 'details')
        console.log(details.responseHeaders, 'responseHeaders')
        if (processedRequests.has(requestKey)) {
          return
        }
        
        let contentType: string | null = null
        let contentLength: number | undefined = undefined
        let hasContentRange = false
        let isFullFileRequest = false
        if (details.responseHeaders) {
          for (const header of details.responseHeaders) {
            const lowerName = header.name.toLowerCase()
            if (lowerName === 'content-type' && header.value) {
              contentType = header.value
            } else if (lowerName === 'content-length' && header.value) {
              const parsed = parseInt(header.value, 10)
              if (!isNaN(parsed)) contentLength = parsed
            } else if (lowerName === 'content-range' && header.value) {
              hasContentRange = true
              // 解析 content-range: bytes start-end/total
              const match = header.value.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i)
              if (match) {
                const start = parseInt(match[1], 10)
                const end = parseInt(match[2], 10)
                const total = parseInt(match[3], 10)
                // 如果从0开始，且end+1等于total，说明是完整文件
                if (start === 0 && end + 1 === total) {
                  isFullFileRequest = true
                }
              }
            }
          }
        }
        
        const detectedFormat = detectMedia(details.url, contentType)
        if (detectedFormat) {
          // 如果是mp4格式且带有content-range，但不是完整文件请求，则排除
          if (detectedFormat === 'mp4' && hasContentRange && !isFullFileRequest) {
            return
          }
          const settings = currentSettings
          const pageUrl = tabPageUrls.get(details.tabId)
          if (settings && pageUrl && isDomainExcluded(pageUrl, settings)) return
          if (settings && !isFormatAllowed(detectedFormat, settings)) return
          if (settings && !isSizeAllowed(detectedFormat, contentLength, settings)) return
          addMedia(details.url, details.tabId, detectedFormat, contentLength)
          processedRequests.add(requestKey)
        }
      }
      return undefined
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'sub_frame','image'] },
    ['responseHeaders'],
  )
  
  // 在请求开始前检测URL中的媒体格式（对于没有content-type或content-type不明确的请求）
  // 所有媒体格式都在onHeadersReceived阶段处理以获取文件大小
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      // 不再在onBeforeRequest阶段添加任何媒体格式
      // 所有媒体格式都在onHeadersReceived阶段处理以获取文件大小
      return undefined
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'sub_frame'] },
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
    tabPageUrls.delete(tabId)
    deleteTabList(tabId)
  })

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'OPEN_DOWNLOAD_PAGE' || msg.type === 'PAGE_READY') {
      return handleMessage(msg, sender, sendResponse)
    }
    if (!isDataLoaded) {
      pendingMessages.push({msg, sender, sendResponse})
      return true
    }
    return handleMessage(msg, sender, sendResponse)
  })

  function handleMessage(msg: any, sender: any, sendResponse: (response?: any) => void) {
    if (msg.type === 'MEDIA_FOUND') {
      const tabId = msg.tabId || sender.tab?.id
      const format = msg.format || 'm3u8'
      if (tabId) addMedia(msg.url, tabId, format)
    }

    if (msg.type === 'OPEN_DOWNLOAD_PAGE') {
      const { url, format, filename } = msg
      const sessionId = crypto.randomUUID()
      downloadSessions.set(sessionId, { url, format, filename })
      const baseUrl = browser.runtime.getURL('/download.html' as any)
      browser.tabs.create({ url: `${baseUrl}?session=${sessionId}` })
      sendResponse({ sessionId })
      return true
    }

    if (msg.type === 'PAGE_READY') {
      const sessionId = msg.sessionId as string
      const session = downloadSessions.get(sessionId)
      if (session) {
        downloadSessions.delete(sessionId)
        sendResponse({ ok: true, url: session.url, format: session.format, filename: session.filename })
      } else {
        sendResponse({ ok: false })
      }
      return true
    }

    if (msg.type === 'GET_LIST') {
      const tabId = msg.tabId as number
      const mediaMap = tabMap.get(tabId)
      const list: Array<{url: string, format: string, size?: number}> = []
      if (mediaMap) {
        mediaMap.forEach((entry, url) => {
          list.push({ url, format: entry.format, size: entry.size })
        })
      }
      sendResponse(list)
      return true
    }

    if (msg.type === 'GET_CURRENT_TAB') {
      return Promise.resolve(sender.tab)
    }

    if (msg.type === 'GET_SETTINGS') {
      loadSettings().then(s => sendResponse(s))
      return true
    }

    if (msg.type === 'SAVE_SETTINGS') {
      saveSettings(msg.settings).then(() => sendResponse({ ok: true }))
      return true
    }

    return false
  }

  function addMedia(url: string, tabId: number, format: string, size?: number) {
    if (!tabMap.has(tabId)) {
      tabMap.set(tabId, new Map())
    }
    const mediaMap = tabMap.get(tabId)!
    if (mediaMap.has(url)) {
      return
    }
    mediaMap.set(url, { format, size })
    const list: Array<{url: string, format: string, size?: number}> = []
    mediaMap.forEach((entry, url) => {
      list.push({ url, format: entry.format, size: entry.size })
    })
    saveTabList(tabId, mediaMap)
    updateBadge(tabId)
    broadcast(tabId, list)
  }

  function updateBadge(tabId: number) {
    const mediaMap = tabMap.get(tabId)
    const count = mediaMap?.size ?? 0
    browser.action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId })
    browser.action.setBadgeTextColor({ color: '#FFFFFF', tabId })
    browser.action.setBadgeBackgroundColor({ color: '#3B82F6', tabId })
  }

  function broadcast(tabId: number, list: Array<{url: string, format: string, size?: number}>) {
    browser.runtime.sendMessage({ type: 'LIST_UPDATED', tabId, list }).catch(() => {})
  }
})
