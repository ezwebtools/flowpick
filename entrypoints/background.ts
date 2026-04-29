import { detectMediaFromUrl, detectMedia } from '../utils/detect'
import { loadAllTabData, saveTabList, deleteTabList, type MediaEntry } from '../utils/storage'
import { loadSettings, saveSettings, isFormatAllowed, isSizeAllowed, isDomainExcluded, type Settings } from '../utils/settings'
import MediaInfoFactory from 'mediainfo.js'

const mediaInfoCache = new Map<string, { width?: number; height?: number; duration?: number }>()

async function fetchMediaInfo(url: string): Promise<{ width?: number; height?: number; duration?: number } | null> {
  if (mediaInfoCache.has(url)) {
    return mediaInfoCache.get(url)!
  }
  
  try {
    const mediaInfo = await MediaInfoFactory({
      format: 'JSON',
      locateFile: () => browser.runtime.getURL('MediaInfoModule.wasm')
    })
    
    const getSize = async () => {
      const response = await fetch(url, { method: 'HEAD' })
      const contentLength = response.headers.get('Content-Length')
      return contentLength ? parseInt(contentLength, 10) : 0
    }
    
    const readChunk = async (chunkSize: number, offset: number): Promise<Uint8Array> => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` }
      })
      const buffer = await response.arrayBuffer()
      return new Uint8Array(buffer)
    }
    
    const result = await mediaInfo.analyzeData(getSize, readChunk)
    mediaInfo.close()
    
    if (result) {
      const parsed = JSON.parse(result)
      const info: { width?: number; height?: number; duration?: number } = {}
      
      const videoTrack = parsed.media?.track?.find((t: any) => t['@type'] === 'Video')
      if (videoTrack) {
        info.width = parseInt(videoTrack.Width, 10)
        info.height = parseInt(videoTrack.Height, 10)
      }
      
      const audioTrack = parsed.media?.track?.find((t: any) => t['@type'] === 'Audio')
      const generalTrack = parsed.media?.track?.find((t: any) => t['@type'] === 'General')
      
      const durationStr = audioTrack?.Duration || generalTrack?.Duration
      if (durationStr) {
        info.duration = parseFloat(durationStr)
      }
      
      if (info.width || info.height || info.duration) {
        mediaInfoCache.set(url, info)
        return info
      }
    }
  } catch (e) {
    console.warn('Failed to fetch media info:', e)
  }
  return null
}

async function fetchVideoDimensions(url: string): Promise<{ width: number; height: number } | null> {
  const info = await fetchMediaInfo(url)
  if (info?.width && info?.height) {
    return { width: info.width, height: info.height }
  }
  return null
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      const welcomeUrl = browser.runtime.getURL('/welcome.html' as any)
      browser.tabs.create({ url: welcomeUrl })
    }
  })

  browser.runtime.setUninstallURL('https://github.com/1337-ops/m3u8-downloader-ext')

  const tabMap = new Map<number, Map<string, MediaEntry>>()
  const tabPageUrls = new Map<number, string>()
  let isDataLoaded = false
  const pendingMessages: Array<{msg: any, sender: any, sendResponse: (response?: any) => void}> = []

  interface DownloadSession {
    url: string
    format: string
    filename: string
    sourceUrl: string
  }
  const downloadSessions = new Map<string, DownloadSession>()
  const pendingDownloads = new Map<number, DownloadSession>()

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
    for (const key of processedRequests) {
      if (key.startsWith(`${tabId}:`)) {
        processedRequests.delete(key)
      }
    }
    pendingDownloads.delete(tabId)
    tabMap.delete(tabId)
    tabPageUrls.delete(tabId)
    deleteTabList(tabId)
  })

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const asyncTypes = ['OPEN_DOWNLOAD_PAGE', 'FLOWPICK_DOWNLOAD_READY', 'GET_VIDEO_DIMENSIONS', 'GET_AUDIO_DURATION', 'GET_MEDIA_INFO', 'GET_SETTINGS', 'SAVE_SETTINGS']
    if (asyncTypes.includes(msg.type)) {
      handleMessage(msg, sender, sendResponse)
      return true
    }
    if (!isDataLoaded) {
      pendingMessages.push({msg, sender, sendResponse})
      return true
    }
    handleMessage(msg, sender, sendResponse)
    return true
  })

  async function handleMessage(msg: any, sender: any, sendResponse: (response?: any) => void) {
    if (msg.type === 'MEDIA_FOUND') {
      const tabId = msg.tabId || sender.tab?.id
      const format = msg.format || 'm3u8'
      if (tabId) addMedia(msg.url, tabId, format)
    }

    if (msg.type === 'OPEN_DOWNLOAD_PAGE') {
      const { url, format, filename } = msg
      const sourceUrl = sender.tab?.url || ''
      const downloaderPage = format === 'mpd' ? 'dash-downloader' : 'm3u8-downloader'
      const tab = await browser.tabs.create({ url: `http://localhost:3001/${downloaderPage}` })
      if (tab.id) {
        pendingDownloads.set(tab.id, { url, format, filename, sourceUrl })
      }
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === 'FLOWPICK_DOWNLOAD_READY') {
      const tabId = sender.tab?.id
      if (tabId && pendingDownloads.has(tabId)) {
        const session = pendingDownloads.get(tabId)!
        pendingDownloads.delete(tabId)
        sendResponse({ ok: true, url: session.url, format: session.format, filename: session.filename, sourceUrl: session.sourceUrl })
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
      sendResponse(sender.tab)
      return true
    }

    if (msg.type === 'GET_VIDEO_DIMENSIONS') {
      const url = msg.url as string
      fetchVideoDimensions(url).then(dimensions => {
        sendResponse(dimensions)
      })
      return true
    }

    if (msg.type === 'GET_AUDIO_DURATION') {
      const url = msg.url as string
      fetchMediaInfo(url).then(info => {
        sendResponse(info?.duration ? { duration: info.duration } : null)
      })
      return true
    }

    if (msg.type === 'GET_MEDIA_INFO') {
      const url = msg.url as string
      fetchMediaInfo(url).then(info => {
        sendResponse(info)
      })
      return true
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
    if (browser.action.setBadgeTextColor) {
      browser.action.setBadgeTextColor({ color: '#FFFFFF', tabId })
    }
    browser.action.setBadgeBackgroundColor({ color: '#EF4444', tabId })
  }

  function broadcast(tabId: number, list: Array<{url: string, format: string, size?: number}>) {
    browser.runtime.sendMessage({ type: 'LIST_UPDATED', tabId, list }).catch(() => {})
  }
})
