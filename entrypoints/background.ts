import { detectMediaFromUrl, detectMedia, detectDoc, type MediaCategory } from '../utils/detect'
import { loadAllTabData, saveTabList, deleteTabList, type MediaEntry } from '../utils/storage'
import { loadSettings, saveSettings, isFormatAllowed, isSizeAllowed, isDomainExcluded, getFormatGroup, type Settings, DEFAULT_SETTINGS } from '../utils/settings'
import { parseM3U8Manifest, parseDashManifest } from '../utils/stream-parser'
import MediaInfoFactory from 'mediainfo.js'
import type { MetadataBatchItem, MetadataBatchRequest, MetadataBatchResult } from './popup/types'
import type { PlatformMediaTask } from '../utils/platform-media'

const mediaInfoCache = new Map<string, { width?: number; height?: number; duration?: number }>()
// 失败负缓存：同一 URL 在 TTL 内不再重试 analyzeData，避免反复拉取分片（表现为"任务一直下载"）且刷屏报错
const mediaInfoFailCache = new Map<string, number>()
const MEDIA_INFO_FAIL_TTL_MS = 60_000
const metadataBatchControllers = new Map<string, AbortController>()

// ── 资源健康度跟踪 ──────────────────────────────────────────────────
// 元数据批量请求失败的资源会累计失败次数；连续失败且未拿到任何有效元数据时
// 自动从 mediaMap 剔除，并加入坏 URL 黑名单，避免反复嗅探→请求→失败的循环。
// 黑名单带 TTL（默认 10 分钟），到期后允许重新嗅探（资源可能已恢复）。
const urlFailureCount = new Map<string, { count: number; lastFail: number }>()
const badUrlBlacklist = new Map<string, number>() // url → 加入黑名单的时间戳
const URL_FAILURE_THRESHOLD = 2       // 连续失败次数阈值，达到则剔除并拉黑
const BAD_URL_TTL_MS = 10 * 60_000   // 黑名单有效期 10 分钟
const BAD_URL_MAX = 2000             // 黑名单上限，超限淘汰最旧

function isUrlBlacklisted(url: string): boolean {
  const ts = badUrlBlacklist.get(url)
  if (!ts) return false
  if (Date.now() - ts > BAD_URL_TTL_MS) {
    badUrlBlacklist.delete(url)
    return false
  }
  return true
}

function blacklistUrl(url: string) {
  badUrlBlacklist.set(url, Date.now())
  urlFailureCount.delete(url)
  // LRU 淘汰：超阈值时删除最旧的一批
  if (badUrlBlacklist.size > BAD_URL_MAX) {
    const sorted = [...badUrlBlacklist.entries()].sort((a, b) => a[1] - b[1])
    const evict = Math.min(200, sorted.length)
    for (let i = 0; i < evict; i++) {
      const [u] = sorted[i]!
      badUrlBlacklist.delete(u)
    }
  }
}

function recordUrlFailure(url: string): boolean {
  const entry = urlFailureCount.get(url) ?? { count: 0, lastFail: 0 }
  entry.count += 1
  entry.lastFail = Date.now()
  urlFailureCount.set(url, entry)
  return entry.count >= URL_FAILURE_THRESHOLD
}

function clearUrlFailure(url: string) {
  urlFailureCount.delete(url)
}

async function fetchMediaInfo(url: string, signal?: AbortSignal): Promise<{ width?: number; height?: number; duration?: number } | null> {
  signal?.throwIfAborted()
  if (mediaInfoCache.has(url)) {
    return mediaInfoCache.get(url)!
  }
  const lastFail = mediaInfoFailCache.get(url)
  if (lastFail && Date.now() - lastFail < MEDIA_INFO_FAIL_TTL_MS) {
    return null
  }

  try {
    const mediaInfo = await MediaInfoFactory({
      format: 'JSON',
      locateFile: () => browser.runtime.getURL('MediaInfoModule.wasm' as any)
    })

    const getSize = async () => {
      // HEAD 可能被服务器拒绝或被 CORS 拦截，绝不能让它抛错导致整个分析失败
      try {
        const headResp = await fetch(url, { method: 'HEAD', signal })
        const cl = headResp.headers.get('Content-Length')
        if (cl) {
          const n = parseInt(cl, 10)
          if (!Number.isNaN(n) && n > 0) return n
        }
      } catch { /* 落到下面的 Range 探测 */ }

      // HEAD 不可用：用 Range 探测总大小（很多 CDN 在 206 响应的 Content-Range 里带总数）
      try {
        const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal })
        const cr = probe.headers.get('Content-Range')
        if (cr) {
          const m = /\/\s*(\d+)\s*$/.exec(cr)
          if (m) {
            const n = parseInt(m[1], 10)
            if (!Number.isNaN(n) && n > 0) return n
          }
        }
      } catch { /* 忽略，返回 0 */ }

      return 0
    }

    // 整文件缓存：当服务器不支持 Range（返回 200 而非 206）时，首次拉取整文件，
    // 之后按 offset 切片返回；到达文件末尾返回空，避免 mediainfo 在 offset 越界后
    // 仍反复请求、形成"后台一直拉取分片"的死循环，同时避免重复下载同一文件。
    let fullBodyCache: Uint8Array | null = null
    const readChunk = async (chunkSize: number, offset: number): Promise<Uint8Array> => {
      // 已缓存整文件（服务器忽略 Range 的情况）：按 offset 切片，越界即返回空结束
      if (fullBodyCache) {
        if (offset >= fullBodyCache.length) return new Uint8Array(0)
        return fullBodyCache.subarray(offset, offset + chunkSize)
      }
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` },
        cache: 'no-store',
        signal,
      })
      if (response.status === 416) {
        return new Uint8Array(0)
      }
      // 服务器忽略 Range，返回整文件（常见于部分 CDN / 流媒体分片）：缓存后按 offset
      // 切片，越界返回空数组让 mediainfo 正常结束，杜绝无限循环且不重复下载。
      if (response.status === 200) {
        const buf = new Uint8Array(await response.arrayBuffer())
        fullBodyCache = buf
        if (offset >= buf.length) return new Uint8Array(0)
        return buf.subarray(offset, offset + chunkSize)
      }
      // 非预期状态码（403/401 等）：直接抛错，让 analyzeData 干净地 reject（被外层兜成 null），
      // 而不是把错误响应体当媒体数据喂给 mediainfo 造成畸形 JSON
      if (!response.ok && response.status !== 206) {
        throw new Error(`readChunk HTTP ${response.status}`)
      }
      const buffer = await response.arrayBuffer()
      return new Uint8Array(buffer)
    }

    const result = await mediaInfo.analyzeData(getSize, readChunk)
    mediaInfo.close()

    if (result) {
      let parsed: any
      try {
        parsed = JSON.parse(result)
      } catch {
        // mediainfo 个别元数据会产出非严格 JSON，解析失败时放弃该 URL 的元数据，但不影响下载
        mediaInfoFailCache.set(url, Date.now())
        return null
      }
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
    if (signal?.aborted || (e as Error)?.name === 'AbortError') return null
    console.warn('[fetchMediaInfo] failed for', url, '-', (e as Error)?.message || e)
    // 负缓存：60s 内同一 URL 不再重试，解决"任务一直下载 + 反复刷错"
    mediaInfoFailCache.set(url, Date.now())
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

async function fetchContentLength(url: string, requestHeaders?: Record<string, string>, signal?: AbortSignal): Promise<{ ok: boolean; size: number | null; error?: string }> {
  const headers: Record<string, string> = {}
  if (requestHeaders && typeof requestHeaders === 'object') {
    for (const [key, value] of Object.entries(requestHeaders)) {
      const normalized = key.toLowerCase()
      if (normalized === 'referer' || normalized === 'origin' || normalized === 'cookie' || normalized === 'user-agent') {
        headers[key] = value
      }
    }
  }
  const parseContentRange = (value: string | null): number | null => {
    if (!value) return null
    const match = value.match(/\/(\d+)$/)
    return match ? parseInt(match[1], 10) : null
  }
  try {
    const headResponse = await fetch(url, { method: 'HEAD', headers, credentials: 'omit', cache: 'no-store', signal })
    if (headResponse.ok) {
      const contentLength = headResponse.headers.get('content-length')
      if (contentLength) return { ok: true, size: parseInt(contentLength, 10) }
      const contentRange = parseContentRange(headResponse.headers.get('content-range'))
      if (contentRange) return { ok: true, size: contentRange }
    }
    const rangeResponse = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
    if (rangeResponse.status === 206) {
      const contentRange = parseContentRange(rangeResponse.headers.get('content-range'))
      if (contentRange) return { ok: true, size: contentRange }
    }
    const contentLength = rangeResponse.headers.get('content-length')
    if (contentLength && rangeResponse.status === 200) {
      return { ok: true, size: parseInt(contentLength, 10) }
    }
    try { await rangeResponse.body?.cancel() } catch {}
    return { ok: true, size: null }
  } catch (error) {
    return { ok: false, size: null, error: (error as Error).message }
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  }))
  return results
}

export default defineBackground(() => {
  const chromeGlobal = (globalThis as any).chrome
  const nativeBrowser = (globalThis as any).browser
  const isFirefox = !!(nativeBrowser?.sidebarAction)
  // 必须同时具备 sidePanel、setOptions 与 open（且 open 为函数），否则视为不支持，
  // 保留 popup 作为兜底，避免 360 等浏览器"清空 popup 后 sidePanel 又打不开"的假死。
  const supportsChromeSidepanel =
    !isFirefox &&
    !!chromeGlobal?.sidePanel &&
    typeof chromeGlobal.sidePanel.setOptions === 'function' &&
    typeof chromeGlobal.sidePanel.open === 'function'
  const supportsFirefoxSidebar = isFirefox

  // Track open sidepanel ports per tab: tabId → Port（外层声明，供 isUiListening 等共用）
  const sidePanelPorts = new Map<number, any>()

  if (supportsChromeSidepanel) {
    const canOpenSidepanel = typeof chromeGlobal.sidePanel.open === 'function'
    const canSetOptions = typeof chromeGlobal.sidePanel.setOptions === 'function'

    if (canOpenSidepanel) {
      if (canSetOptions) {
        try { chromeGlobal.sidePanel.setOptions({ path: 'sidepanel.html', enabled: false }) } catch {}
      }
      chromeGlobal.action.setPopup({ popup: '' })

      // Track whether the sidepanel has confirmed it opened (via SIDEPANEL_OPENED message)
      let sidePanelReady = false

      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== 'sidepanel') return
        let registeredTabId: number | undefined

        port.onMessage.addListener((msg: any) => {
          if (msg?.type === 'SIDEPANEL_TAB_ID' && typeof msg.tabId === 'number') {
            registeredTabId = msg.tabId
            sidePanelPorts.set(msg.tabId, port)
          }
        })

        port.onDisconnect.addListener(() => {
          if (registeredTabId !== undefined) {
            sidePanelPorts.delete(registeredTabId)
          }
        })
      })

      browser.runtime.onMessage.addListener((msg: any) => {
        if (msg.type === 'SIDEPANEL_OPENED') {
          sidePanelReady = true
        }
      })

      browser.action.onClicked.addListener((tab) => {
        if (tab.id !== undefined) {
          const existingPort = sidePanelPorts.get(tab.id)
          if (existingPort) {
            try { existingPort.postMessage({ type: 'SIDEPANEL_CLOSE_REQUEST' }) } catch {}
            return
          }

          sidebarClosedTabs.delete(tab.id)
          sidePanelReady = false
          if (canSetOptions) {
            try { chromeGlobal.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true }).catch(() => {}) } catch {}
          }

          let fellBack = false
          const fallbackToPopup = () => {
            if (fellBack) return
            fellBack = true
            console.warn('Falling back to popup (sidepanel unavailable)')
            chromeGlobal.action.setPopup({ popup: 'popup.html' })
            if (typeof chromeGlobal.action.openPopup === 'function') {
              try { chromeGlobal.action.openPopup().catch(() => {}) } catch {}
            }
          }

          try {
            const result = chromeGlobal.sidePanel.open({ tabId: tab.id })
            if (result && typeof result.then === 'function') {
              result.catch((e: any) => {
                console.warn('Failed to open sidepanel:', e)
                fallbackToPopup()
              })
              // Timeout: if sidepanel hasn't confirmed it loaded within 2s, fall back
              setTimeout(() => {
                if (!sidePanelReady && !fellBack) {
                  fallbackToPopup()
                }
              }, 2000)
            } else {
              // open() didn't return a promise — sidepanel not truly supported
              fallbackToPopup()
            }
          } catch (e) {
            console.warn('Failed to open sidepanel:', e)
            fallbackToPopup()
          }
        }
      })
    } else {
      chromeGlobal.action.setPopup({ popup: 'popup.html' })
    }
  } else if (supportsFirefoxSidebar) {
    const browserAction = nativeBrowser.browserAction || nativeBrowser.action
    browserAction.setPopup({ popup: '' })

    let firefoxSidebarOpen = false

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== 'sidepanel') return
      firefoxSidebarOpen = true
      port.onMessage.addListener((msg: any) => {
        if (msg?.type === 'SIDEPANEL_CLOSE_REQUEST') firefoxSidebarOpen = false
      })
      port.onDisconnect.addListener(() => {
        firefoxSidebarOpen = false
      })
    })

    browserAction.onClicked.addListener(async () => {
      try {
        if (firefoxSidebarOpen) {
          await nativeBrowser.sidebarAction.close()
        } else {
          await nativeBrowser.sidebarAction.open()
        }
      } catch (e) {
        console.warn('Failed to toggle sidebar:', e)
      }
    })
  } else {
    if (chromeGlobal?.action?.setPopup) {
      chromeGlobal.action.setPopup({ popup: 'popup.html' })
    }
  }

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      const welcomeUrl = browser.runtime.getURL('/welcome.html' as any)
      browser.tabs.create({ url: welcomeUrl })
    }
  })

  browser.runtime.onStartup.addListener(() => {})

  // browser.runtime.setUninstallURL('https://github.com/1337-ops/m3u8-downloader-ext')

  const tabMap = new Map<number, Map<string, MediaEntry>>()
  // Bilibili DASH URLs are handled by a virtual task; generic request sniffing
  // must not later turn its fMP4 tracks back into standalone cards.
  const bilibiliManagedUrls = new Map<number, Set<string>>()
  // Provider adapters can replace noisy network-level entries with a curated
  // set of variants without becoming coupled to the generic sniffer.
  const platformManagedUrls = new Map<number, Set<string>>()
  const platformTaskPriorities = new Map<number, Map<string, number>>()
  const douyinMediaMetadata = new Map<number, Map<string, { title?: string; coverUrl?: string; duration?: number }>>()
  // Native <video> preloads do not pass through the page's fetch/XHR hook.
  // Keep their short-lived playback-token relation in the background too.
  const douyinNativeTracks = new Map<number, Map<string, Array<{ url: string; role: 'video' | 'audio'; at: number }>>>()
  const tabPageUrls = new Map<number, string>()
  // 跟踪每个 tab 当前的网页标题（用于资源嗅探时记录"当时"的标题）
  const tabPageTitles = new Map<number, string>()

  // ts/.m4s 分片关联 master 用的前缀索引（按 tab 分桶）。
  // 把原来 addMedia 中对整个 mediaMap 的 O(N) 线性扫描替换为 O(1) Map 查找。
  // 结构：tabId → (prefix → masterUrl)，prefix = masterUrl 截到最后一个 '/' 的前缀。
  // 用版本号做失效：mediaMap 重建（如清空、tab 关闭）时 bump 版本，索引作废重建。
  const masterPrefixIndex = new Map<number, { version: number; map: Map<string, string[]> }>()
  const tabMediaVersion = new Map<number, number>()
  function bumpTabVersion(tabId: number) {
    tabMediaVersion.set(tabId, (tabMediaVersion.get(tabId) ?? 0) + 1)
  }
  // 构建指定 tab 的 master 前缀索引（懒构建，版本号变化时重建）
  function getMasterPrefixIndex(tabId: number, mediaMap: Map<string, MediaEntry>): Map<string, string[]> {
    const curVersion = tabMediaVersion.get(tabId) ?? 0
    let entry = masterPrefixIndex.get(tabId)
    if (!entry || entry.version !== curVersion) {
      // 重建：扫描一次 mediaMap，按 prefix 分桶
      const map = new Map<string, string[]>()
      for (const [mUrl, mEntry] of mediaMap) {
        if (mEntry.format === 'm3u8' && (mEntry.groupRole === 'master' || !mEntry.groupRole)) {
          const prefix = mUrl.substring(0, mUrl.lastIndexOf('/') + 1)
          if (!prefix) continue
          let arr = map.get(prefix)
          if (!arr) { arr = []; map.set(prefix, arr) }
          arr.push(mUrl)
        }
      }
      entry = { version: curVersion, map }
      masterPrefixIndex.set(tabId, entry)
    }
    return entry.map
  }
  // 给定分片 url，在索引中找前缀最长匹配的 master。
  // 从 segUrl 自身目录逐级向上回退，第一个命中的即为最长前缀匹配（O(路径深度) ≈ O(1)）
  function findMasterBySegmentUrl(tabId: number, mediaMap: Map<string, MediaEntry>, segUrl: string): string | undefined {
    const index = getMasterPrefixIndex(tabId, mediaMap)
    if (index.size === 0) return undefined
    let probe = segUrl.substring(0, segUrl.lastIndexOf('/') + 1)
    while (probe) {
      const arr = index.get(probe)
      if (arr && arr.length > 0) return arr[0]
      // 向上一级目录
      const idx = probe.lastIndexOf('/', probe.length - 2)
      if (idx < 0) break
      probe = probe.substring(0, idx + 1)
    }
    return undefined
  }
  const sidebarClosedTabs = new Set<number>()
  let isDataLoaded = false
  const pendingMessages: Array<{msg: any, sender: any, sendResponse: (response?: any) => void}> = []

  // 跟踪哪些 tab 有 UI（popup/sidepanel）在监听。popup 关闭时无显式通知，
  // 用 GET_LIST 请求的时间戳判定：90s 内有请求视为活跃。sidepanel 由
  // sidePanelPorts 显式跟踪。broadcastDebounced 仅在 UI 活跃时才序列化
  // 全量 list，避免后台嗅探（popup 未开）时的高频无意义序列化开销。
  const uiListeningTabs = new Map<number, number>()
  const UI_LISTENING_TTL = 90_000
  function isUiListening(tabId: number): boolean {
    if (sidePanelPorts.has(tabId)) return true
    const ts = uiListeningTabs.get(tabId)
    if (ts === undefined) return false
    if (Date.now() - ts > UI_LISTENING_TTL) {
      uiListeningTabs.delete(tabId)
      return false
    }
    return true
  }

  interface DownloadSession {
    url: string
    format: string
    filename: string
    sourceUrl: string
    requestHeaders?: Record<string, string>
    audioUrl?: string
  }
  const pendingDownloads = new Map<number, DownloadSession>()
  // 跟踪后台正在进行的 PROXY_FETCH 代理拉取，便于在标签页关闭或页面主动取消时中止，
  // 避免"页面已关但分片仍在后台继续请求"的资源泄漏
  const pendingProxyFetches = new Map<string, { controller: AbortController, tabId?: number }>()


  let currentSettings: Settings = {
    sniffingRules: { ...DEFAULT_SETTINGS.sniffingRules },
    excludeDomains: [...DEFAULT_SETTINGS.excludeDomains],
    maxItems: DEFAULT_SETTINGS.maxItems,
    enableMseCapture: DEFAULT_SETTINGS.enableMseCapture,
    hideStreamSegments: DEFAULT_SETTINGS.hideStreamSegments,
    captureDataImages: DEFAULT_SETTINGS.captureDataImages,
    dataImageMinSizeKB: DEFAULT_SETTINGS.dataImageMinSizeKB,
  }
  loadSettings().then(s => { currentSettings = s })

  browser.storage.local.onChanged.addListener((changes) => {
    if (changes['ext_settings']) {
      loadSettings().then(s => {
        currentSettings = s
        browser.tabs.query({}).then(tabs => {
          for (const tab of tabs) {
            if (tab.id) {
              browser.tabs.sendMessage(tab.id, {
                type: 'FLOWPICK_SETTINGS_CHANGED',
                enableMseCapture: s.enableMseCapture,
                captureDataImages: s.captureDataImages,
                dataImageMinSizeKB: s.dataImageMinSizeKB,
              }).catch(() => {})
            }
          }
        }).catch(() => {})
      })
    }
  })

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      tabPageUrls.set(tabId, changeInfo.url)
    } else if (tab.url) {
      tabPageUrls.set(tabId, tab.url)
    }
    if (changeInfo.title) {
      tabPageTitles.set(tabId, changeInfo.title)
    } else if (tab.title) {
      tabPageTitles.set(tabId, tab.title)
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

  // 当前激活标签 ID，用于 tabId=-1 兜底
  let currentActiveTabId = -1
  browser.tabs.onActivated.addListener(({ tabId }) => { currentActiveTabId = tabId })
  browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id) currentActiveTabId = tab.id
  }).catch(() => {})

  // broadcast 防抖（100ms 内合并同一 tab 的多次更新，避免高并发时 popup 频繁重渲染）
  const broadcastDebounceTimers = new Map<number, ReturnType<typeof setTimeout>>()

  function broadcastDebounced(tabId: number) {
    const existing = broadcastDebounceTimers.get(tabId)
    if (existing) clearTimeout(existing)
    broadcastDebounceTimers.set(tabId, setTimeout(() => {
      broadcastDebounceTimers.delete(tabId)
      const mediaMap = tabMap.get(tabId)
      if (!mediaMap) return
      // 无 UI 监听时跳过全量序列化：后台嗅探（popup 未开）时 HLS 直播每 150ms
      // 可能积累数十条变更，全量构建 list + IPC 序列化是纯浪费。popup/sidepanel
      // 打开时会通过 GET_LIST 拉取一次全量，后续广播恢复生效。
      if (!isUiListening(tabId)) return
      const list: Array<{url: string, format: string, size?: number, width?: number, height?: number, detectedAt?: number, category?: MediaCategory, requestHeaders?: Record<string, string>, captureId?: string, trackCount?: number, mseComplete?: boolean, groupId?: string, groupRole?: string, groupLabel?: string, groupMasterId?: string, variantBandwidth?: number, audioUrl?: string, audioOptions?: Array<{ url: string, label: string }>, duration?: number, coverUrl?: string, tabTitle?: string, isLiveStream?: boolean}> = []
      mediaMap.forEach((entry, url) => {
        list.push({ url, format: entry.format, size: entry.size, width: entry.width, height: entry.height, detectedAt: entry.detectedAt, category: entry.category, requestHeaders: entry.requestHeaders, captureId: entry.captureId, trackCount: entry.trackCount, mseComplete: entry.mseComplete, groupId: entry.groupId, groupRole: entry.groupRole, groupLabel: entry.groupLabel, groupMasterId: entry.groupMasterId, variantBandwidth: entry.variantBandwidth, audioUrl: entry.audioUrl, audioOptions: entry.audioOptions, duration: entry.duration, coverUrl: entry.coverUrl, tabTitle: entry.tabTitle, isLiveStream: entry.isLiveStream })
      })
      broadcast(tabId, list)
    }, 150))
  }

  const processedRequests = new Set<string>()
  const PROCESSED_REQUESTS_MAX = 10000

  // 缓存每个请求发出时的关键头（cookie、authorization 等），
  // 以 requestId 为 key，在 onHeadersReceived 时合并到媒体条目，
  // 下载时通过 DNR/webRequest 重放，实现携带 token/cookie 绕过鉴权
  const pendingRequestHeaders = new Map<string, Record<string, string>>()

  // 需要缓存并重放的请求头名单（认证相关）
  const AUTH_HEADER_NAMES = new Set([
    'cookie', 'authorization', 'x-auth-token', 'x-access-token',
    'token', 'api-key', 'x-api-key', 'x-csrf-token', 'wbi-key',
  ])

  // URL 快速判断仅用于无法依赖响应头的 `other` 请求；覆盖 detect.ts 支持的全部独立文件格式。
  // 媒体分片（如 .ts/.m4s）仍不作为独立资源收集，避免产生大量不可直接使用的条目。
  const isPotentialMediaRequest = (url: string): boolean =>
    /\.(m3u8|m3u|mpd|mp4|m4v|webm|ogv|flv|mkv|mov|avi|3gp|3g2|mpeg|mpg|mp3|m4a|oga|weba|wav|flac|aac|gif|jpe?g|png|webp|svg|pdf|docx?|xlsx?|pptx?|epub|csv|rtf|srt|vtt|ass|ssa|ttml)(?:[?#]|$)|(?:subtitle|caption)/i.test(url)

  // Transport fragments are implementation details of HLS/DASH downloads,
  // not user-downloadable media entries. Never place them in the sniff list.
  const isMediaSegmentRequest = (url: string): boolean =>
    /\.(m4s|m4f|m4i|cmfv|cmfa|cmft|ts)(?:[?#]|$)/i.test(url)

  const isBilibiliTab = (tabId: number): boolean => {
    try { return /(^|\.)bilibili\.com$/i.test(new URL(tabPageUrls.get(tabId) || '').hostname) } catch { return false }
  }

  // These are player metadata/catalog APIs, not caption files. Some Bilibili
  // responses advertise or are named as "subtitle", but their body is a
  // protobuf document that must never be offered as a .vtt download.
  const isBilibiliSubtitleCatalogApi = (url: string): boolean => {
    try {
      const parsed = new URL(url)
      if (!/(^|\.)bilibili\.com$/i.test(parsed.hostname)) return false
      return /\/x\/player\/(?:wbi\/)?v2(?:\/|$)|\/x\/v2\/dm\/view(?:\/|$)/i.test(parsed.pathname)
    } catch {
      return false
    }
  }

  browser.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId <= 0 || !details.requestHeaders?.length) return
      if (details.type === 'other' && !isPotentialMediaRequest(details.url)) return
      const authHeaders: Record<string, string> = {}
      for (const h of details.requestHeaders) {
        const name = h.name.toLowerCase()
        if (AUTH_HEADER_NAMES.has(name) && h.value) {
          authHeaders[name] = h.value
        }
      }
      if (Object.keys(authHeaders).length > 0) {
        pendingRequestHeaders.set(details.requestId, authHeaders)
      }
    },
    // 限定请求类型：媒体、xhr、sub_frame、image、other 才可能携带媒体鉴权头，
    // 排除 stylesheet/script/font/image(cross-origin 无头)/ping/beacon 等高频类型，
    // 在浏览器层减少回调触发量（替代 <all_urls> 全量监听）
    { urls: ['<all_urls>'], types: ['main_frame', 'media', 'xmlhttprequest', 'sub_frame', 'image', 'other'] },
    // EXTRA_HEADERS 必须加上，否则 Chrome 不暴露 Cookie 头
    (['requestHeaders', 'extraHeaders'] as any[]).filter(Boolean),
  )

  browser.webRequest.onErrorOccurred.addListener(
    (details) => { pendingRequestHeaders.delete(details.requestId) },
    { urls: ['<all_urls>'], types: ['main_frame', 'media', 'xmlhttprequest', 'sub_frame', 'image', 'other'] },
  )

  function addProcessedRequest(key: string) {
    if (processedRequests.size >= PROCESSED_REQUESTS_MAX) {
      const first = processedRequests.values().next().value
      if (first !== undefined) processedRequests.delete(first)
    }
    processedRequests.add(key)
  }
  
  // 在接收到响应头时检测媒体格式（优先使用 Content-Type）
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      // 没有明确所属标签页的请求不能归到当前激活标签，否则会串入其他 Tab 的列表.
      const effectiveTabId = details.tabId
      if (effectiveTabId <= 0) return undefined
      if (isMediaSegmentRequest(details.url)) {
        pendingRequestHeaders.delete(details.requestId)
        return undefined
      }
      if (isBilibiliTab(effectiveTabId) && isBilibiliSubtitleCatalogApi(details.url)) {
        pendingRequestHeaders.delete(details.requestId)
        return undefined
      }

      const requestKey = `${effectiveTabId}:${details.url}`
      if (processedRequests.has(requestKey)) return undefined

      if (details.statusCode === 416) {
        addProcessedRequest(requestKey)
        return undefined
      }

      // 性能优化：在遍历响应头之前做廉价短路。
      // 非 media/image 且 URL 不像媒体的请求（绝大多数 API/XHR/脚本/样式），
      // 几乎不可能因 Content-Type 突然变成可下载媒体。图片必须保留到
      // Content-Type 检测，以支持 CDN 无扩展名图片。提前 return 避免逐个
      // 遍历 responseHeaders 的开销。原 B 站专属短路逻辑被此通用短路覆盖。
      // 注意：detectDoc 可能靠 Content-Disposition 识别，但 attachment 下载场景
      // 极少出现在非 media/potential 请求中，可接受此取舍。
      if (details.type === 'other' && !isPotentialMediaRequest(details.url)) {
        pendingRequestHeaders.delete(details.requestId)
        return undefined
      }

      let contentType: string | null = null
      let contentLength: number | undefined = undefined
      let contentDisposition: string | null = null
      let hasContentRange = false
      let isRangeAcceptable = false
      let rangeTotal: number | undefined = undefined

      for (const header of details.responseHeaders ?? []) {
        const name = header.name.toLowerCase()
        if (name === 'content-type' && header.value) {
          contentType = header.value
        } else if (name === 'content-length' && header.value) {
          const n = parseInt(header.value, 10)
          if (!isNaN(n)) contentLength = n
        } else if (name === 'content-disposition' && header.value) {
          contentDisposition = header.value
        } else if (name === 'content-range' && header.value) {
          hasContentRange = true
          const m = header.value.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
          if (m && m[3] !== '*') {
            const start = parseInt(m[1]!, 10)
            const end   = parseInt(m[2]!, 10)
            const total = parseInt(m[3]!, 10)
            rangeTotal = total
            isRangeAcceptable = start === 0 && (end - start + 1) / total >= 0.85
          }
        }
      }

      // Range 响应时用 total 代替 Content-Length
      if (hasContentRange && rangeTotal !== undefined) {
        contentLength = rangeTotal
      }

      // A 206 response is normally a player preview/byte-range chunk, not an
      // independently downloadable file. Only accept it when the response
      // starts at zero and covers almost the whole resource; otherwise drop it
      // instead of turning every preview chunk into a media card.
      if (hasContentRange && !isRangeAcceptable) {
        pendingRequestHeaders.delete(details.requestId)
        return undefined
      }

      // type==="media"：浏览器对 <video>/<audio> 触发的请求打上 "media" 标记，
      // 这是最可靠的媒体信号，直接放行，不做 Content-Type/扩展名过滤
      let detectedFormat: string
      let category: MediaCategory = 'media'

      if (details.type === 'media') {
        // 靠 Content-Type 细化格式，若无法识别则按 mp4 兜底
        detectedFormat = (contentType ? (detectMedia(details.url, contentType, contentLength) ?? null) : null) ?? 'mp4'
        const settings = currentSettings
        const pageUrl = tabPageUrls.get(effectiveTabId)
        if (settings && pageUrl && isDomainExcluded(pageUrl, settings)) return undefined
        if (settings && !isFormatAllowed(detectedFormat, settings)) return undefined
        addMedia(details.url, effectiveTabId, detectedFormat, contentLength, category, pendingRequestHeaders.get(details.requestId), undefined, contentType ?? undefined)
        addProcessedRequest(requestKey)
        pendingRequestHeaders.delete(details.requestId)
        return undefined
      }

      const mediaFmt = detectMedia(details.url, contentType, contentLength)
      if (mediaFmt) {
        detectedFormat = mediaFmt
      } else {
        const doc = detectDoc(details.url, contentType, contentDisposition)
        if (!doc) return undefined
        detectedFormat = doc.format
        category = doc.category
      }

      const settings = currentSettings
      const pageUrl = tabPageUrls.get(effectiveTabId)
      if (settings && pageUrl && isDomainExcluded(pageUrl, settings)) return undefined
      if (settings && !isFormatAllowed(detectedFormat, settings)) return undefined
      if (settings && !isSizeAllowed(detectedFormat, contentLength, settings)) return undefined

      // XHR/fetch 触发的播放器资源也要保留响应 Content-Type。抖音常把
      // 分离的 audio/video 作为 XHR 请求；缺少它会使后续的配对逻辑失效。
      addMedia(details.url, effectiveTabId, detectedFormat, contentLength, category, pendingRequestHeaders.get(details.requestId), undefined, contentType ?? undefined, tabPageTitles.get(effectiveTabId))
      addProcessedRequest(requestKey)
      pendingRequestHeaders.delete(details.requestId)
      return undefined
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'media', 'xmlhttprequest', 'sub_frame', 'image', 'other'] },
    ['responseHeaders'],
  )
  
  // 缓存/条件请求头名单：浏览器对命中 HTTP 缓存的 URL 会自动附加 If-None-Match /
  // If-Modified-Since 等条件头，服务端可能据此返回 206 局部响应，导致代理拿到的内容
  // 不完整而报错。在代理（PROXY_FETCH）与 webRequest / DNR 层统一剔除，并配合 cache:'no-store'。
  const CACHE_HEADER_NAMES = new Set([
    'cache-control', 'pragma', 'if-modified-since', 'if-none-match',
    'if-range', 'if-match', 'if-unmodified-since', 'warning'
  ])

  // 代理请求：注入 Referer 并移除 Origin，绕过 CDN 的 CORS/来源校验
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const proxyHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'x-flowpick-proxy')
      if (!proxyHeader) return {}

      const refererHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'x-flowpick-referer')
      const newHeaders = (details.requestHeaders || [])
        .filter(h => {
          const name = h.name.toLowerCase()
          // 移除 Origin（CDN 会拒绝 chrome-extension:// 来源）
          if (name === 'origin') return false
          // 移除自定义标记头
          if (name === 'x-flowpick-proxy' || name === 'x-flowpick-referer') return false
          // 移除浏览器自动附加的缓存/条件请求头，避免代理命中缓存返回 206 局部内容
          if (CACHE_HEADER_NAMES.has(name)) return false
          return true
        })

      // 注入 Referer
      if (refererHeader?.value) {
        newHeaders.push({ name: 'Referer', value: refererHeader.value })
      }

      return { requestHeaders: newHeaders }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders'],
  )

  // 代理请求的 DNR session 规则缓存（按 host 去重）
  const DNR_RULES_MAX = 5000
  const DNR_RULES_EVICT = 100
  const dnlRefererRules = new Map<string, { id: number; referer: string; headersKey: string; lastUsed: number }>()
  const playbackHeaderHosts = new Map<string, { referer: string; authHeaders?: Record<string, string> }>()
  let dnlRefererSeq = 1

  async function ensureProxyHeaderRule(
    targetUrl: string,
    referer: string,
    authHeaders?: Record<string, string>,
  ): Promise<void> {
    const dnr = (browser as any).declarativeNetRequest
    if (!dnr) return
    if (navigator.userAgent.toLowerCase().includes('firefox')) return
    let host: string
    try { host = new URL(targetUrl).host } catch { return }

    const headersKey = JSON.stringify({ referer, ...authHeaders })
    const cached = dnlRefererRules.get(host)
    if (cached && cached.referer === referer && cached.headersKey === headersKey) {
      cached.lastUsed = Date.now()
      return
    }

    const ruleId = cached?.id ?? dnlRefererSeq++
    const removeRuleIds = cached ? [cached.id] : []

    const requestHeaders: any[] = [
      { operation: 'set', header: 'Referer', value: referer },
      { operation: 'remove', header: 'Origin' },
      { operation: 'remove', header: 'X-FlowPick-Proxy' },
      { operation: 'remove', header: 'X-FlowPick-Referer' },
      { operation: 'remove', header: 'Cache-Control' },
      { operation: 'remove', header: 'Pragma' },
      { operation: 'remove', header: 'If-Modified-Since' },
      { operation: 'remove', header: 'If-None-Match' },
      { operation: 'remove', header: 'If-Range' },
      { operation: 'remove', header: 'If-Match' },
      { operation: 'remove', header: 'If-Unmodified-Since' },
    ]

    // 注入 CORS 响应头：让 popup 中的 <video>/<audio> 能跨域加载媒体 CDN 资源
    // 国内 CDN（抖音/快手/B站等）常不返回 Access-Control-Allow-Origin，导致播放失败
    const responseHeaders: any[] = [
      { operation: 'set', header: 'Access-Control-Allow-Origin', value: '*' },
      { operation: 'set', header: 'Access-Control-Allow-Headers', value: '*' },
      { operation: 'set', header: 'Access-Control-Allow-Methods', value: 'GET,HEAD,OPTIONS' },
    ]

    // 注入认证头（Cookie 是 fetch 的禁止头，只能通过 DNR 注入）
    if (authHeaders) {
      for (const [k, v] of Object.entries(authHeaders)) {
        requestHeaders.push({ operation: 'set', header: k, value: v })
      }
    }

    // LRU 淘汰：超阈值时先批量 remove 最旧的 session rules，再 add 新规则，
    // 避免单次 updateSessionRules 同时 remove + add 大量规则造成抖动。
    const evictIds: number[] = []
    if (dnlRefererRules.size >= DNR_RULES_MAX && !cached) {
      const sorted = [...dnlRefererRules.entries()]
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
        .slice(0, DNR_RULES_EVICT)
      for (const [h, v] of sorted) {
        evictIds.push(v.id)
        dnlRefererRules.delete(h)
        playbackHeaderHosts.delete(h)
      }
    }

    await dnr.updateSessionRules({
      removeRuleIds: [...removeRuleIds, ...evictIds],
      addRules: [{
        id: ruleId,
        priority: 10,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
          responseHeaders,
        },
        condition: { urlFilter: `||${host}^`, initiatorDomains: [browser.runtime.id] },
      }],
    })
    dnlRefererRules.set(host, { id: ruleId, referer, headersKey, lastUsed: Date.now() })
    playbackHeaderHosts.set(host, { referer, authHeaders })
  }

  // 清理已处理的请求记录（当标签页关闭时）
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const key of processedRequests) {
      if (key.startsWith(`${tabId}:`)) {
        processedRequests.delete(key)
      }
    }
    // 中止该标签页发起的、仍在后台进行的代理拉取（分片下载/预览播放），
    // 否则标签页关闭后 Service Worker 仍会继续请求分片造成泄漏
    for (const [rid, entry] of pendingProxyFetches) {
      if (entry.tabId === tabId) {
        entry.controller.abort()
        pendingProxyFetches.delete(rid)
      }
    }
    pendingDownloads.delete(tabId)
    tabMap.delete(tabId)
    bilibiliManagedUrls.delete(tabId)
    platformManagedUrls.delete(tabId)
    platformTaskPriorities.delete(tabId)
    douyinMediaMetadata.delete(tabId)
    douyinNativeTracks.delete(tabId)
    tabPageUrls.delete(tabId)
    tabPageTitles.delete(tabId)
    sidebarClosedTabs.delete(tabId)
    masterPrefixIndex.delete(tabId)
    tabMediaVersion.delete(tabId)
    uiListeningTabs.delete(tabId)
    deleteTabList(tabId)
  })

  const notifyPages = new Map<string, string>()

  // 点击系统通知：跳回对应的下载页（聚焦已有标签页或新建），并通知页面触发保存
  browser.notifications.onClicked.addListener((notificationId) => {
    handleNotificationClick(String(notificationId))
  })

  async function handleNotificationClick(tag: string) {
    if (tag !== 'download-complete' && tag !== 'download-error') return
    const target = notifyPages.get(tag) || 'https://192.168.1.3:3001/'
    let tabId: number | undefined
    try {
      const host = new URL(target).host
      const [existing] = await browser.tabs.query({ url: `*://${host}/*` })
      if (existing?.id) {
        tabId = existing.id
        await browser.tabs.update(tabId, { active: true })
        if (existing.windowId !== undefined) {
          await browser.windows.update(existing.windowId, { focused: true }).catch(() => {})
        }
      } else {
        const created = await browser.tabs.create({ url: target })
        tabId = created.id
      }
    } catch (e) {
      console.warn('[FlowPick] notification click failed:', e)
    }
    if (tabId !== undefined) {
      browser.tabs.sendMessage(tabId, { type: 'FLOWPICK_NOTIFY_CLICK', tag }).catch(() => {})
    }
  }

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const asyncTypes = ['OPEN_DOWNLOAD_PAGE', 'FLOWPICK_DOWNLOAD_READY', 'GET_VIDEO_DIMENSIONS', 'GET_AUDIO_DURATION', 'GET_MEDIA_INFO', 'GET_SETTINGS', 'SAVE_SETTINGS', 'CLOSE_SIDEBAR_FOR_TAB', 'PROXY_FETCH', 'PROXY_FETCH_CANCEL', 'PREPARE_MEDIA_PLAYBACK', 'FLOWPICK_NOTIFY', 'MSE_STREAM_UPDATE', 'MSE_DOWNLOAD', 'UPDATE_MEDIA_META', 'GET_CONTENT_LENGTH', 'GET_MEDIA_METADATA_BATCH', 'CANCEL_MEDIA_METADATA_BATCH', 'REMOVE_MEDIA_IF_TOO_SMALL']
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
    // 嗅探类消息只能使用 runtime sender 所属的 Tab。消息体中的 tabId 来自页面，
    // 不能作为归属依据，否则并发页面或伪造消息可能把资源写入其他 Tab 的列表。
    if (msg.type === 'MEDIA_FOUND') {
      const tabId = sender.tab?.id
      const format = msg.format || 'm3u8'
      if (tabId !== undefined) {
        const rh = (msg.requestHeaders && typeof msg.requestHeaders === 'object') ? msg.requestHeaders : undefined
        addMedia(msg.url, tabId, format, undefined, 'media', rh, undefined, undefined, sender.tab?.title)
      }
      sendResponse({ ok: tabId !== undefined })
      return
    }

    if (msg.type === 'MEDIA_FOUND_BATCH') {
      const tabId = sender.tab?.id
      const items: Array<{ url: string; format: string }> = Array.isArray(msg.items) ? msg.items : []
      const tabTitle = sender.tab?.title
      if (tabId !== undefined) {
        for (const item of items) {
          if (item && typeof item.url === 'string') {
            addMedia(item.url, tabId, item.format || 'm3u8', undefined, 'media', undefined, undefined, undefined, tabTitle)
          }
        }
      }
      sendResponse({ ok: tabId !== undefined })
      return
    }

    if (msg.type === 'MSE_STREAM_UPDATE') {
      const tabId = sender.tab?.id
      if (tabId === undefined) { sendResponse({ ok: false }); return }
      const captureId: string = msg.captureId
      const pseudoUrl = `mse://${captureId}`
      addMedia(
        pseudoUrl,
        tabId,
        'mse',
        msg.totalBytes,
        'media',
        undefined,
        { captureId, trackCount: msg.trackCount, mseComplete: msg.complete },
        undefined,
        sender.tab?.title,
      )
      sendResponse({ ok: true })
      return
    }

    if (msg.type === 'BILIBILI_DASH_FOUND') {
      const tabId = sender.tab?.id
      if (tabId === undefined || !msg.task) { sendResponse({ ok: false }); return }
      upsertBilibiliDashTask(tabId, msg.task, sender.tab?.title)
      sendResponse({ ok: true })
      return
    }

    if (msg.type === 'PLATFORM_MEDIA_FOUND') {
      const tabId = sender.tab?.id
      if (tabId === undefined || !isValidPlatformTask(msg.task, sender.tab?.url)) {
        sendResponse({ ok: false })
        return
      }
      // The page adapter may suggest a referer, but the sender tab is the only
      // authoritative origin for a cross-page download session.
      upsertPlatformMediaTask(tabId, { ...msg.task, referer: sender.tab?.url }, sender.tab?.title)
      sendResponse({ ok: true })
      return
    }

    if (msg.type === 'MSE_DOWNLOAD') {
      const tabId = msg.tabId || sender.tab?.id
      if (!tabId) { sendResponse({ ok: false }); return }
      browser.tabs.sendMessage(tabId, {
        type: 'MSE_DOWNLOAD_TRIGGER',
        captureId: msg.captureId,
        title: msg.title,
      }).catch(() => {})
      sendResponse({ ok: true })
      return
    }

    if (msg.type === 'OPEN_DOWNLOAD_PAGE') {
      const { url, format, filename, requestHeaders } = msg
      let sourceUrl = sender.tab?.url || ''
      if (!sourceUrl) {
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
        sourceUrl = activeTab?.url || ''
      }

      // 如果调用方没有直接传 requestHeaders，尝试从当前 tab 的媒体条目里查找
      let resolvedHeaders = requestHeaders as Record<string, string> | undefined
      if (!resolvedHeaders && sender.tab?.id) {
        const tabMedia = tabMap.get(sender.tab.id)
        if (tabMedia) {
          const entry = tabMedia.get(url)
          if (entry?.requestHeaders) resolvedHeaders = entry.requestHeaders
        }
      }
      const suppliedReferer = resolvedHeaders?.referer || resolvedHeaders?.Referer
      if (typeof suppliedReferer === 'string' && suppliedReferer) sourceUrl = suppliedReferer

      let downloaderPage: string
      if (format === 'mpd') {
        downloaderPage = 'dash-downloader'
      } else if (format === 'm3u8') {
        downloaderPage = 'm3u8-downloader'
      } else {
        downloaderPage = 'video-downloader'
      }

      const languageMapping: Record<string, string> = {
        'zh-CN': 'zh-Hans',
        'zh-SG': 'zh-Hans',
        'zh-TW': 'zh-Hant',
        'zh-HK': 'zh-Hant',
        'ja': 'ja',
        'ko': 'ko',
        'de': 'de',
        'es': 'es',
        'ru': 'ru',
      }

      const browserLang = browser.i18n.getUILanguage()
      const langSuffix = languageMapping[browserLang]
      const targetUrl = langSuffix
        ? `https://flowpick.net/${langSuffix}/${downloaderPage}`
        : `https://flowpick.net/${downloaderPage}`
      const tab = await browser.tabs.create({ url: targetUrl })
      if (tab.id) {
        pendingDownloads.set(tab.id, { url, format, filename, sourceUrl, requestHeaders: resolvedHeaders, audioUrl: msg.audioUrl as string | undefined })
      }
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === 'FLOWPICK_DOWNLOAD_READY') {
      const tabId = sender.tab?.id
      if (tabId && pendingDownloads.has(tabId)) {
        const session = pendingDownloads.get(tabId)!
        pendingDownloads.delete(tabId)
        sendResponse({ ok: true, url: session.url, format: session.format, filename: session.filename, sourceUrl: session.sourceUrl, requestHeaders: session.requestHeaders, audioUrl: session.audioUrl })
      } else {
        sendResponse({ ok: false })
      }
      return true
    }

    if (msg.type === 'CLEAR_LIST') {
      const tabId = msg.tabId as number
      tabMap.delete(tabId)
      bilibiliManagedUrls.delete(tabId)
      platformManagedUrls.delete(tabId)
      platformTaskPriorities.delete(tabId)
      douyinMediaMetadata.delete(tabId)
      douyinNativeTracks.delete(tabId)
      masterPrefixIndex.delete(tabId)
      tabMediaVersion.delete(tabId)
      deleteTabList(tabId)
      for (const key of processedRequests) {
        if (key.startsWith(`${tabId}:`)) {
          processedRequests.delete(key)
        }
      }
      sendResponse(true)
      return true
    }

    if (msg.type === 'GET_LIST') {
      const tabId = msg.tabId as number
      uiListeningTabs.set(tabId, Date.now())
      const mediaMap = tabMap.get(tabId)
      const list: Array<{url: string, format: string, size?: number, width?: number, height?: number, detectedAt?: number, category?: MediaCategory, requestHeaders?: Record<string, string>, captureId?: string, trackCount?: number, mseComplete?: boolean, groupId?: string, groupRole?: string, groupLabel?: string, groupMasterId?: string, variantBandwidth?: number, audioUrl?: string, audioOptions?: Array<{ url: string, label: string }>, duration?: number, coverUrl?: string, tabTitle?: string, isLiveStream?: boolean}> = []
      if (mediaMap) {
        mediaMap.forEach((entry, url) => {
          list.push({ url, format: entry.format, size: entry.size, width: entry.width, height: entry.height, detectedAt: entry.detectedAt, category: entry.category, requestHeaders: entry.requestHeaders, captureId: entry.captureId, trackCount: entry.trackCount, mseComplete: entry.mseComplete, groupId: entry.groupId, groupRole: entry.groupRole, groupLabel: entry.groupLabel, groupMasterId: entry.groupMasterId, variantBandwidth: entry.variantBandwidth, audioUrl: entry.audioUrl, audioOptions: entry.audioOptions, duration: entry.duration, coverUrl: entry.coverUrl, tabTitle: entry.tabTitle, isLiveStream: entry.isLiveStream })
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

    if (msg.type === 'CANCEL_MEDIA_METADATA_BATCH') {
      const taskId = String(msg.taskId || '')
      metadataBatchControllers.get(taskId)?.abort()
      metadataBatchControllers.delete(taskId)
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === 'GET_MEDIA_METADATA_BATCH') {
      const request = msg as MetadataBatchRequest
      const tabId = request.tabId
      const taskId = request.taskId
      const items = Array.isArray(request.items) ? request.items.slice(0, 500) : []
      metadataBatchControllers.get(taskId)?.abort()
      const controller = new AbortController()
      metadataBatchControllers.set(taskId, controller)
      ;(async () => {
        try {
          const results = await mapWithConcurrency<MetadataBatchItem, MetadataBatchResult>(items, 6, async item => {
            controller.signal.throwIfAborted()
            // 黑名单中的 URL 直接跳过，不发起任何网络请求
            if (isUrlBlacklisted(item.url)) {
              return { key: item.key, url: item.url, removed: true, error: 'blacklisted' }
            }
            try {
              const [mediaInfo, sizeResult] = await Promise.all([
                item.needMediaInfo ? fetchMediaInfo(item.url, controller.signal) : Promise.resolve(null),
                item.needSize ? fetchContentLength(item.url, item.requestHeaders, controller.signal) : Promise.resolve(null),
              ])
              controller.signal.throwIfAborted()
              // 成功拿到任一有效元数据：清空失败计数
              const hasAnyMeta = !!(mediaInfo?.width || mediaInfo?.height || mediaInfo?.duration || (sizeResult?.ok && sizeResult.size))
              if (hasAnyMeta) clearUrlFailure(item.url)
              return {
                key: item.key,
                url: item.url,
                width: mediaInfo?.width,
                height: mediaInfo?.height,
                duration: mediaInfo?.duration,
                size: sizeResult?.ok ? sizeResult.size : undefined,
                removed: false,
              }
            } catch (error) {
              if (controller.signal.aborted) throw error
              // 元数据请求异常：累计失败次数；达到阈值标记 removed 让 popup 剔除
              const shouldRemove = recordUrlFailure(item.url)
              return {
                key: item.key,
                url: item.url,
                error: (error as Error).message,
                removed: shouldRemove,
              }
            }
          })

          controller.signal.throwIfAborted()
          const mediaMap = tabMap.get(tabId)
          let changed = false
          let removedAny = false
          if (mediaMap) {
            for (const result of results) {
              const entry = mediaMap.get(result.url)
              if (!entry) continue
              const format = entry.format.toLowerCase()

              // 失败累计达标 / 已在黑名单：从 mediaMap 删除并拉黑
              if (result.removed) {
                if (!isUrlBlacklisted(result.url)) blacklistUrl(result.url)
                mediaMap.delete(result.url)
                changed = true
                removedAny = true
                continue
              }

              if (typeof result.size === 'number' && !['m3u8', 'mpd', 'mse'].includes(format)) {
                const group = getFormatGroup(format)
                const minKB = group ? (currentSettings.sniffingRules[group]?.minSizeKB ?? 0) : 0
                if (minKB > 0 && result.size < minKB * 1024) {
                  mediaMap.delete(result.url)
                  result.removed = true
                  changed = true
                  removedAny = true
                  continue
                }
              }
              const nextEntry = {
                ...entry,
                width: typeof result.width === 'number' ? result.width : entry.width,
                height: typeof result.height === 'number' ? result.height : entry.height,
                duration: typeof result.duration === 'number' ? result.duration : entry.duration,
                size: typeof result.size === 'number' ? result.size : entry.size,
              }
              if (nextEntry.width !== entry.width || nextEntry.height !== entry.height || nextEntry.duration !== entry.duration || nextEntry.size !== entry.size) {
                mediaMap.set(result.url, nextEntry)
                changed = true
              }
            }
            if (changed) await saveTabList(tabId, mediaMap)
            if (removedAny) {
              try { updateBadge(tabId) } catch {}
              broadcastDebounced(tabId)
            }
          }
          sendResponse({ ok: true, items: results })
        } catch (error) {
          if (controller.signal.aborted) sendResponse({ ok: false, cancelled: true, items: [] })
          else sendResponse({ ok: false, error: (error as Error).message, items: [] })
        } finally {
          if (metadataBatchControllers.get(taskId) === controller) metadataBatchControllers.delete(taskId)
        }
      })()
      return true
    }
    // popup 获取到 duration / width / height / size 后写回 MediaEntry 持久化（跨 popup 会话保留）
    if (msg.type === 'UPDATE_MEDIA_META') {
      const tabId = msg.tabId as number
      const url = msg.url as string
      const mediaMap = tabMap.get(tabId)
      if (!mediaMap) { sendResponse({ ok: false }); return true }
      const entry = mediaMap.get(url)
      if (!entry) { sendResponse({ ok: false }); return true }
      mediaMap.set(url, {
        ...entry,
        duration: typeof msg.duration === 'number' ? msg.duration : entry.duration,
        width: typeof msg.width === 'number' ? msg.width : entry.width,
        height: typeof msg.height === 'number' ? msg.height : entry.height,
        size: typeof msg.size === 'number' ? msg.size : entry.size,
      })
      saveTabList(tabId, mediaMap).catch(() => {})
      sendResponse({ ok: true })
      return true
    }


    // popup 拿到真实 size 后，按嗅探规则过滤：不符合最小大小阈值的条目从 mediaMap 移除
    // （background 在 onHeadersReceived 拿不到 content-length 时会放行，这里做异步兜底）
    if (msg.type === 'REMOVE_MEDIA_IF_TOO_SMALL') {
      const tabId = msg.tabId as number
      const url = msg.url as string
      const size = msg.size as number
      const mediaMap = tabMap.get(tabId)
      if (!mediaMap) { sendResponse({ ok: false }); return true }
      const entry = mediaMap.get(url)
      if (!entry) { sendResponse({ ok: false, reason: 'not_found' }); return true }
      // stream / mse 不做 size 过滤
      const fmt = entry.format.toLowerCase()
      if (fmt === 'm3u8' || fmt === 'mpd' || fmt === 'mse') {
        sendResponse({ ok: true, removed: false })
        return true
      }
      const settings = currentSettings
      const group = getFormatGroup(fmt)
      if (!group) { sendResponse({ ok: true, removed: false }); return true }
      const minKB = settings.sniffingRules[group]?.minSizeKB ?? 0
      if (minKB <= 0) { sendResponse({ ok: true, removed: false }); return true }
      if (size >= minKB * 1024) {
        sendResponse({ ok: true, removed: false })
        return true
      }
      // 不符合阈值，移除
      mediaMap.delete(url)
      saveTabList(tabId, mediaMap).catch(() => {})
      try { updateBadge(tabId) } catch {}
      broadcastDebounced(tabId)
      sendResponse({ ok: true, removed: true })
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

    if (msg.type === 'CLOSE_SIDEBAR_FOR_TAB') {
      const tabId = msg.tabId as number
      if (supportsFirefoxSidebar) {
        nativeBrowser.sidebarAction.close().catch(() => {})
      } else if (tabId !== undefined) {
        sidebarClosedTabs.add(tabId)
        if (supportsChromeSidepanel) {
          chromeGlobal.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {})
        }
      }
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === 'PREPARE_MEDIA_PLAYBACK') {
      const url = String(msg.url || '')
      const format = String(msg.format || '').toLowerCase()
      const referrer = String(msg.referrer || '')
      const authHeaders = msg.requestHeaders && typeof msg.requestHeaders === 'object'
        ? msg.requestHeaders as Record<string, string>
        : undefined
      ;(async () => {
        try {
          await ensureProxyHeaderRule(url, referrer, authHeaders)
          if (format !== 'mpd') {
            sendResponse({ ok: true, drm: false })
            return
          }

          const headers: Record<string, string> = { 'X-FlowPick-Proxy': '1' }
          if (referrer) headers['X-FlowPick-Referer'] = referrer
          if (authHeaders) Object.assign(headers, authHeaders)
          const response = await fetch(url, { headers, cache: 'no-store' })
          if (!response.ok) {
            sendResponse({ ok: false, status: response.status, error: `HTTP ${response.status}` })
            return
          }
          const manifest = await response.text()
          const drm = /<ContentProtection\b|widevine|playready|com\.microsoft\.playready|urn:uuid:edef8ba9|cenc:pssh/i.test(manifest)

          // 为 MPD 中显式出现的跨主机 BaseURL/资源 URL 安装同样的临时规则。
          const candidates = new Set<string>([url])
          for (const match of manifest.matchAll(/https?:\/\/[^\s"'<>]+/gi)) candidates.add(match[0])
          for (const match of manifest.matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)) {
            try { candidates.add(new URL(match[1]!.trim(), url).toString()) } catch {}
          }
          await Promise.all([...candidates].map(candidate => ensureProxyHeaderRule(candidate, referrer, authHeaders).catch(() => {})))
          sendResponse({ ok: true, drm })
        } catch (error) {
          sendResponse({ ok: false, error: (error as Error).message })
        }
      })()
      return true
    }
    if (msg.type === 'PROXY_FETCH') {
      const { url, options } = msg
      const requestId = (msg.requestId as string) || `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const tabId = sender?.tab?.id
      const controller = new AbortController()
      pendingProxyFetches.set(requestId, { controller, tabId })
      ;(async () => {
        try {
          // 剔除 options.headers 中可能携带的缓存/条件请求头（无论来源），
          // 配合 cache:'no-store' 让本次 fetch 走网络而非 HTTP 缓存，避免拿到 206 局部响应
          const headers: Record<string, string> = {}
          if (options?.headers) {
            for (const [k, v] of Object.entries(options.headers)) {
              if (!CACHE_HEADER_NAMES.has(String(k).toLowerCase())) {
                headers[k] = v as string
              }
            }
          }
          // 合并 authHeaders（cookie、authorization 等），优先 options 里显式提供的值
          if (options?.authHeaders) {
            for (const [k, v] of Object.entries(options.authHeaders)) {
              if (!headers[k]) headers[k] = v as string
            }
          }
          // 带 X-FlowPick-Proxy 标记，交给 onBeforeSendHeaders 在 webRequest 层
          // 剥离 Origin（绕过跨域/来源校验）并注入 Referer（绕过防盗链）。
          // 注意：Referer 是 fetch 的禁止头，直接写进 headers 会被浏览器丢弃，
          // 因此必须通过 X-FlowPick-Referer 中转，由 onBeforeSendHeaders 落地。
          // 仅当显式 proxyHeader:false 时才不加标记（走裸请求）。
          const useProxyHeader = options?.proxyHeader !== false
          if (useProxyHeader) {
            headers['X-FlowPick-Proxy'] = '1'
            if (options?.referrer) {
              headers['X-FlowPick-Referer'] = options.referrer
            }
          }
          // Chrome 下提前注册 DNR 规则，携带 Referer 和认证头（cookie 等禁止头只能由 DNR 注入）
          if (options?.referrer || options?.authHeaders) {
            try {
              await ensureProxyHeaderRule(url, options.referrer || '', options.authHeaders)
            } catch (_) {}
          }
          const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
          if (!response.ok) {
            const bodyText = await response.text()
            sendResponse({ ok: false, error: `HTTP ${response.status}: ${bodyText.substring(0, 200)}` })
            return
          }
          const arrayBuffer = await response.arrayBuffer()
          const bytes = new Uint8Array(arrayBuffer)
          let binary = ''
          for (let i = 0; i < bytes.length; i += 32768) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
          }
          const responseHeaders: Record<string, string> = {}
          response.headers.forEach((value, key) => { responseHeaders[key] = value })
          // 必须用 base64 回传：runtime 消息（content ↔ background）是 JSON 序列化，
          // 无法承载 ArrayBuffer（会丢失/序列化失败导致端口异常）。base64 仅 +33%，
          // 是这条通道传二进制的唯一可靠方式；转发到页面那一跳再用 transfer 零拷贝。
          sendResponse({
            ok: true,
            status: response.status,
            headers: responseHeaders,
            data: btoa(binary),
          })
        } catch (e: any) {
          if (e?.name === 'AbortError') {
            // 标签页关闭或页面主动取消：静默中止，不再回传（页面已不存在）
            return
          }
          sendResponse({ ok: false, error: e.message })
        } finally {
          pendingProxyFetches.delete(requestId)
        }
      })()
      return true
    }

    if (msg.type === 'PROXY_FETCH_CANCEL') {
      const { requestId } = msg
      const entry = requestId ? pendingProxyFetches.get(requestId) : undefined
      if (entry) {
        entry.controller.abort()
        pendingProxyFetches.delete(requestId)
      }
      sendResponse({ ok: true })
      return true
    }

    // 由扩展进程发起系统通知（页面/网页端请求代发，绕过网页通知授权与弹出层关闭丢失问题）
    if (msg.type === 'FLOWPICK_NOTIFY') {
      const { title, body, tag, pageUrl } = msg
      if (pageUrl) notifyPages.set(tag, pageUrl)
      try {
        await browser.notifications.create(String(tag), {
          type: 'basic',
          iconUrl: browser.runtime.getURL('/icon/128.png'),
          title: title || 'FlowPick',
          message: body || '',
        })
      } catch (e) {
        console.warn('[FlowPick] notification failed:', e)
      }
      sendResponse({ ok: true })
      return true
    }


    if (msg.type === 'GET_CONTENT_LENGTH') {
      fetchContentLength(msg.url, msg.requestHeaders).then(sendResponse)
      return true
    }
    return false
  }

  function addMedia(url: string, tabId: number, format: string, size?: number, category: MediaCategory = 'media', requestHeaders?: Record<string, string>, extra?: { captureId?: string; trackCount?: number; mseComplete?: boolean }, contentType?: string, tabTitle?: string) {
    if (bilibiliManagedUrls.get(tabId)?.has(url) || platformManagedUrls.get(tabId)?.has(url)) return
    // 坏 URL 黑名单：跳过，避免反复嗅探→请求→失败的循环
    // 流媒体（m3u8/mpd/mse）不拦，它们失败由 manifest 解析单独处理，且多是临时网络抖动
    // data: URL 本地内嵌，不会失败，也不应进黑名单
    const fmtLower = format.toLowerCase()
    if (fmtLower !== 'm3u8' && fmtLower !== 'mpd' && fmtLower !== 'mse'
        && !url.startsWith('data:') && isUrlBlacklisted(url)) return
    if (!tabMap.has(tabId)) {
      tabMap.set(tabId, new Map())
    }
    const mediaMap = tabMap.get(tabId)!
    // 资源嗅探时刻的网页标题（优先用传入的 tabTitle，否则从缓存 Map 取）
    const effectiveTabTitle = tabTitle ?? tabPageTitles.get(tabId)

    // ts/.m4s 分片自动关联到同 tab 的 m3u8 master（按 URL 路径前缀最长匹配）
    // 用 masterPrefixIndex 做 O(1) 查找，替代此前对整个 mediaMap 的 O(N) 线性扫描
    if ((format === 'ts' || format === 'm4s') && !extra?.captureId) {
      const bestMaster = findMasterBySegmentUrl(tabId, mediaMap, url)
      if (bestMaster) {
        if (!mediaMap.has(url)) {
          if (mediaMap.size >= (currentSettings.maxItems ?? 1000)) {
            const oldestKey = mediaMap.keys().next().value
            if (oldestKey !== undefined) {
              mediaMap.delete(oldestKey)
              bumpTabVersion(tabId)
            }
          }
          mediaMap.set(url, {
            format,
            size,
            detectedAt: Date.now(),
            category,
            requestHeaders,
            groupId: bestMaster,
            groupRole: 'segment',
            groupMasterId: bestMaster,
            tabTitle: effectiveTabTitle,
          })
          saveTabList(tabId, mediaMap).catch(() => {})
          try { updateBadge(tabId) } catch {}
          broadcastDebounced(tabId)
        }
        return
      }
    }

    const existing = mediaMap.get(url)
    if (existing && format !== 'mse') {
      // 页面世界的 fetch/XHR hook 会比响应头更早上报同一个 URL。不要直接
      // 丢弃响应头里的认证信息和媒体类型；这也是分离流无法被配对的根因。
      const upgradedContentType = existing.contentType ?? contentType
      const upgradedHeaders = existing.requestHeaders ?? requestHeaders
      const upgradedSize = existing.size ?? size
      const upgradedTitle = existing.tabTitle ?? effectiveTabTitle
      if (upgradedContentType !== existing.contentType
        || upgradedHeaders !== existing.requestHeaders
        || upgradedSize !== existing.size
        || upgradedTitle !== existing.tabTitle) {
        mediaMap.set(url, {
          ...existing,
          contentType: upgradedContentType,
          requestHeaders: upgradedHeaders,
          size: upgradedSize,
          tabTitle: upgradedTitle,
        })
        if (upgradedContentType) tryGroupVideoAudio(url, tabId, upgradedContentType, upgradedSize)
        saveTabList(tabId, mediaMap).catch(() => {})
        broadcastDebounced(tabId)
      }
      return
    }
    if (mediaMap.size >= (currentSettings.maxItems ?? 1000)) {
      const oldestKey = mediaMap.keys().next().value
      if (oldestKey !== undefined) {
        mediaMap.delete(oldestKey)
        bumpTabVersion(tabId)
      }
    }
    // m3u8/mpd 的 Content-Length 是 manifest 文本文件大小（几 KB），不是视频总大小，不存
    const effectiveSize = (format === 'm3u8' || format === 'mpd') ? undefined : (size ?? existing?.size)
    // FLV/MPEG-TS 无 Content-Length 视为直播流（HTTP-FLV 直播的典型特征）
    const isLiveStream = (format === 'flv' || format === 'ts')
      ? (effectiveSize === undefined && !existing?.size)
      : existing?.isLiveStream
    mediaMap.set(url, {
      format,
      size: effectiveSize,
      detectedAt: existing?.detectedAt ?? Date.now(),
      category,
      requestHeaders,
      captureId: extra?.captureId ?? existing?.captureId,
      trackCount: extra?.trackCount ?? existing?.trackCount,
      mseComplete: extra?.mseComplete ?? existing?.mseComplete,
      contentType: contentType ?? existing?.contentType,
      tabTitle: effectiveTabTitle ?? existing?.tabTitle,
      isLiveStream,
    })
    // m3u8/mpd 是潜在 master，bump 版本使前缀索引在下次分片查找时重建
    if (format === 'm3u8' || format === 'mpd') bumpTabVersion(tabId)
    saveTabList(tabId, mediaMap).catch(() => {})
    try { updateBadge(tabId) } catch {}

    // 音视频分离流分组（B站/YouTube/抖音等）
    if (contentType) {
      tryGroupVideoAudio(url, tabId, contentType, size)
    }

    broadcastDebounced(tabId)

    // 异步解析 m3u8/mpd master manifest，建立 variant 分组
    if ((format === 'm3u8' || format === 'mpd') && !manifestParseCache.has(url)) {
      parseAndGroupManifest(url, tabId, format as 'm3u8' | 'mpd', requestHeaders).catch(() => {})
    }
  }

  function updateBadge(tabId: number) {
    const mediaMap = tabMap.get(tabId)
    const count = mediaMap?.size ?? 0
    const action = (browser as any).action || (browser as any).browserAction
    if (!action) return
    action.setBadgeText({ text: count > 0 ? count.toString() : '', tabId })
    if (action.setBadgeTextColor) {
      action.setBadgeTextColor({ color: '#FFFFFF', tabId })
    }
    action.setBadgeBackgroundColor({ color: '#EF4444', tabId })
  }

  function broadcast(tabId: number, list: Array<{url: string, format: string, size?: number, detectedAt?: number, category?: MediaCategory, requestHeaders?: Record<string, string>, captureId?: string, trackCount?: number, mseComplete?: boolean, groupId?: string, groupRole?: string, groupLabel?: string, groupMasterId?: string, variantBandwidth?: number, audioUrl?: string, audioOptions?: Array<{ url: string, label: string }>, duration?: number, coverUrl?: string, tabTitle?: string}>) {
    browser.runtime.sendMessage({ type: 'LIST_UPDATED', tabId, list }).catch(() => {})
  }

  /** Convert Bilibili's playurl response into one virtual stream group. */
  function upsertBilibiliDashTask(tabId: number, task: any, tabTitle?: string) {
    if (!tabMap.has(tabId)) tabMap.set(tabId, new Map())
    const mediaMap = tabMap.get(tabId)!
    const taskKey = String(task.key || 'current').replace(/[^a-zA-Z0-9_-]/g, '_')
    const masterUrl = `vid_grp_bili_${taskKey}`
    const videos = Array.isArray(task.videos) ? task.videos.filter((v: any) => typeof v?.url === 'string') : []
    const audios = Array.isArray(task.audios) ? task.audios.filter((a: any) => typeof a?.url === 'string') : []
    if (!videos.length) return
    const requestHeaders = typeof task.referer === 'string' && task.referer
      ? { Referer: task.referer }
      : (tabPageUrls.get(tabId) ? { Referer: tabPageUrls.get(tabId)! } : undefined)
    const previousMaster = mediaMap.get(masterUrl)
    const duration = Number(task.duration) || undefined
    const preferredAudioBandwidth = Number(audios[0]?.bandwidth || 0)
    const estimateCombinedSize = (video: any): number | undefined => {
      const bandwidth = Number(video?.bandwidth || 0) + preferredAudioBandwidth
      return duration && bandwidth > 0 ? Math.round(duration * bandwidth / 8) : undefined
    }
    // Preserve metadata already obtained for stable CDN URLs when a refreshed
    // playurl replaces the task. Otherwise every refresh clears the size and
    // starts the metadata request over again.
    const previousVariantSizes = new Map<string, number>()
    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl && entry.size) previousVariantSizes.set(url, entry.size)
    }

    // Playurl is refreshed while switching quality. Replace only this virtual
    // task's variants; never expose stale CDN backup URLs as separate cards.
    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl) mediaMap.delete(url)
    }
    const managed = bilibiliManagedUrls.get(tabId) || new Set<string>()
    for (const stream of [...videos, ...audios]) {
      managed.add(stream.url)
      // Remove a direct item which may have been detected before the playurl
      // response was parsed. Video URLs are restored below as grouped variants.
      mediaMap.delete(stream.url)
    }
    bilibiliManagedUrls.set(tabId, managed)
    mediaMap.set(masterUrl, {
      format: 'mpd',
      detectedAt: Date.now(),
      category: 'stream',
      groupId: masterUrl,
      groupRole: 'master',
      duration,
      size: videos.length ? estimateCombinedSize(videos[0]) : undefined,
      coverUrl: typeof task.coverUrl === 'string' && task.coverUrl
        ? task.coverUrl
        : previousMaster?.coverUrl,
      requestHeaders,
      tabTitle: task.title || previousMaster?.tabTitle || tabTitle,
    })
    const audioOptions = audios.map((audio: any) => ({ url: audio.url, label: audio.label || '音频' }))
    const preferredAudio = audioOptions[0]?.url
    for (const video of videos) {
      mediaMap.set(video.url, {
        format: 'mp4',
        detectedAt: Date.now(),
        category: 'stream',
        groupId: masterUrl,
        groupRole: 'variant',
        groupLabel: video.label || '视频',
        groupMasterId: masterUrl,
        variantBandwidth: Number(video.bandwidth || 0),
        width: Number(video.width || 0) || undefined,
        height: Number(video.height || 0) || undefined,
        duration,
        size: previousVariantSizes.get(video.url) || estimateCombinedSize(video),
        audioUrl: preferredAudio,
        audioOptions,
        requestHeaders,
        tabTitle: task.title || tabTitle,
      })
    }
    saveTabList(tabId, mediaMap).catch(() => {})
    updateBadge(tabId)
    broadcastDebounced(tabId)
  }

  // ── 音视频分离流分组（B站/YouTube 等）──────────────────────────────
  // 判断 Content-Type 是否为纯视频轨（无音频）
  const DOUYIN_PAGE_HOST = /(^|\.)(douyin\.com|iesdouyin\.com)$/i
  const DOUYIN_MEDIA_HOST = /(^|\.)(douyinvod|douyincdn|bytecdn|bytego|byteimg|bytedance|amemv|iesdouyin|snssdk|pstatp|toutiaovod|ixigua)\.(com|cn|net)$/i

  function isAllowedDouyinMediaUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      return (url.protocol === 'https:' || url.protocol === 'http:') && DOUYIN_MEDIA_HOST.test(url.hostname)
    } catch {
      return false
    }
  }

  function isValidPlatformTask(task: unknown, senderUrl?: string): task is PlatformMediaTask {
    if (!task || typeof task !== 'object' || !senderUrl) return false
    const value = task as PlatformMediaTask
    try {
      if (!DOUYIN_PAGE_HOST.test(new URL(senderUrl).hostname)) return false
    } catch {
      return false
    }
    if (value.provider !== 'douyin' || typeof value.key !== 'string' || !Array.isArray(value.candidates)) return false
    return value.candidates.length > 0 && value.candidates.every(candidate => !!candidate && isAllowedDouyinMediaUrl(candidate.url))
  }

  /** Provider-neutral grouping for candidates emitted by a platform adapter. */
  function upsertPlatformMediaTask(tabId: number, task: PlatformMediaTask, tabTitle?: string) {
    if (!tabMap.has(tabId)) tabMap.set(tabId, new Map())
    const mediaMap = tabMap.get(tabId)!
    const key = task.key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'current'
    const masterUrl = `vid_grp_${task.provider}_${key}`
    const priorities = platformTaskPriorities.get(tabId) || new Map<string, number>()
    const priority = Number(task.priority || 0)
    if (priority < (priorities.get(masterUrl) || 0)) return
    priorities.set(masterUrl, priority)
    platformTaskPriorities.set(tabId, priorities)
    const candidates = task.candidates
      .filter(candidate => candidate && typeof candidate.url === 'string')
      .filter((candidate, index, list) => list.findIndex(item => item.url === candidate.url) === index)
      .slice(0, 24)
    const audioCandidates = candidates.filter(candidate => candidate.role === 'audio')
    // A provider may not be able to classify a legacy payload. In that case
    // retain the previous direct-video behavior instead of creating an empty group.
    const videoCandidates = candidates.filter(candidate => candidate.role !== 'audio')
    if (!videoCandidates.length) return

    // Detail/feed responses know the identity and artwork of a video, while
    // native preloads only expose CDN URLs. Retain this join information so a
    // later preload-created card can still receive the correct metadata.
    if (task.provider === 'douyin') {
      const metadataByUrl = douyinMediaMetadata.get(tabId) || new Map<string, { title?: string; coverUrl?: string; duration?: number }>()
      const cachedMetadata = videoCandidates
        .map(candidate => metadataByUrl.get(candidate.url) || metadataByUrl.get(getDouyinMediaResourceKey(candidate.url)))
        .find(Boolean)
      task.title ||= cachedMetadata?.title
      task.coverUrl ||= cachedMetadata?.coverUrl
      task.duration ||= cachedMetadata?.duration
      const metadata = {
        title: task.title || cachedMetadata?.title,
        coverUrl: task.coverUrl || cachedMetadata?.coverUrl,
        duration: Number(task.duration) || cachedMetadata?.duration,
      }
      for (const candidate of videoCandidates) {
        metadataByUrl.set(candidate.url, metadata)
        metadataByUrl.set(getDouyinMediaResourceKey(candidate.url), metadata)

        // The native preload may have built its paired card before the API
        // response arrives. Patch that existing card in place instead of
        // replacing it with an API-only card.
        const existingVariantUrl = mediaMap.has(candidate.url)
          ? candidate.url
          : Array.from(mediaMap.keys()).find(url => getDouyinMediaResourceKey(url) === getDouyinMediaResourceKey(candidate.url))
        const existingVariant = existingVariantUrl ? mediaMap.get(existingVariantUrl) : undefined
        const existingMasterId = existingVariant?.groupMasterId
        if (!existingMasterId || existingMasterId === masterUrl) continue
        const existingMaster = mediaMap.get(existingMasterId)
        if (existingMaster) {
          mediaMap.set(existingMasterId, {
            ...existingMaster,
            duration: metadata.duration || existingMaster.duration,
            coverUrl: metadata.coverUrl || existingMaster.coverUrl,
            tabTitle: metadata.title || existingMaster.tabTitle,
          })
        }
        mediaMap.set(existingVariantUrl!, {
          ...existingVariant,
          duration: metadata.duration || existingVariant.duration,
          coverUrl: metadata.coverUrl || existingVariant.coverUrl,
          tabTitle: metadata.title || existingVariant.tabTitle,
        })
      }
      douyinMediaMetadata.set(tabId, metadataByUrl)

      // A feed/detail response frequently exposes only a video URL. It is
      // metadata, not a completed downloadable unit; wait for the player's
      // matching audio/video preload pair to create the visible card.
      if (!audioCandidates.length) {
        saveTabList(tabId, mediaMap).catch(() => {})
        broadcastDebounced(tabId)
        return
      }
    }

    const previousMaster = mediaMap.get(masterUrl)
    const managed = platformManagedUrls.get(tabId) || new Set<string>()
    for (const [url, entry] of mediaMap) {
      if (entry.groupMasterId === masterUrl) mediaMap.delete(url)
    }
    for (const candidate of candidates) {
      mediaMap.delete(candidate.url)
      managed.add(candidate.url)
    }
    platformManagedUrls.set(tabId, managed)

    const requestHeaders = task.referer ? { Referer: task.referer } : undefined
    const duration = Number(task.duration) || Number(videoCandidates[0]?.duration || 0) || undefined
    const audioOptions = audioCandidates.map(candidate => ({
      url: candidate.url,
      label: candidate.label || '音频',
    }))
    const preferredAudio = audioOptions[0]?.url
    mediaMap.set(masterUrl, {
      format: videoCandidates[0]?.format || 'mp4',
      detectedAt: Date.now(), category: 'stream', groupId: masterUrl, groupRole: 'master',
      duration, coverUrl: task.coverUrl || previousMaster?.coverUrl, requestHeaders,
      tabTitle: task.title || previousMaster?.tabTitle || tabTitle,
    })
    for (const candidate of videoCandidates) {
      mediaMap.set(candidate.url, {
        format: candidate.format || 'mp4', detectedAt: Date.now(), category: 'stream',
        groupId: masterUrl, groupRole: 'variant', groupMasterId: masterUrl,
        groupLabel: candidate.label || (candidate.height ? `${candidate.height}p` : '视频'),
        variantBandwidth: Number(candidate.bandwidth || 0) || undefined,
        width: Number(candidate.width || 0) || undefined, height: Number(candidate.height || 0) || undefined,
        duration, coverUrl: task.coverUrl, requestHeaders, tabTitle: task.title || tabTitle,
        audioUrl: preferredAudio, audioOptions: audioOptions.length ? audioOptions : undefined,
      })
    }
    saveTabList(tabId, mediaMap).catch(() => {})
    updateBadge(tabId)
    broadcastDebounced(tabId)
  }

  /**
   * Catch native player preloads (including Douyin's next-card prefetch).
   * These requests bypass page-world fetch/XHR patches but retain the same
   * `l` token on their media-audio/media-video URLs.
   */
  function collectNativeDouyinTrack(tabId: number, value: string) {
    try {
      const pageUrl = tabPageUrls.get(tabId)
      if (!pageUrl || !DOUYIN_PAGE_HOST.test(new URL(pageUrl).hostname)) return
      const url = new URL(value)
      if (!DOUYIN_MEDIA_HOST.test(url.hostname)) return
      const role = /(?:^|[-_/])media-audio(?:[-_/]|$)|\/audio[-_/]/i.test(url.pathname)
        ? 'audio'
        : /(?:^|[-_/])media-video(?:[-_/]|$)|\/video[-_/]/i.test(url.pathname) ? 'video' : undefined
      const key = url.searchParams.get('l') || url.searchParams.get('video_id') || url.searchParams.get('aweme_id')
      if (!role || !key) return

      const byToken = douyinNativeTracks.get(tabId) || new Map<string, Array<{ url: string; role: 'video' | 'audio'; at: number }>>()
      const now = Date.now()
      const pending = (byToken.get(key) || []).filter(track => now - track.at < 30_000)
      const oppositeIndex = pending.findIndex(track => track.role !== role)
      if (oppositeIndex < 0) {
        pending.push({ url: value, role, at: now })
        byToken.set(key, pending)
        douyinNativeTracks.set(tabId, byToken)
        return
      }
      const opposite = pending.splice(oppositeIndex, 1)[0]!
      byToken.set(key, pending)
      douyinNativeTracks.set(tabId, byToken)
      const video = role === 'video' ? value : opposite.url
      const audio = role === 'audio' ? value : opposite.url
      const groupKey = getDouyinTrackGroupKey(video)
      const metadataByUrl = douyinMediaMetadata.get(tabId)
      const metadata = metadataByUrl?.get(video) || metadataByUrl?.get(getDouyinMediaResourceKey(video))

      upsertPlatformMediaTask(tabId, {
        provider: 'douyin', key: groupKey, referer: pageUrl, priority: 4,
        title: metadata?.title || tabPageTitles.get(tabId),
        coverUrl: metadata?.coverUrl,
        duration: metadata?.duration,
        candidates: [
          { url: video, format: 'mp4', role: 'video', label: '视频' },
          { url: audio, format: 'mp4', role: 'audio', label: '音频' },
        ],
      }, tabPageTitles.get(tabId))
    } catch {}
  }

  browser.webRequest.onBeforeRequest.addListener(
    details => {
      if (details.tabId > 0) collectNativeDouyinTrack(details.tabId, details.url)
      return undefined
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  )

  /** A card key is based on the video resource, never on the reusable `l` token. */
  function getDouyinTrackGroupKey(url: string): string {
    let hash = 2166136261
    for (let i = 0; i < url.length; i++) hash = Math.imul(hash ^ url.charCodeAt(i), 16777619)
    return `track_${(hash >>> 0).toString(36)}`
  }

  /** Playback URLs rotate hosts and query signatures; their CDN path is stable. */
  function getDouyinMediaResourceKey(value: string): string {
    try { return new URL(value).pathname } catch { return value }
  }

  function isVideoOnlyContentType(ct: string): boolean {
    const c = ct.toLowerCase()
    if (!c.startsWith('video/')) return false
    // 若 codecs 明确包含音频编码，则是混合流
    const codecsMatch = /codecs="([^"]+)"/.exec(c)
    if (codecsMatch) {
      const codecs = codecsMatch[1]!.toLowerCase()
      // mp4a / opus / vorbis / flac / ac-3 都是音频编码
      if (/mp4a|opus|vorbis|flac|ac-3|ec-3/.test(codecs)) return false
      // 只有视频编码（avc1, hev1, hvc1, vp8, vp9, av01）
      if (/avc1|hev1|hvc1|vp[89]|av01/.test(codecs)) return true
    }
    // 没有 codecs 字段：大文件通常是混合流，小文件或 webm 的 video/webm 倾向 video-only
    // 保守策略：没有明确 codecs 时不判定为 video-only（避免误分组）
    return false
  }

  function isAudioOnlyContentType(ct: string): boolean {
    const c = ct.toLowerCase()
    if (c.startsWith('audio/')) return true
    // video/mp4 with audio-only codecs（B站偶发）
    const codecsMatch = /codecs="([^"]+)"/.exec(c)
    if (codecsMatch) {
      const codecs = codecsMatch[1]!.toLowerCase()
      if (/mp4a|opus|vorbis/.test(codecs) && !/avc1|hev1|vp[89]|av01/.test(codecs)) return true
    }
    return false
  }

  // 提取 URL 的分组 key：去掉 mime/itag/quality/range 等参数，保留核心 id 参数
  function extractVideoGroupKey(url: string): string {
    try {
      const u = new URL(url)
      const host = u.host
      const path = u.pathname
      // 抖音/字节系 CDN：视频和音频 URL 的 path 含不同 hash，参数也常不同
      // 只取 host + path 第一段（通常是 /video 或 /audio）作为分组依据
      if (/\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(host)) {
        const pathSeg = path.split('/').filter(Boolean)[0] ?? ''
        return `${host}/${pathSeg}`
      }
      // YouTube/B站：取所有参数名，去掉已知的分辨率/格式参数，剩余参数排序后作为 key
      const EXCLUDE_PARAMS = new Set([
        'itag', 'mime', 'quality', 'quality_label', 'qlt', 'aitags',
        'range', 'rn', 'rbuf', 'playback_host', 'playlist', 'playlist_type',
        'mime_type', 'backfill', 'audio_quality',
      ])
      const kept: string[] = []
      u.searchParams.forEach((v, k) => {
        if (!EXCLUDE_PARAMS.has(k.toLowerCase())) kept.push(`${k}=${v}`)
      })
      kept.sort()
      return `${host}${path}|${kept.join('&')}`
    } catch {
      // 无法解析时，取 URL 去掉 query 的部分
      return url.split('?')[0] ?? url
    }
  }

  // 从 URL 或 Content-Type 中提取分辨率标签
  function extractQualityLabel(url: string, contentType: string): string {
    // YouTube itag → 分辨率映射
    const itagMap: Record<string, string> = {
      '137': '1080p', '248': '1080p', '299': '1080p60', '303': '1080p60',
      '136': '720p',  '247': '720p',  '298': '720p60',  '302': '720p60',
      '135': '480p',  '244': '480p',
      '134': '360p',  '243': '360p',
      '133': '240p',  '242': '240p',
      '160': '144p',  '278': '144p',
      '271': '1440p', '308': '1440p60',
      '313': '2160p', '315': '2160p60', '272': '2160p',
      '138': '4320p',
    }
    try {
      const u = new URL(url)
      const itag = u.searchParams.get('itag') ?? u.searchParams.get('itagid')
      if (itag && itagMap[itag]) return itagMap[itag]!
      const quality = u.searchParams.get('quality_label') ?? u.searchParams.get('quality') ?? u.searchParams.get('qlt')
      if (quality) return quality
    } catch {}
    // 从 Content-Type codecs 判断大致质量（不精确）
    if (/avc1\.640034|avc1\.640032|hev1\.1.*L153|vp9.*profile2/i.test(contentType)) return '1080p+'
    if (/avc1\.640028|hev1\.1.*L120/i.test(contentType)) return '1080p'
    if (/avc1\.64001f/i.test(contentType)) return '720p'
    if (/avc1\.64001e/i.test(contentType)) return '480p'
    return ''
  }

  // 尝试将新加入的 URL 与同 tab 内已有的 video/audio 条目配对
  const VIDEO_AUDIO_GROUP_WINDOW_MS = 8000

  // 对 application/octet-stream 的已知媒体 CDN URL，用 URL 特征判断 video-only / audio-only
  // 抖音/字节系 CDN 返回 octet-stream 且无 codecs，常规 content-type 判断失效
  function detectStreamRoleFromUrl(url: string): 'video' | 'audio' | null {
    try {
      const u = new URL(url)
      const host = u.host.toLowerCase()
      const path = u.pathname.toLowerCase()
      const full = (host + path).toLowerCase()
      // 已知媒体 CDN 域名
      const isMediaCdn = /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua|ks-yxcdn|kwaixiaodian)\.(?:com|cn|net)\b/i.test(host)
      if (!isMediaCdn) return null
      // URL 路径/参数含 audio 关键字 → audio-only
      if (/audio|aud|sound|\.m4a\b|\.aac\b/.test(full)) return 'audio'
      // URL 路径/参数含 video 关键字 → video-only
      if (/video|vid|\.mp4\b|\.flv\b/.test(full)) return 'video'
      // 无明确关键字：按 URL 中的 ratio/quality 参数判断（视频有清晰度参数，音频没有）
      if (/[?&](ratio|quality|qlt|resolution|vq)=/.test(url)) return 'video'
      return null
    } catch {
      return null
    }
  }

  function tryGroupVideoAudio(newUrl: string, tabId: number, contentType: string, newSize?: number) {
    // 标准 content-type 识别（B站/YouTube：有明确 codecs）
    let isVideo = isVideoOnlyContentType(contentType)
    let isAudio = isAudioOnlyContentType(contentType)

    // application/octet-stream 兜底：抖音/字节系 CDN 用 URL 特征识别
    if (!isVideo && !isAudio) {
      const role = detectStreamRoleFromUrl(newUrl)
      if (role === 'video') isVideo = true
      else if (role === 'audio') isAudio = true
    }
    if (!isVideo && !isAudio) return

    const mediaMap = tabMap.get(tabId)
    if (!mediaMap) return

    const newEntry = mediaMap.get(newUrl)
    if (!newEntry) return

    const now = newEntry.detectedAt ?? Date.now()
    const newKey = extractVideoGroupKey(newUrl)
    const newLabel = extractQualityLabel(newUrl, contentType)

    // 搜索同 tab 内时间窗口内的配对候选
    for (const [candidateUrl, candidateEntry] of mediaMap) {
      if (candidateUrl === newUrl) continue
      if (!candidateEntry.contentType) continue
      const age = Math.abs((candidateEntry.detectedAt ?? 0) - now)
      if (age > VIDEO_AUDIO_GROUP_WINDOW_MS) continue

      // 候选者也先尝试标准 content-type，再尝试 octet-stream 兜底
      let candidateIsVideo = isVideoOnlyContentType(candidateEntry.contentType)
      let candidateIsAudio = isAudioOnlyContentType(candidateEntry.contentType)
      // Douyin can label both isolated tracks as `video/mp4` without codecs.
      // For a known Byte CDN URL, its media-audio/media-video path is then the
      // only reliable track signal; do not reserve this fallback for octet-stream.
      if (!candidateIsVideo && !candidateIsAudio) {
        const role = detectStreamRoleFromUrl(candidateUrl)
        if (role === 'video') candidateIsVideo = true
        else if (role === 'audio') candidateIsAudio = true
      }

      // 需要一个 video-only 和一个 audio-only 配对
      if (isVideo && !candidateIsAudio) continue
      if (isAudio && !candidateIsVideo) continue

      // octet-stream 兜底场景：用 Content-Length 比例做二次校验
      // 视频流通常远大于音频流（>3:1），若大小接近则不配对
      if (contentType === 'application/octet-stream' && candidateEntry.contentType === 'application/octet-stream') {
        const vSize = isVideo ? newSize : candidateEntry.size
        const aSize = isVideo ? candidateEntry.size : newSize
        if (vSize && aSize) {
          if (vSize < aSize * 3) continue // 视频应该比音频大至少 3 倍
        }
      }

      const candidateKey = extractVideoGroupKey(candidateUrl)

      // URL 相似度检查：两个 key 的共同参数占比
      // 抖音/字节系 CDN：key 是简化后的 host/pathSeg，video 和 audio 的 pathSeg 不同
      // 跳过相似度检查，靠时间窗口 + URL 特征 + size 比例配对
      const isDouyinCdn = /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(newUrl)
        && /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(candidateUrl)
      if (!isDouyinCdn) {
        const keySimilarity = computeKeySimilarity(newKey, candidateKey)
        if (keySimilarity < 0.5) continue
      } else {
        // 抖音域名：要求 host 相同
        try {
          if (new URL(newUrl).host !== new URL(candidateUrl).host) continue
        } catch { continue }
      }

      // 确认配对：建立分组
      const videoUrl = isVideo ? newUrl : candidateUrl
      const audioUrl_g = isAudio ? newUrl : candidateUrl
      const videoEntry = mediaMap.get(videoUrl)!
      const audioEntry = mediaMap.get(audioUrl_g)!

      // 如果两者都已分组且同组，跳过
      if (videoEntry.groupId && videoEntry.groupId === audioEntry.groupId) continue

      // 生成 groupId：用 video URL 的核心 key
      const groupId = `vid_grp_${extractVideoGroupKey(videoUrl).substring(0, 60)}`
      const label = newLabel || extractQualityLabel(videoUrl, videoEntry.contentType ?? '') || '未知清晰度'

      // 更新 video 条目：作为 variant，持有 audioUrl
      mediaMap.set(videoUrl, {
        ...videoEntry,
        groupId,
        groupRole: 'variant',
        groupLabel: label,
        groupMasterId: groupId,
        audioUrl: audioUrl_g,
      })

      // 更新 audio 条目：标记为 audio，关联到组
      mediaMap.set(audioUrl_g, {
        ...audioEntry,
        groupId,
        groupRole: 'audio',
        groupMasterId: groupId,
      })

      // 检查 groupId 是否已有 master 条目（虚拟 master）
      if (!mediaMap.has(groupId)) {
        // 创建一个虚拟 master 条目
        mediaMap.set(groupId, {
          format: videoEntry.format,
          detectedAt: Math.min(videoEntry.detectedAt ?? now, audioEntry.detectedAt ?? now),
          category: 'media',
          requestHeaders: videoEntry.requestHeaders,
          groupId,
          groupRole: 'master',
          contentType: 'virtual/group',
        })
      }

      saveTabList(tabId, mediaMap).catch(() => {})
      broadcastDebounced(tabId)
      break
    }
  }

  function computeKeySimilarity(a: string, b: string): number {
    // 比较两个 key（host+path|params） 的相似度
    const aParts = a.split('|')
    const bParts = b.split('|')
    // host+path 必须完全相同
    if (aParts[0] !== bParts[0]) return 0
    // 比较参数
    const aParams = new Set((aParts[1] ?? '').split('&').filter(Boolean))
    const bParams = new Set((bParts[1] ?? '').split('&').filter(Boolean))
    if (aParams.size === 0 && bParams.size === 0) return 1
    let common = 0
    for (const p of aParams) { if (bParams.has(p)) common++ }
    return common / Math.max(aParams.size, bParams.size)
  }

  // ── Manifest 解析缓存与分组 ──────────────────────────────────────
  const manifestParseCache = new Set<string>()
  const manifestFailCache = new Map<string, number>()
  const MANIFEST_PARSE_FAIL_TTL = 60_000

  async function parseAndGroupManifest(masterUrl: string, tabId: number, masterFormat: 'm3u8' | 'mpd', requestHeaders?: Record<string, string>) {
    if (manifestParseCache.has(masterUrl)) return
    const lastFail = manifestFailCache.get(masterUrl)
    if (lastFail && Date.now() - lastFail < MANIFEST_PARSE_FAIL_TTL) return

    const fetchHeaders: Record<string, string> = {}
    if (requestHeaders) {
      for (const [k, v] of Object.entries(requestHeaders)) {
        const kl = k.toLowerCase()
        if (kl === 'referer' || kl === 'origin' || kl === 'cookie' || kl === 'user-agent') {
          fetchHeaders[k] = v
        }
      }
    }

    const fetchText = async (u: string): Promise<string> => {
      const resp = await fetch(u, { headers: fetchHeaders, cache: 'no-store', credentials: 'omit' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return resp.text()
    }

    try {
      const parsed = masterFormat === 'mpd'
        ? await parseDashManifest(masterUrl, fetchText)
        : await parseM3U8Manifest(masterUrl, fetchText, fetchHeaders)

      if (parsed.variants.length === 0) {
        const mm = tabMap.get(tabId)
        if (mm) {
          const entry = mm.get(masterUrl)
          if (entry) {
            const bw = entry.variantBandwidth
            const estSizeFromBw = (bw && bw > 0 && parsed.duration && parsed.duration > 0 && !entry.size)
              ? Math.round(bw / 8 * parsed.duration)
              : undefined
            const newSize = entry.size ?? estSizeFromBw ?? parsed.estimatedSize
            const newDuration = entry.duration ?? parsed.duration
            if (newDuration !== entry.duration || newSize !== entry.size) {
              mm.set(masterUrl, { ...entry, duration: newDuration, size: newSize })
              saveTabList(tabId, mm).catch(() => {})
              broadcastDebounced(tabId)
            }
          }
        }
        // 单码率 media playlist：duration 和 size 都已尝试获取，加入缓存避免重复请求
        // 若 size 仍未拿到，允许 60s 后重试（segment 服务器可能临时不可用）
        if (parsed.estimatedSize || parsed.duration) {
          manifestParseCache.add(masterUrl)
        } else {
          manifestFailCache.set(masterUrl, Date.now())
        }
        return
      }

      const mediaMap = tabMap.get(tabId)
      if (!mediaMap) return
      const masterEntry = mediaMap.get(masterUrl)
      if (!masterEntry) return

      const groupId = masterUrl

      // 用最高码率 variant + 时长估算总大小（bandwidth bps / 8 * duration = bytes）
      // 若没有 bandwidth，则使用 stream-parser 抽样 segment 估算的大小
      const topBandwidth = parsed.variants.reduce((max, v) => Math.max(max, v.bandwidth ?? 0), 0)
      const estimatedSize = (topBandwidth > 0 && parsed.duration && parsed.duration > 0)
        ? Math.round(topBandwidth / 8 * parsed.duration)
        : parsed.estimatedSize

      // 标记 master 条目，写入解析得到的时长和估算大小
      mediaMap.set(masterUrl, {
        ...masterEntry,
        groupId,
        groupRole: 'master',
        duration: parsed.duration ?? masterEntry.duration,
        size: estimatedSize ?? masterEntry.size,
      })

      for (const variant of parsed.variants) {
        const existing = mediaMap.get(variant.uri)
        if (existing && existing.groupRole && existing.groupRole !== 'segment') continue

        mediaMap.set(variant.uri, {
          format: masterFormat === 'mpd' ? 'mpd' : 'm3u8',
          size: existing?.size,
          detectedAt: existing?.detectedAt ?? Date.now(),
          category: 'media',
          requestHeaders: requestHeaders ?? masterEntry.requestHeaders,
          groupId,
          groupRole: 'variant',
          groupLabel: variant.label,
          groupMasterId: masterUrl,
          variantBandwidth: variant.bandwidth,
          audioUrl: variant.audioUri,
        })

        if (variant.audioUri && !mediaMap.has(variant.audioUri)) {
          mediaMap.set(variant.audioUri, {
            format: 'm3u8',
            detectedAt: Date.now(),
            category: 'media',
            requestHeaders: requestHeaders ?? masterEntry.requestHeaders,
            groupId,
            groupRole: 'audio',
            groupMasterId: masterUrl,
          })
        }
      }

      saveTabList(tabId, mediaMap).catch(() => {})
      manifestParseCache.add(masterUrl)
      broadcastDebounced(tabId)
    } catch (e) {
      manifestFailCache.set(masterUrl, Date.now())
      console.warn('[FlowPick] manifest parse failed:', masterUrl, (e as Error)?.message)
    }
  }
})
