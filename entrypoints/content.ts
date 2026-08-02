export default defineContentScript({
  matches: ['*://*/*'],
  allFrames: true,
  runAt: 'document_end',
  main() {
    if (!document.querySelector('script[data-m3u8-injected]')) {
      const script = document.createElement('script')
      script.src = browser.runtime.getURL('/injected.js')
      script.dataset.m3u8Injected = '1'
      ;(document.head || document.documentElement).appendChild(script)
    }

    browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: any) => {
      if (s?.enableMseCapture) {
        window.postMessage({ type: 'FLOWPICK_MSE_ENABLE' }, '*')
      }
      if (s?.captureDataImages) {
        window.postMessage({
          type: 'FLOWPICK_DATA_IMAGES_ENABLE',
          minSizeKB: s.dataImageMinSizeKB ?? 50,
        }, '*')
      }
    }).catch(() => {})

    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.data?.type === 'FLOWPICK_PING') {
        window.postMessage({ type: 'FLOWPICK_PONG', version: browser.runtime.getManifest().version }, '*')
      }
      if (event.data?.type === 'FLOWPICK_REQUEST_DOWNLOAD') {
        let retries = 0
        function tryFetch() {
          browser.runtime.sendMessage({ type: 'FLOWPICK_DOWNLOAD_READY' }).then((resp: any) => {
            if (resp?.ok && resp.url) {
              window.postMessage({
                type: 'FLOWPICK_DOWNLOAD_DATA',
                url: resp.url,
                format: resp.format,
                filename: resp.filename,
                sourceUrl: resp.sourceUrl,
                requestHeaders: resp.requestHeaders,
                audioUrl: resp.audioUrl,
              }, '*')
            } else if (retries < 20) {
              retries++
              setTimeout(tryFetch, 300)
            }
          })
        }
        tryFetch()
      }
    })

    // 接收 background 发来的消息，通过 postMessage 转发给页面
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'FLOWPICK_SOURCE_URL' && msg.sourceUrl) {
        window.postMessage({ type: 'FLOWPICK_SOURCE_URL', sourceUrl: msg.sourceUrl }, '*')
      }
      if (msg.type === 'PROXY_FETCH_RESPONSE') {
        window.postMessage(msg, '*')
      }
      if (msg.type === 'FLOWPICK_NOTIFY_CLICK') {
        window.postMessage({ type: 'FLOWPICK_NOTIFY_CLICK', tag: msg.tag }, '*')
      }
      if (msg.type === 'MSE_DOWNLOAD_TRIGGER') {
        const { captureId, title } = msg
        const channel = new MessageChannel()
        channel.port1.onmessage = (e) => {
          if (e.data?.type === 'MSE_DOWNLOAD_DATA') {
            handleMseDownload(e.data)
          }
        }
        window.postMessage({ type: 'MSE_DOWNLOAD_REQUEST', captureId }, '*', [channel.port2])
      }
      if (msg.type === 'FLOWPICK_SETTINGS_CHANGED') {
        if (msg.enableMseCapture) {
          window.postMessage({ type: 'FLOWPICK_MSE_ENABLE' }, '*')
        }
        if (msg.captureDataImages) {
          window.postMessage({
            type: 'FLOWPICK_DATA_IMAGES_ENABLE',
            minSizeKB: msg.dataImageMinSizeKB ?? 50,
          }, '*')
        }
      }
    })

    window.dispatchEvent(new CustomEvent('m3u8ext:ready'))

    let currentTabId: number | undefined
    const flowpickFetchControllers = new Map<string, AbortController>()

    // 批量缓冲 M3U8_DETECTED：HLS 直播首屏可能并发数十条分片，逐条 sendMessage
    // 会产生大量 IPC 往返。用 50ms 窗口合并成单条 MEDIA_FOUND_BATCH。
    const mediaBuffer: Array<{ url: string; format: string }> = []
    let mediaFlushTimer: ReturnType<typeof setTimeout> | null = null
    // Last-resort Douyin player collector. Unlike generic media sniffing this
    // preserves the relation carried by the CDN playback token, before either
    // URL is rendered as an independent card.
    const douyinTracks = new Map<string, Array<{ url: string; role: 'video' | 'audio'; at: number }>>()
    const douyinGroupKey = (url: string) => {
      let hash = 2166136261
      for (let i = 0; i < url.length; i++) hash = Math.imul(hash ^ url.charCodeAt(i), 16777619)
      return `track_${(hash >>> 0).toString(36)}`
    }
    const isDouyinCdnTrack = (value: string): { key: string; role: 'video' | 'audio' } | undefined => {
      if (window.top !== window) return undefined
      try {
        const parsed = new URL(value)
        if (!/\.(douyinvod|douyincdn|amemv|iesdouyin|snssdk|bytecdn|bytego|bytedance|toutiaovod)\.(?:com|cn|net)$/i.test(parsed.hostname)) return undefined
        const role = /(?:^|[-_/])media-audio(?:[-_/]|$)|\/audio[-_/]/i.test(parsed.pathname)
          ? 'audio'
          : /(?:^|[-_/])media-video(?:[-_/]|$)|\/video[-_/]/i.test(parsed.pathname) ? 'video' : undefined
        const key = parsed.searchParams.get('l') || parsed.searchParams.get('video_id') || parsed.searchParams.get('aweme_id')
        return role && key ? { key, role } : undefined
      } catch {
        return undefined
      }
    }
    const collectDouyinPlayerTrack = (url: string) => {
      const track = isDouyinCdnTrack(url)
      if (!track) return
      const now = Date.now()
      const pending = (douyinTracks.get(track.key) || []).filter(item => now - item.at < 30_000)
      const oppositeIndex = pending.findIndex(item => item.role !== track.role)
      if (oppositeIndex < 0) {
        pending.push({ url, role: track.role, at: now })
        douyinTracks.set(track.key, pending)
        return
      }
      const opposite = pending.splice(oppositeIndex, 1)[0]!
      douyinTracks.set(track.key, pending)
      const video = track.role === 'video' ? url : opposite.url
      const audio = track.role === 'audio' ? url : opposite.url
      const coverUrl = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content
      const duration = document.querySelector('video')?.duration
      browser.runtime.sendMessage({
        type: 'PLATFORM_MEDIA_FOUND',
        task: {
          provider: 'douyin', key: douyinGroupKey(video), referer: location.href, priority: 3,
          title: document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title || undefined,
          coverUrl: coverUrl || undefined,
          duration: Number.isFinite(duration) && duration! > 0 ? duration : undefined,
          candidates: [
            { url: video, format: 'mp4', role: 'video', label: '视频' },
            { url: audio, format: 'mp4', role: 'audio', label: '音频' },
          ],
        },
      }).catch(() => {})
    }
    let tabIdFetching = false
    async function ensureTabId(): Promise<number | undefined> {
      if (currentTabId) return currentTabId
      if (tabIdFetching) {
        // 等待正在进行的获取完成
        while (tabIdFetching) await new Promise(r => setTimeout(r, 5))
        return currentTabId
      }
      tabIdFetching = true
      try {
        const tab = await browser.runtime.sendMessage({ type: 'GET_CURRENT_TAB' })
        currentTabId = tab?.id
      } catch {}
      tabIdFetching = false
      // tabId 就绪后若有缓冲数据且无定时器，立即排一次 flush
      if (currentTabId && mediaBuffer.length > 0 && mediaFlushTimer === null) {
        mediaFlushTimer = setTimeout(flushMediaBuffer, 50)
      }
      return currentTabId
    }
    function flushMediaBuffer() {
      mediaFlushTimer = null
      if (mediaBuffer.length === 0 || !currentTabId) return
      const batch = mediaBuffer.splice(0)
      browser.runtime.sendMessage({
        type: 'MEDIA_FOUND_BATCH',
        tabId: currentTabId,
        items: batch,
      }).catch(() => {})
    }

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return

      // injected 脚本加载后主动请求设置，补发避免竞态丢失
      if (event.data?.type === 'FLOWPICK_REQUEST_SETTINGS') {
        browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: any) => {
          if (s?.enableMseCapture) {
            window.postMessage({ type: 'FLOWPICK_MSE_ENABLE' }, '*')
          }
          if (s?.captureDataImages) {
            window.postMessage({
              type: 'FLOWPICK_DATA_IMAGES_ENABLE',
              minSizeKB: s.dataImageMinSizeKB ?? 50,
            }, '*')
          }
        }).catch(() => {})
      }

      if (
        event.data?.type === 'M3U8_DETECTED' &&
        typeof event.data.url === 'string'
      ) {
        collectDouyinPlayerTrack(event.data.url)
        mediaBuffer.push({ url: event.data.url, format: event.data.format || 'm3u8' })
        if (!currentTabId && !tabIdFetching) ensureTabId()
        if (mediaFlushTimer === null) {
          mediaFlushTimer = setTimeout(flushMediaBuffer, 50)
        }
        return
      }

      if (event.data?.type === 'BILIBILI_DASH_DETECTED' && event.data.task) {
        if (!currentTabId) {
          const tab = await browser.runtime.sendMessage({ type: 'GET_CURRENT_TAB' })
          currentTabId = tab?.id
        }
        if (currentTabId) {
          browser.runtime.sendMessage({ type: 'BILIBILI_DASH_FOUND', tabId: currentTabId, task: event.data.task })
        }
        return
      }

      if (event.data?.type === 'PLATFORM_MEDIA_DETECTED' && event.data.task) {
        browser.runtime.sendMessage({ type: 'PLATFORM_MEDIA_FOUND', task: event.data.task }).catch(() => {})
        return
      }

      if (event.data?.type === 'MSE_STREAM_UPDATE') {
        if (!currentTabId) {
          const tab = await browser.runtime.sendMessage({ type: 'GET_CURRENT_TAB' })
          currentTabId = tab?.id
        }
        if (currentTabId) {
          browser.runtime.sendMessage({
            type: 'MSE_STREAM_UPDATE',
            tabId: currentTabId,
            captureId: event.data.captureId,
            title: event.data.title,
            totalBytes: event.data.totalBytes,
            trackCount: event.data.trackCount,
            complete: event.data.complete,
          }).catch(() => {})
        }
        return
      }

      if (
        event.data?.type === 'EXT_DOWNLOAD_REQUEST' &&
        typeof event.data.url === 'string'
      ) {
        const { url, format = 'm3u8', filename, requestId } = event.data
        try {
          await browser.runtime.sendMessage({
            type: 'OPEN_DOWNLOAD_PAGE',
            url,
            format,
            filename: filename || getFilenameFromUrl(url),
          })
          window.postMessage({ type: 'EXT_DOWNLOAD_RESPONSE', requestId, ok: true }, '*')
        } catch {
          window.postMessage({ type: 'EXT_DOWNLOAD_RESPONSE', requestId, ok: false }, '*')
        }
      }

      if (
        event.data?.type === 'FLOWPICK_FETCH' &&
        typeof event.data.url === 'string'
      ) {
        const { url, requestId, options, responseType = 'arraybuffer' } = event.data
        const abortController = new AbortController()
        flowpickFetchControllers.set(requestId, abortController)
        try {
          const fetchOptions: RequestInit = { signal: abortController.signal, cache: 'no-store' }
          if (options?.headers) {
            // 剔除浏览器可能附加的缓存/条件请求头，避免命中 HTTP 缓存返回 206 局部内容
            const CACHE_HEADER_NAMES = new Set([
              'cache-control', 'pragma', 'if-modified-since', 'if-none-match',
              'if-range', 'if-match', 'if-unmodified-since', 'warning'
            ])
            const clean: Record<string, string> = {}
            for (const [k, v] of Object.entries(options.headers)) {
              if (!CACHE_HEADER_NAMES.has(String(k).toLowerCase())) clean[k] = v as string
            }
            fetchOptions.headers = clean
          }
          const response = await fetch(url, fetchOptions)
          flowpickFetchControllers.delete(requestId)
          const headers: Record<string, string> = {}
          response.headers.forEach((value, key) => { headers[key] = value })

          if (responseType === 'text') {
            const text = await response.text()
            window.postMessage({
              type: 'FLOWPICK_FETCH_RESPONSE',
              requestId,
              ok: response.ok,
              status: response.status,
              headers,
              text,
              responseType: 'text',
            }, '*')
          } else {
            const arrayBuffer = await response.arrayBuffer()
            window.postMessage({
              type: 'FLOWPICK_FETCH_RESPONSE',
              requestId,
              ok: response.ok,
              status: response.status,
              headers,
              buffer: arrayBuffer,
              responseType: 'arraybuffer',
            }, '*', [arrayBuffer])
          }
        } catch (err) {
          flowpickFetchControllers.delete(requestId)
          if (err instanceof DOMException && err.name === 'AbortError') return
          window.postMessage({ type: 'FLOWPICK_FETCH_RESPONSE', requestId, ok: false }, '*')
        }
      }

      if (
        event.data?.type === 'FLOWPICK_FETCH_CANCEL' &&
        typeof event.data.requestId === 'string'
      ) {
        const ctrl = flowpickFetchControllers.get(event.data.requestId)
        if (ctrl) {
          ctrl.abort()
          flowpickFetchControllers.delete(event.data.requestId)
        }
      }

      if (
        event.data?.type === 'FLOWPICK_PROXY_FETCH' &&
        typeof event.data.url === 'string'
      ) {
        const { url, requestId, responseType, options } = event.data

        browser.runtime.sendMessage({
          type: 'PROXY_FETCH',
          url,
          options,
          requestId,
        }).then((resp: any) => {
          if (!resp || !resp.ok) {
            window.postMessage({
              type: 'FLOWPICK_PROXY_FETCH_RESPONSE',
              requestId,
              ok: false,
              status: resp?.status,
              error: resp?.error,
            }, '*')
            return
          }
          const arrayBuffer = b64ToArrayBuffer(resp.data)
          const msg: any = {
            type: 'FLOWPICK_PROXY_FETCH_RESPONSE',
            requestId,
            ok: true,
            status: resp.status,
            headers: resp.headers || {},
            buffer: arrayBuffer,
            responseType: responseType || 'arraybuffer',
          }
          if (responseType === 'text') {
            msg.text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer))
          }
          window.postMessage(msg, '*', [arrayBuffer])
        }).catch(() => {
          window.postMessage({
            type: 'FLOWPICK_PROXY_FETCH_RESPONSE',
            requestId,
            ok: false,
          }, '*')
        })
      }

      if (
        event.data?.type === 'FLOWPICK_PROXY_FETCH_CANCEL' &&
        typeof event.data.requestId === 'string'
      ) {
        // 页面停止播放/离开时主动取消后台的代理拉取，避免后台继续请求分片
        browser.runtime.sendMessage({
          type: 'PROXY_FETCH_CANCEL',
          requestId: event.data.requestId,
        }).catch(() => {})
      }

      if (
        event.data?.type === 'FLOWPICK_NOTIFY' &&
        typeof event.data.title === 'string'
      ) {
        // 普通网页（content 注入）请求扩展后台代发系统通知：
        // 转发给 background，由其调用 chrome.notifications；处理完成后回传 ACK，
        // 页面据此判定扩展已接管，避免再退化为网页通知造成重复。
        const { title, body, tag, pageUrl } = event.data
        browser.runtime.sendMessage({ type: 'FLOWPICK_NOTIFY', title, body, tag, pageUrl: pageUrl || window.location.href })
          .then(() => window.postMessage({ type: 'FLOWPICK_NOTIFY_ACK', tag }, '*'))
          .catch(() => { /* 扩展未处理：页面将回退到网页通知 */ })
      }
    })


    function handleMseDownload(data: {
      captureId: string
      title: string
      tracks: Array<{ mimeType: string; buffers: ArrayBuffer[] }>
    }) {
      try {
        const { title, tracks } = data
        const safeTitle = (title || 'mse-capture').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i]
          if (!track.buffers || !track.buffers.length) continue

          const totalSize = track.buffers.reduce((s, b) => s + b.byteLength, 0)
          const merged = new Uint8Array(totalSize)
          let offset = 0
          for (const buf of track.buffers) {
            merged.set(new Uint8Array(buf), offset)
            offset += buf.byteLength
          }

          const isVideo = track.mimeType.startsWith('video/')
          const isAudio = track.mimeType.startsWith('audio/')
          const ext = isVideo ? 'mp4' : isAudio ? 'm4a' : 'bin'
          const suffix = tracks.length > 1 ? `_track${i + 1}` : ''
          const filename = `${safeTitle}${suffix}.${ext}`

          const blob = new Blob([merged], { type: track.mimeType || 'application/octet-stream' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = filename
          a.style.display = 'none'
          document.body.appendChild(a)
          a.click()
          setTimeout(() => {
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
          }, 10000)
        }
      } catch {}
    }

    function b64ToArrayBuffer(b64: string): ArrayBuffer {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }

    function getFilenameFromUrl(url: string): string {
      try {
        const pathname = new URL(url).pathname
        return pathname.split('/').pop() || 'download'
      } catch {
        return 'download'
      }
    }
  },
})
