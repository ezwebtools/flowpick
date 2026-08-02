export default defineUnlistedScript(() => {
  const sentUrls = new Set<string>()
  const sentBilibiliTasks = new Set<string>()
  const sentPlatformTasks = new Set<string>()
  // data: URL 内嵌图片嗅探（默认关闭，收到 FLOWPICK_DATA_IMAGES_ENABLE 后开启）
  let dataImagesEnabled = false
  let dataImageMinBytes = 50 * 1024

  // ── data: URL 工具函数（内联，因 main world 注入不能 import） ──────
  const DATA_IMAGE_PREFIX_RE = /^data:image\/([a-z0-9.+-]+)\s*(?:;([^,]*))?\s*,/i
  function detectDataImageUrl(url: string): string | null {
    if (!url || !url.startsWith('data:')) return null
    const m = url.match(DATA_IMAGE_PREFIX_RE)
    if (!m) return null
    const sub = m[1]!.toLowerCase()
    const map: Record<string, string> = {
      png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp',
      'svg+xml': 'svg', bmp: 'bmp', 'x-icon': 'ico',
      'vnd.microsoft.icon': 'ico', avif: 'avif', heic: 'heic', heif: 'heif',
    }
    return map[sub] || null
  }
  function estimateDataUrlBytes(url: string): number {
    if (!url || !url.startsWith('data:')) return 0
    const i = url.indexOf(',')
    if (i < 0) return 0
    const meta = url.slice(0, i)
    const payload = url.slice(i + 1)
    if (meta.includes('base64')) {
      const c = payload.replace(/\s/g, '')
      const pad = c.endsWith('==') ? 2 : c.endsWith('=') ? 1 : 0
      return Math.floor((c.length * 3) / 4) - pad
    }
    try { return decodeURIComponent(payload).length } catch { return payload.length }
  }

  const isBilibiliPage = /(^|\.)bilibili\.com$/i.test(location.hostname)
  // YouTube is intentionally excluded from sniffing. Keep this guard at the
  // common entry point so generic Fetch/XHR/DOM detection cannot report it.
  const isYouTubePage = /(^|\.)(youtube\.com|youtu\.be)$/i.test(location.hostname)
  // Only pages that actually host a Bilibili player may establish a fallback
  // primary playurl.  On feeds/search pages every playurl is normally a
  // hover-card preview, so accepting the first one produces a cover-less
  // pseudo main-video card.
  function isBilibiliWatchPage(): boolean {
    // This script survives Bilibili's SPA navigation.  Do not cache the
    // pathname at injection time, otherwise the decision is made for the
    // previous page after the user switches videos or autoplay advances.
    return /^\/(?:video\/|bangumi\/play\/|list\/|festival\/play\/)/i.test(location.pathname)
  }

  function getBilibiliRouteKey(): string {
    // Ignore tracking parameters, but retain identifiers that can select a
    // different item without changing /video/BV... (notably multi-part `p`).
    const params = new URLSearchParams(location.search)
    const identity = ['p', 'cid', 'ep_id']
      .map(name => {
        const value = params.get(name)
        return value ? `${name}=${value}` : ''
      })
      .filter(Boolean)
      .join('&')
    return identity ? `${location.pathname}?${identity}` : location.pathname
  }

  // Bilibili's SPA router can leave __INITIAL_STATE__ pointing at the
  // previous video after an autoplay/related-video transition.  Cache the
  // cid resolved from the *current URL* so ownership checks never depend on
  // that stale page object.
  interface BilibiliRouteMeta {
    cid: string
    coverUrl?: string
    title?: string
    duration?: number
  }
  const bilibiliRouteMeta = new Map<string, BilibiliRouteMeta>()

  function getBilibiliPageCid(): string | undefined {
    try {
      const resolvedCid = bilibiliRouteMeta.get(getBilibiliRouteKey())?.cid
      if (resolvedCid) return resolvedCid
      const state = (window as any).__INITIAL_STATE__
      const part = Number(new URLSearchParams(location.search).get('p') || 1)
      const partCid = state?.videoData?.pages?.[Math.max(0, part - 1)]?.cid
      const candidates = [
        partCid,
        state?.videoData?.cid,
        state?.epInfo?.cid,
        state?.episodeInfo?.cid,
        state?.videoInfo?.cid,
        state?.cid,
      ]
      for (const value of candidates) {
        if (value !== undefined && value !== null && String(value)) return String(value)
      }
    } catch {}
    return undefined
  }

  async function resolveBilibiliRouteCid(routeKey = getBilibiliRouteKey()): Promise<void> {
    try {
      const match = /\/video\/(BV[\w]+)/i.exec(location.pathname)
      if (!match) return
      const part = Math.max(1, Number(new URLSearchParams(location.search).get('p') || 1))
      // Use the page's native fetch rather than an extension request: this is
      // a same-origin public page API and carries the same session context as
      // the player itself.  It runs once per actual route change.
      const response = await originalFetch(`${location.origin}/x/web-interface/view?bvid=${encodeURIComponent(match[1]!)}`, {
        credentials: 'same-origin',
      })
      if (!response.ok || routeKey !== getBilibiliRouteKey()) return
      const json = await response.json()
      const data = json?.data
      const page = data?.pages?.[part - 1]
      const cid = page?.cid || data?.cid
      if (cid === undefined || cid === null || !String(cid)) return
      const rawCover = page?.first_frame || data?.pic
      let coverUrl: string | undefined
      if (typeof rawCover === 'string' && rawCover) {
        try { coverUrl = new URL(rawCover, location.href).href } catch { coverUrl = rawCover }
      }
      bilibiliRouteMeta.set(routeKey, {
        cid: String(cid),
        coverUrl,
        title: String(page?.part || data?.title || '').trim() || undefined,
        duration: Number(page?.duration || data?.duration || 0) || undefined,
      })
      flushPendingBilibiliPlayurls()
    } catch {}
  }
  // The page's embedded playinfo identifies the actual video being watched.
  // Hover cards request their own playurl payloads, which must not become
  // downloadable stream groups for the current page.
  let primaryBilibiliTaskKey: string | undefined
  // __playinfo__ is reliable for the initial document only. After Bilibili's
  // SPA navigates it commonly remains the previous video's payload even when
  // the title, cover and URL have already changed.
  let hasBilibiliSpaNavigated = false
  // A route transition briefly leaves window.__playinfo__ pointing at the
  // previous video.  While waiting for the new page state, never let that
  // stale object establish a new primary stream.
  let awaitingBilibiliPageInfo = false
  // A player response can arrive a few hundred milliseconds before Bilibili
  // updates __INITIAL_STATE__ during SPA navigation.  Keep it briefly instead
  // of mistaking it for a hover-preview response and dropping the new video.
  const pendingBilibiliPlayurls = new Map<string, {
    json: any
    sourceUrl?: string
    routeKey: string
    createdAt: number
  }>()

  function rememberPendingBilibiliPlayurl(json: any, sourceUrl: string | undefined, routeKey: string, key: string): void {
    pendingBilibiliPlayurls.set(`${routeKey}:${key}`, {
      json,
      sourceUrl,
      routeKey,
      createdAt: Date.now(),
    })
    for (const [pendingKey, entry] of pendingBilibiliPlayurls) {
      if (Date.now() - entry.createdAt > 15_000 || pendingBilibiliPlayurls.size > 20) {
        pendingBilibiliPlayurls.delete(pendingKey)
      }
    }
  }

  function flushPendingBilibiliPlayurls(): void {
    const currentCid = getBilibiliPageCid()
    if (!currentCid) return
    for (const [pendingKey, entry] of pendingBilibiliPlayurls) {
      const data = entry.json?.data ?? entry.json?.result ?? entry.json
      const responseKey = getBilibiliRequestCid(entry.sourceUrl) || getBilibiliTaskKey(data, entry.sourceUrl)
      if (responseKey !== currentCid) continue
      pendingBilibiliPlayurls.delete(pendingKey)
      // The player may request/receive the next video before pushState updates
      // location. CID, rather than the route observed at request time, is the
      // reliable ownership key.
      parseBilibiliPlayurl(entry.json, entry.sourceUrl, false)
    }
  }

  function getBilibiliSubtitleFormat(url: string): string | null {
    const path = url.toLowerCase().split(/[?#]/, 1)[0]
    if (/\.(vtt|srt|ass|ssa)$/.test(path)) return path.slice(path.lastIndexOf('.') + 1)
    // Bilibili player APIs frequently contain "subtitle" or "caption" in
    // their path, but return a protobuf subtitle *catalog* rather than a text
    // subtitle file.  Naming that response .vtt produces unreadable garbage
    // such as the captured `view.vtt`.  Do not infer a text format from an API
    // name: only a genuine subtitle-file extension is safe to download.
    return null
  }

  const SITE_RULES: Array<{ test: (url: string, hostname: string) => boolean; format: string | ((url: string) => string) }> = [
    {
      test: (url, hostname) => hostname.includes('youku.com') && (url.includes('.m3u8') || url.includes('/m3u8')),
      format: 'm3u8',
    },
    {
      test: (url, hostname) =>
        (hostname.includes('iqiyi.com') || hostname.includes('qiyi.com')) &&
        (url.includes('.m3u8') || url.includes('.mpd') || url.includes('/dash')),
      format: (url: string) => url.includes('.mpd') || url.includes('/dash') ? 'mpd' : 'm3u8',
    },
    {
      test: (url, hostname) =>
        (hostname.includes('video.qq.com') || hostname.includes('qqvideo.tc.qq.com')) &&
        (url.includes('.m3u8') || url.includes('.mpd')),
      format: (url: string) => url.includes('.mpd') ? 'mpd' : 'm3u8',
    },
    // 抖音直播：HTTP-FLV 流，URL 常无 .flv 扩展名，走 fetch 拉流
    {
      test: (url, hostname) =>
        (hostname.includes('live.douyin.com') || hostname.includes('pull-flv') || hostname.includes('pull-hls'))
        && (url.includes('/flv') || url.includes('.flv') || url.includes('live')),
      format: 'flv',
    },
    // 抖音/字节系短视频 CDN：URL 无扩展名，content-type 多为 octet-stream
    // 兜底按 mp4 识别（background 侧 webRequest 会用 content-type 校正）
    {
      test: (url, hostname) =>
        /\.(douyinvod|douyinpic|douyincdn|amemv|iesdouyin|snssdk|bytecdn|byteimg|bytego|bytedns|byteoss|bytedance|pstatp|toutiaovod|ixigua)\.(?:com|cn|net)\b/i.test(hostname)
        && !url.includes('.m3u8') && !url.includes('.mpd'),
      format: (url: string) => {
        // URL 含 flv 标记视为直播流
        if (/\.flv|\/flv|live/i.test(url)) return 'flv'
        return 'mp4'
      },
    },
  ]

  function detectSiteFormat(url: string): string | null {
    let hostname = ''
    try { hostname = new URL(url).hostname.toLowerCase() } catch { return null }
    for (const rule of SITE_RULES) {
      if (rule.test(url, hostname)) return typeof rule.format === 'function' ? rule.format(url) : rule.format
    }
    return null
  }

  // 预编译正则：一次扫描完成扩展名识别，替代此前 N 次 indexOf 线性查找
  // 顺序按"特异性优先"：m3u8 必须在 m3u 之前匹配，避免 .m3u8 被截断成 m3u
  const EXT_REGEX = /\.(m3u8|m3u|mpd|mp4|webm|mkv|flv|mov|avi|mp3|aac|flac|ogg|wav)(?:[?#\/]|$)/i
  const EXT_TO_FMT: Record<string, string> = {
    m3u8: 'm3u8', m3u: 'm3u8', mpd: 'mpd',
    mp4: 'mp4', webm: 'webm', mkv: 'mkv',
    flv: 'flv', mov: 'mov', avi: 'avi',
    mp3: 'mp3', aac: 'aac', flac: 'flac',
    ogg: 'ogg', wav: 'wav',
  }
  // 分片扩展名快速排除（单次正则，避免 some() + hasExtension 的 N 次扫描）
  const EXCLUDED_EXT_REGEX = /\.(m4s|m4f|m4i|cmfv|cmfa|cmft|ts)(?:[?#\/]|$)/i

  function getFormatFromUrl(url: string): string | null {
    // 分片扩展名短路：先排除再识别，避免 .m4s 等被 EXT_REGEX 误判
    if (EXCLUDED_EXT_REGEX.test(url)) return null
    const m = EXT_REGEX.exec(url)
    if (m) return EXT_TO_FMT[m[1]!.toLowerCase()] ?? null
    return detectSiteFormat(url)
  }

  function send(url: string, format: string) {
    if (sentUrls.has(url)) return
    sentUrls.add(url)
    // 超量时淘汰最旧的一批，而非全清。全清会导致短窗口内同一 URL 被重复
    // postMessage，background 又重复 addMedia/broadcast，造成 UI 抖动。
    if (sentUrls.size > 5000) {
      const it = sentUrls.values()
      for (let i = 0; i < 1000; i++) {
        const v = it.next()
        if (v.done) break
        sentUrls.delete(v.value)
      }
    }
    window.postMessage({ type: 'M3U8_DETECTED', url, format }, '*')
  }

  function tryDetect(url: unknown) {
    try {
      if (isYouTubePage) return
      let urlStr: string | null = null
      if (typeof url === 'string') urlStr = url
      else if (url instanceof URL) urlStr = url.toString()
      else if (url instanceof Request) urlStr = url.url
      if (!urlStr) return
      // data: URL 内嵌图片（开关开启时才处理）
      if (urlStr.startsWith('data:')) {
        if (!dataImagesEnabled) return
        const fmt = detectDataImageUrl(urlStr)
        if (!fmt) return
        const bytes = estimateDataUrlBytes(urlStr)
        if (bytes < dataImageMinBytes) return
        // 用内容哈希做 key，避免超长 data URL 重复入 sentUrls
        let key: string
        if (urlStr.length <= 200) {
          key = urlStr
        } else {
          let h = 0
          for (let i = 0; i < urlStr.length; i++) {
            h = ((h << 5) - h + urlStr.charCodeAt(i)) | 0
          }
          key = `data:${fmt}:${urlStr.length}:${h}`
        }
        if (sentUrls.has(key)) return
        sentUrls.add(key)
        if (sentUrls.size > 5000) {
          const it = sentUrls.values()
          for (let i = 0; i < 1000; i++) {
            const v = it.next()
            if (v.done) break
            sentUrls.delete(v.value)
          }
        }
        window.postMessage({ type: 'M3U8_DETECTED', url: urlStr, format: fmt }, '*')
        return
      }
      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        try { urlStr = new URL(urlStr, location.href).toString() } catch { return }
      }
      // Bilibili video/audio tracks are obtained from playurl below. Do not
      // process every player/API request; only retain actual subtitle files.
      if (isBilibiliPage) {
        const subtitleFormat = getBilibiliSubtitleFormat(urlStr)
        if (subtitleFormat) send(urlStr, subtitleFormat)
        return
      }
      const fmt = getFormatFromUrl(urlStr)
      if (fmt) send(urlStr, fmt)
    } catch {}
  }

  // ────────────────────────────────────────────────────────────────────
  // MediaSource 代理（参照 cat-catch catch.js proxyMediaSourceMethods）
  // 拦截 addSourceBuffer + appendBuffer，把每路 MSE 数据流缓存在内存中，
  // endOfStream 时通知 popup 有可下载的 MSE 流（上报元数据，数据留在页面内存）。
  // 默认不激活，需收到 FLOWPICK_MSE_ENABLE 消息后才安装代理。
  // ────────────────────────────────────────────────────────────────────
  interface MseTrack {
    mimeType: string
    buffers: ArrayBuffer[]
    byteLength: number
  }
  interface MseCapture {
    captureId: string
    tracks: MseTrack[]
    totalBytes: number
    complete: boolean
    startedAt: number
    title: string
  }

  const mseCaptures = new Map<string, MseCapture>()
  const mseCaptureIds = new WeakMap<MediaSource, string>()
  let mseCaptureSeq = 0
  const MSE_SEGMENT_SIZE = 1024 * 1024 * 1024
  let mseProxyInstalled = false

  function formatBytes(b: number): string {
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB'
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB'
    return (b / 1024 / 1024 / 1024).toFixed(1) + 'GB'
  }

  function notifyMseUpdate(capture: MseCapture) {
    window.postMessage({
      type: 'MSE_STREAM_UPDATE',
      captureId: capture.captureId,
      title: capture.title,
      totalBytes: capture.totalBytes,
      trackCount: capture.tracks.length,
      complete: capture.complete,
    }, '*')
  }

  function installMseProxy() {
    if (mseProxyInstalled) return
    if (typeof MediaSource === 'undefined') return
    mseProxyInstalled = true

    const _addSourceBuffer = MediaSource.prototype.addSourceBuffer
    MediaSource.prototype.addSourceBuffer = new Proxy(_addSourceBuffer, {
      apply(target, ms: MediaSource, args: [string]) {
        const sourceBuffer = Reflect.apply(target, ms, args)
        try {
          let captureId = mseCaptureIds.get(ms)
          if (!captureId) {
            captureId = `mse-${++mseCaptureSeq}-${Date.now()}`
            mseCaptureIds.set(ms, captureId)
            const capture: MseCapture = {
              captureId,
              tracks: [],
              totalBytes: 0,
              complete: false,
              startedAt: Date.now(),
              title: document.title,
            }
            mseCaptures.set(captureId, capture)
            notifyMseUpdate(capture)
          }

          const capture = mseCaptures.get(captureId)!
          const mimeType = (args[0] || '').split(';')[0].trim()
          const track: MseTrack = { mimeType, buffers: [], byteLength: 0 }
          capture.tracks.push(track)

          sourceBuffer.appendBuffer = new Proxy(sourceBuffer.appendBuffer, {
            apply(abTarget, sb: SourceBuffer, abArgs: [BufferSource]) {
              Reflect.apply(abTarget, sb, abArgs)
              try {
                const buf = abArgs[0]
                if (!buf) return
                const srcArray = ArrayBuffer.isView(buf)
                  ? new Uint8Array((buf as ArrayBufferView).buffer as ArrayBuffer, (buf as ArrayBufferView).byteOffset, (buf as ArrayBufferView).byteLength)
                  : new Uint8Array(buf as ArrayBuffer)
                const copy = srcArray.slice(0).buffer as ArrayBuffer
                track.buffers.push(copy)
                track.byteLength += copy.byteLength
                capture.totalBytes += copy.byteLength

                clearTimeout((capture as any)._notifyTimer)
                ;(capture as any)._notifyTimer = setTimeout(() => notifyMseUpdate(capture), 800)

                if (capture.totalBytes >= MSE_SEGMENT_SIZE) {
                  window.postMessage({
                    type: 'MSE_STREAM_SEGMENT',
                    captureId,
                    title: capture.title,
                    totalBytes: capture.totalBytes,
                  }, '*')
                }
              } catch {}
            },
          })
        } catch {}
        return sourceBuffer
      },
    })

    const _endOfStream = MediaSource.prototype.endOfStream
    MediaSource.prototype.endOfStream = new Proxy(_endOfStream, {
      apply(target, ms: MediaSource, args: any[]) {
        Reflect.apply(target, ms, args)
        try {
          const captureId = mseCaptureIds.get(ms)
          if (!captureId) return
          const capture = mseCaptures.get(captureId)
          if (!capture) return
          capture.complete = true
          capture.title = document.title
          clearTimeout((capture as any)._notifyTimer)
          notifyMseUpdate(capture)
        } catch {}
      },
    })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return
    if (event.data.type === 'FLOWPICK_MSE_ENABLE') {
      installMseProxy()
    }
    if (event.data.type === 'FLOWPICK_DATA_IMAGES_ENABLE') {
      dataImagesEnabled = true
      dataImageMinBytes = Math.max(0, (event.data.minSizeKB ?? 50) * 1024)
      scanExistingDataImages()
    }
  })

  // 页面内通过 postMessage 处理下载请求
  // content.ts 收到用户点击「下载 MSE 流」后，向 injected 发 MSE_DOWNLOAD_REQUEST，
  // injected 把内存中的 ArrayBuffer 通过 transferable MessageChannel 传回。
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return
    if (event.data.type !== 'MSE_DOWNLOAD_REQUEST') return
    const { captureId } = event.data as { captureId: string }
    const port = event.ports?.[0]
    const capture = mseCaptures.get(captureId)
    if (!capture || !port) return
    try {
      // 序列化：把每条轨道的 buffers 数组及 mimeType 发给 content script
      const tracks = capture.tracks.map(t => ({
        mimeType: t.mimeType,
        buffers: t.buffers,
      }))
      // 收集所有 transferable buffers（零拷贝传输）
      const transferList: ArrayBuffer[] = []
      for (const t of tracks) {
        for (const b of t.buffers) transferList.push(b)
      }
      port.postMessage({ type: 'MSE_DOWNLOAD_DATA', captureId, title: capture.title, tracks }, transferList)
    } catch (e) {
      port.postMessage({ type: 'MSE_DOWNLOAD_ERROR', captureId, error: String(e) })
    }
  })

  // ── B站专属解析 ────────────────────────────────────────────────────
  // A page can request several playurl payloads at once: the current video,
  // episode switches and hover-card previews.  Some payloads omit `data.cid`,
  // so using location.pathname as their identity makes a preview overwrite the
  // current video's virtual DASH group.  Preserve the request URL and derive a
  // stable identity from its request data in that case.
  function getBilibiliTaskKey(data: any, sourceUrl?: string): string {
    const responseCid = data?.cid
    if (responseCid !== undefined && responseCid !== null && String(responseCid)) return String(responseCid)
    try {
      const params = new URL(sourceUrl || location.href, location.href).searchParams
      for (const name of ['cid', 'ep_id', 'aid', 'avid', 'bvid', 'season_id']) {
        const value = params.get(name)
        if (value) return `${name}_${value}`
      }
    } catch {}
    return location.pathname
  }

  function getBilibiliRequestCid(sourceUrl?: string): string | undefined {
    try {
      const cid = new URL(sourceUrl || '', location.href).searchParams.get('cid')
      return cid || undefined
    } catch {
      return undefined
    }
  }

  function parseBilibiliPlayurl(
    json: any,
    sourceUrl?: string,
    isPagePlayinfo = false,
    requestRouteKey?: string,
  ): void {
    try {
      // Do not reject a response merely because the route changed after its
      // request began. Bilibili commonly preloads the next main video before
      // pushState. Ownership is verified below using the current page CID.
      const data = json?.data ?? json?.result ?? json
      if (!data) return
      if (!isPagePlayinfo && !isBilibiliWatchPage()) return

      if (data.dash) {
        const videos: any[] = data.dash.video || []
        const audios: any[] = data.dash.audio || []
        const dolby = data.dash.dolby?.audio
        const flac = data.dash.flac?.audio

        const toUrl = (stream: any) => stream?.baseUrl || stream?.base_url || stream?.url
        const qualityName = (id: number) => ({ 16: '360P', 32: '480P', 64: '720P', 80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K' } as Record<number, string>)[id] || `${id}P`
        const audioStreams = [
          ...(Array.isArray(dolby) ? dolby.map((s: any) => ({ ...s, _label: '杜比全景声' })) : []),
          ...(flac ? [{ ...flac, _label: 'Hi-Res / FLAC' }] : []),
          ...audios.map((s: any) => ({ ...s, _label: `标准音质 ${s.id || ''}`.trim() })),
        ].filter((s: any) => !!toUrl(s))
        const codecName = (codecs: unknown): string => {
          const codec = String(codecs || '').toLowerCase()
          if (codec.startsWith('avc')) return 'H.264'
          if (codec.startsWith('hev') || codec.startsWith('hvc')) return 'H.265'
          if (codec.startsWith('av01')) return 'AV1'
          return codec ? codec.toUpperCase() : ''
        }
        // Keep the highest-bandwidth CDN representation for each quality and
        // codec, while preserving meaningful codec alternatives.
        const bestVideos = new Map<string, any>()
        for (const stream of videos.filter((s: any) => !!toUrl(s))) {
          const key = `${stream.id || 0}:${codecName(stream.codecs)}`
          const current = bestVideos.get(key)
          if (!current || Number(stream.bandwidth || 0) > Number(current.bandwidth || 0)) bestVideos.set(key, stream)
        }
        const videoStreams = [...bestVideos.values()].sort((a, b) =>
          Number(b.id || 0) - Number(a.id || 0) || Number(b.bandwidth || 0) - Number(a.bandwidth || 0))
        if (!videoStreams.length) return

        // __playinfo__ usually contains DASH tracks but not its own cid.  The
        // page state is the authoritative identity in that case; falling back
        // to pathname causes the first page's group to be delayed or merged
        // with a later SPA navigation.
        const pageCid = isPagePlayinfo ? getBilibiliPageCid() : undefined
        const requestCid = isPagePlayinfo ? undefined : getBilibiliRequestCid(sourceUrl)
        const responseCid = requestCid || (data?.cid !== undefined && data?.cid !== null ? String(data.cid) : undefined)
        // A page snapshot without a cid has no reliable ownership yet.  Do
        // not turn it into a pathname-keyed group that later duplicates the
        // same video when its real playurl response arrives.
        if (isPagePlayinfo && !pageCid) return
        let taskKey = pageCid || responseCid || getBilibiliTaskKey(data, sourceUrl)
        if (isPagePlayinfo) {
          if (hasBilibiliSpaNavigated) return
          // On a route/P switch the old __playinfo__ survives briefly.  It
          // has no independent cid, so only the real playurl?cid= response
          // may confirm the newly selected item.
          if (awaitingBilibiliPageInfo) return
          primaryBilibiliTaskKey = taskKey
          awaitingBilibiliPageInfo = false
        } else {
          const currentCid = getBilibiliPageCid()
          // A current-page playurl carries its cid in the request URL. It is
          // authoritative for a part switch and must replace the old primary
          // before its duration/variants are stored.
          if (responseCid && currentCid && responseCid === currentCid) {
            taskKey = currentCid
            primaryBilibiliTaskKey = currentCid
            awaitingBilibiliPageInfo = false
          } else if (!primaryBilibiliTaskKey) {
            // A playurl must identify the video currently mounted in the
            // player.  Never use the first request after navigation: Bilibili
            // eagerly fetches recommendation hover previews on the same page.
            rememberPendingBilibiliPlayurl(json, sourceUrl, getBilibiliRouteKey(), taskKey)
            return
          } else if (primaryBilibiliTaskKey !== taskKey) {
            // This may be a hover preview, or a real response that won the
            // race against the SPA state update.  Queue it briefly; a matching
            // new page cid will promote it, otherwise it is discarded.
            rememberPendingBilibiliPlayurl(json, sourceUrl, getBilibiliRouteKey(), taskKey)
            return
          }
        }
        const routeMeta = bilibiliRouteMeta.get(getBilibiliRouteKey())
        const responseDuration = Number(data.timelength || data.dash?.duration || 0) / (data.timelength ? 1000 : 1) || undefined
        const duration = routeMeta?.duration || responseDuration
        // A Bilibili page can first expose a partial/stale playinfo and then
        // return the same tracks with the correct duration.  Duration belongs
        // in the signature so the later authoritative response updates it.
        const taskSignature = `${taskKey}:${Math.round((duration || 0) * 1000)}:${videoStreams.map((s: any) => toUrl(s)).join('|')}`
        if (sentBilibiliTasks.has(taskSignature)) return
        sentBilibiliTasks.add(taskSignature)
        if (sentBilibiliTasks.size > 100) sentBilibiliTasks.clear()
        window.postMessage({
          type: 'BILIBILI_DASH_DETECTED',
          task: {
            key: taskKey,
            referer: location.href,
            duration,
            coverUrl: routeMeta?.coverUrl
              || document.querySelector('meta[property="og:image"]')?.getAttribute('content')
              || document.querySelector('meta[itemprop="image"]')?.getAttribute('content')
              || undefined,
            title: routeMeta?.title
              || document.title.replace(/_哔哩哔哩.*$/i, '').trim()
              || document.title,
            videos: videoStreams.map((s: any) => ({
              url: toUrl(s),
              label: [qualityName(Number(s.id || 0)), codecName(s.codecs)].filter(Boolean).join(' · '),
              bandwidth: Number(s.bandwidth || 0),
              width: Number(s.width || 0) || undefined,
              height: Number(s.height || 0) || undefined,
            })),
            audios: audioStreams.map((s: any) => ({
              url: toUrl(s),
              label: s._label || '音频',
              bandwidth: Number(s.bandwidth || 0),
            })),
          },
        }, '*')
        return
      }

      if (data.durl && Array.isArray(data.durl)) {
        for (const seg of data.durl) {
          const url = seg.url || seg.play_url
          if (url) send(url, url.includes('.flv') ? 'flv' : 'mp4')
          if (seg.backup_url) {
            for (const u of (Array.isArray(seg.backup_url) ? seg.backup_url : [seg.backup_url])) {
              if (u) send(u, u.includes('.flv') ? 'flv' : 'mp4')
            }
          }
        }
      }
    } catch (e) {
      console.warn('[FlowPick] parseBilibiliPlayurl error', e)
    }
  }

  function asHttpUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return undefined
    try {
      const url = new URL(value, location.href)
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
    } catch {
      return undefined
    }
  }

  function readUrlList(value: any): string[] {
    const urls: string[] = []
    const visit = (node: any, depth = 0) => {
      if (depth > 3 || !node) return
      const direct = asHttpUrl(node)
      if (direct) { if (!urls.includes(direct)) urls.push(direct); return }
      if (Array.isArray(node)) { node.forEach(child => visit(child, depth + 1)); return }
      if (typeof node === 'object') {
        for (const key of ['url_list', 'urlList', 'url', 'src', 'play_url', 'playUrl']) visit(node[key], depth + 1)
      }
    }
    visit(value)
    return urls
  }

  /** Extract the player-owned tracks from Douyin's detail/feed response. */
  function parseDouyinAwemeResponse(json: any, sourceUrl?: string): void {
    try {
      const data = json?.data ?? json
      const aweme = data?.aweme_detail || data?.aweme || data?.item_list?.[0] || data?.aweme_list?.[0]
      const video = aweme?.video
      if (!aweme || !video) return
      const candidates: Array<any> = []
      const add = (address: any, stream: any, role: 'video' | 'audio') => {
        for (const url of readUrlList(address)) {
          if (candidates.some(item => item.url === url)) continue
          candidates.push({
            url,
            format: /\.m3u8(?:[?#]|$)/i.test(url) ? 'm3u8' : /\.mpd(?:[?#]|$)/i.test(url) ? 'mpd' : 'mp4',
            role,
            label: stream?.gear_name || stream?.quality || (stream?.height ? `${stream.height}p` : role === 'audio' ? '音频' : '视频'),
            width: Number(stream?.width || 0) || undefined,
            height: Number(stream?.height || 0) || undefined,
            bandwidth: Number(stream?.bit_rate || stream?.bitrate || 0) || undefined,
          })
        }
      }
      const bitrates = Array.isArray(video.bit_rate) ? video.bit_rate : Array.isArray(video.bitRate) ? video.bitRate : []
      for (const stream of bitrates) add(stream?.play_addr || stream?.playAddr || stream, stream, 'video')
      add(video.play_addr || video.playAddr || video.play_url || video.playUrl, video, 'video')

      // Only consume audio explicitly attached to the video object. Music is
      // deliberately excluded: it is often a separately played background song.
      const audioTracks = [video.audio, video.audio_track, video.audioTrack, aweme.audio]
      for (const track of audioTracks) {
        for (const stream of Array.isArray(track) ? track : [track]) {
          add(stream?.play_addr || stream?.playAddr || stream?.audio_url || stream?.url_list || stream, stream, 'audio')
        }
      }
      const videos = candidates.filter(item => item.role === 'video')
      if (!videos.length) return
      const key = String(aweme.aweme_id || aweme.id || new URL(sourceUrl || location.href, location.href).pathname)
      const durationRaw = Number(video.duration || aweme.duration || 0)
      const duration = durationRaw > 1_000 ? durationRaw / 1_000 : durationRaw || undefined
      const cover = readUrlList(video.cover || video.origin_cover || aweme.cover)[0]
      const signature = `${key}:${candidates.map(item => item.url).join('|')}`
      if (sentPlatformTasks.has(signature)) return
      sentPlatformTasks.add(signature)
      if (sentPlatformTasks.size > 100) sentPlatformTasks.clear()
      window.postMessage({
        type: 'PLATFORM_MEDIA_DETECTED',
        task: {
          provider: 'douyin', key, referer: location.href, duration, priority: 2,
          title: String(aweme.desc || document.title || '').trim() || undefined,
          coverUrl: cover,
          candidates,
        },
      }, '*')
    } catch {}
  }

  function isDouyinMediaApi(url: string): boolean {
    try {
      const parsed = new URL(url, location.href)
      return /(^|\.)(douyin\.com|iesdouyin\.com)$/i.test(parsed.hostname)
        && /\/aweme\/.*(?:detail|feed|post|recommend|item)/i.test(parsed.pathname)
    } catch { return false }
  }


  // ── 拦截 XHR 响应体 ────────────────────────────────────────────────
  const originalXHROpen = XMLHttpRequest.prototype.open
  const originalXHRSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    ;(this as any)._fpUrl = typeof url === 'string' ? url : url.toString()
    // Save the route at request creation, rather than looking at location when
    // the async response arrives.
    ;(this as any)._fpBilibiliRouteKey = getBilibiliRouteKey()
    tryDetect(url)
    return originalXHROpen.apply(this, [method, url, ...rest] as any)
  }

  XMLHttpRequest.prototype.send = function (...args: any[]) {
    const fpUrl: string = (this as any)._fpUrl || ''
    const fpBilibiliRouteKey: string = (this as any)._fpBilibiliRouteKey || getBilibiliRouteKey()
    this.addEventListener('load', function (this: XMLHttpRequest) {
      try {
        if (this.status < 200 || this.status >= 300) return
        const urlLower = fpUrl.toLowerCase()

        if (urlLower.includes('bilibili.com') && (
          urlLower.includes('/x/player/playurl') ||
          urlLower.includes('/pgc/player/web/playurl') ||
          urlLower.includes('/playurl')
        )) {
          parseBilibiliPlayurl(JSON.parse(this.responseText), fpUrl, false, fpBilibiliRouteKey)
          return
        }

        if (isDouyinMediaApi(fpUrl)) {
          parseDouyinAwemeResponse(JSON.parse(this.responseText), fpUrl)
          return
        }

        // YouTube player-response parsing is intentionally disabled.
      } catch {}
    })
    return originalXHRSend.apply(this, args as [body?: Document | XMLHttpRequestBodyInit | null])
  }

  // ── 拦截 fetch 响应体 ──────────────────────────────────────────────
  const originalFetch = window.fetch
  window.fetch = function (...args: Parameters<typeof fetch>) {
    let urlStr = ''
    const requestRouteKey = getBilibiliRouteKey()
    try {
      const input = args[0]
      if (typeof input === 'string') urlStr = input
      else if (input instanceof URL) urlStr = input.toString()
      else if (input instanceof Request) urlStr = input.url
      tryDetect(urlStr)
    } catch {}

    const promise = originalFetch.apply(this, args)
    try {
      const urlLower = urlStr.toLowerCase()
      const isBiliPlayurl = urlLower.includes('bilibili.com') && (
        urlLower.includes('/x/player/playurl') ||
        urlLower.includes('/pgc/player/web/playurl') ||
        urlLower.includes('/playurl')
      )
      if (isBiliPlayurl) {
        return promise.then(async (response) => {
          if (!response.ok) return response
          try {
            const clone = response.clone()
            const json = await clone.json()
            parseBilibiliPlayurl(json, urlStr, false, requestRouteKey)
          } catch {}
          return response
        })
      }
      if (isDouyinMediaApi(urlStr)) {
        return promise.then(async (response) => {
          if (!response.ok) return response
          try { parseDouyinAwemeResponse(await response.clone().json(), urlStr) } catch {}
          return response
        })
      }
    } catch {}

    return promise
  }

  // ── 读取 B站页面内嵌变量 __playinfo__ ─────────────────────────────
  function tryReadBiliPagePlayinfo(expectedRouteKey = getBilibiliRouteKey()) {
    try {
      if (!location.hostname.toLowerCase().includes('bilibili.com')) return
      if (!isBilibiliWatchPage()) return
      if (expectedRouteKey !== getBilibiliRouteKey()) return
      const playinfo = (window as any).__playinfo__
      if (playinfo) parseBilibiliPlayurl(playinfo, undefined, true, expectedRouteKey)
    } catch {}
  }


  // ── 监听 <video>/<audio> src 全局代理 ─────────────────────────────
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  if (srcDescriptor?.set) {
    const origSrcSet = srcDescriptor.set
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      set(value: string) {
        try {
          if (typeof value === 'string' && !value.startsWith('blob:') && !value.startsWith('data:')) {
            tryDetect(value)
          }
        } catch {}
        origSrcSet.call(this, value)
      },
      get: srcDescriptor.get,
      configurable: true,
      enumerable: true,
    })
  }

  // ── iframe sandbox 清除工具函数 ───────────────────────────────────
  function clearIframeSandbox(iframe: HTMLIFrameElement) {
    try {
      const cloned = iframe.cloneNode(true) as HTMLIFrameElement
      cloned.removeAttribute('sandbox')
      iframe.parentNode?.replaceChild(cloned, iframe)
    } catch {}
  }

  // 代理 setAttribute，拦截动态写入 sandbox 属性（insert 前设置的场景）
  const _origSetAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (name.toLowerCase() === 'sandbox' && this.nodeName === 'IFRAME') {
      return
    }
    return _origSetAttribute.call(this, name, value)
  }

  // ── 监听 <source> 标签插入 + iframe sandbox 清除 ──────────────────
  const domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLIFrameElement) {
        if (mutation.attributeName === 'sandbox' && mutation.target.hasAttribute('sandbox')) {
          clearIframeSandbox(mutation.target)
        }
        continue
      }

      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue

        if (node.nodeName === 'IFRAME' && (node as HTMLIFrameElement).hasAttribute('sandbox')) {
          clearIframeSandbox(node as HTMLIFrameElement)
        } else {
          node.querySelectorAll?.('iframe[sandbox]').forEach(iframe => {
            clearIframeSandbox(iframe as HTMLIFrameElement)
          })
        }

        // <source>/<video>/<audio> src 检测
        const sources = node.nodeName === 'SOURCE'
          ? [node as HTMLSourceElement]
          : Array.from(node.querySelectorAll?.('source, video, audio') ?? [])
        for (const el of sources) {
          const src = (el as HTMLSourceElement | HTMLMediaElement).src || (el as HTMLSourceElement).getAttribute?.('src')
          if (src && !src.startsWith('blob:') && !src.startsWith('data:')) tryDetect(src)
        }
        // data: 内嵌图片（开关开启时才扫描 <img>，避免性能开销）
        if (dataImagesEnabled) {
          const imgs = node.nodeName === 'IMG' && (node as HTMLImageElement).src?.startsWith('data:')
            ? [node as HTMLImageElement]
            : Array.from(node.querySelectorAll?.('img[src^="data:image/"]') ?? [])
          const MAX = 100 // 单次 mutation 最多处理 100 个，避免无限滚动卡顿
          let n = 0
          for (const img of imgs) {
            if (n++ >= MAX) break
            const src = img.getAttribute('src') || ''
            if (src.startsWith('data:')) tryDetect(src)
          }
        }
      }
    }
  })
  try {
    domObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['sandbox'],
    })
  } catch {}

  // ── 页面扫描 ──────────────────────────────────────────────────────
  function scanExistingMedia() {
    document.querySelectorAll('video[src], audio[src], source[src]').forEach(el => {
      const src = (el as HTMLMediaElement | HTMLSourceElement).src || el.getAttribute('src')
      if (src && !src.startsWith('blob:') && !src.startsWith('data:')) tryDetect(src)
    })
    document.querySelectorAll<HTMLIFrameElement>('iframe[sandbox]').forEach(iframe => {
      clearIframeSandbox(iframe)
    })
    tryReadBiliPagePlayinfo()
    // YouTube's ytInitialPlayerResponse is intentionally not parsed.
    // data: 图片扫描（开关开启时才扫，由消息回调或主动请求触发）
    scanExistingDataImages()
  }

  // 扫描已存在的 <img src="data:image/...">（开关开启时调用）
  function scanExistingDataImages() {
    if (!dataImagesEnabled) return
    // 限制扫描范围，避免在超大 DOM 上卡顿
    const imgs = document.querySelectorAll<HTMLImageElement>('img[src^="data:image/"]')
    const MAX = 500
    let count = 0
    imgs.forEach(img => {
      if (count++ >= MAX) return
      const src = img.getAttribute('src') || ''
      if (src.startsWith('data:')) tryDetect(src)
    })
  }

  // Bilibili uses SPA navigation for related videos, episodes and playlist
  // items. The injected script survives that navigation, so the previous
  // page's primary cid must not keep filtering the new video's playurl.
  let lastBilibiliPageUrl = getBilibiliRouteKey()
  let lastBilibiliPageCid = getBilibiliPageCid()
  function refreshBilibiliPrimaryAfterNavigation() {
    if (!isBilibiliPage) return
    const currentCid = getBilibiliPageCid()
    const currentRouteKey = getBilibiliRouteKey()
    // Bilibili may populate __INITIAL_STATE__ after this script is injected.
    // Treat that first cid as initial hydration, not a navigation; otherwise
    // recommendation previews can become the temporary primary stream.
    if (currentRouteKey === lastBilibiliPageUrl) {
      if (!currentCid || currentCid === lastBilibiliPageCid) return
      if (!lastBilibiliPageCid) {
        lastBilibiliPageCid = currentCid
        return
      }
    }
    hasBilibiliSpaNavigated = true
    lastBilibiliPageUrl = currentRouteKey
    lastBilibiliPageCid = currentCid
    primaryBilibiliTaskKey = undefined
    awaitingBilibiliPageInfo = true
    const routeKey = getBilibiliRouteKey()
    void resolveBilibiliRouteCid(routeKey)
    // __playinfo__ is replaced asynchronously by Bilibili's router.
    setTimeout(() => tryReadBiliPagePlayinfo(routeKey), 80)
    setTimeout(() => tryReadBiliPagePlayinfo(routeKey), 400)
    setTimeout(() => tryReadBiliPagePlayinfo(routeKey), 1000)
    setTimeout(() => tryReadBiliPagePlayinfo(routeKey), 1800)
    setTimeout(flushPendingBilibiliPlayurls, 0)
  }
  const originalPushState = history.pushState
  history.pushState = function (...args: Parameters<History['pushState']>) {
    const result = originalPushState.apply(this, args)
    refreshBilibiliPrimaryAfterNavigation()
    return result
  }
  const originalReplaceState = history.replaceState
  history.replaceState = function (...args: Parameters<History['replaceState']>) {
    const result = originalReplaceState.apply(this, args)
    refreshBilibiliPrimaryAfterNavigation()
    return result
  }
  window.addEventListener('popstate', refreshBilibiliPrimaryAfterNavigation)
  // Autoplay does not always go through the page's wrapped History methods.
  // This lightweight Bilibili-only guard still resets the primary on such
  // route transitions; it does not inspect or intercept media requests.
  if (isBilibiliPage) {
    // On first load, __playinfo__ may be filled after this injected script.
    // Polling the small in-page object is cheap and lets the page snapshot
    // establish the primary before any preview playurl can be considered.
    setTimeout(tryReadBiliPagePlayinfo, 80)
    setTimeout(tryReadBiliPagePlayinfo, 300)
    setTimeout(tryReadBiliPagePlayinfo, 800)
    void resolveBilibiliRouteCid()
    setInterval(() => {
      refreshBilibiliPrimaryAfterNavigation()
      flushPendingBilibiliPlayurls()
      tryReadBiliPagePlayinfo()
    }, 500)
  }

  // injected 脚本异步加载，content 发的 FLOWPICK_DATA_IMAGES_ENABLE 可能早于
  // 监听器注册就到达而丢失。主动请求一次设置，content 收到后补发。
  window.postMessage({ type: 'FLOWPICK_REQUEST_SETTINGS' }, '*')

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanExistingMedia, { once: true })
  } else {
    scanExistingMedia()
  }
})
