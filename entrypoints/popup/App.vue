<script lang="ts" setup>
  import Hls from 'hls.js'
  import * as dashjs from 'dashjs'
  import { loadSettings, saveSettings, DEFAULT_SETTINGS, type Settings, type SniffingGroup } from '../../utils/settings'

  type View = 'list' | 'settings'

  interface MediaItem {
    url: string
    format: string
    size?: number
    width?: number
    height?: number
    duration?: number
  }

  function itemToMediaItem(item: any): MediaItem {
    if (typeof item === 'string') {
      return { url: item, format: 'm3u8' }
    } else if (item && typeof item === 'object') {
      return {
        url: item.url || '',
        format: item.format || 'm3u8',
        size: typeof item.size === 'number' ? item.size : undefined,
        width: typeof item.width === 'number' ? item.width : undefined,
        height: typeof item.height === 'number' ? item.height : undefined
      }
    }
    return { url: '', format: 'm3u8' }
  }

  function formatFileSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return ''
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    const value = bytes / Math.pow(1024, i)
    return value % 1 === 0 ? `${value} ${units[i]}` : `${value.toFixed(1)} ${units[i]}`
  }

  // ── List view state ──────────────────────────────────────────────
  const view = ref<View>('list')
  const showMore = ref(false)
  const showToast = ref(false)
  const toastMessage = ref('')
  const mediaList = ref<MediaItem[]>([])
  const activeTab = ref<'all' | 'stream' | 'video' | 'audio' | 'image'>('all')

  const STREAM_FORMATS = ['m3u8', 'mpd']
  const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv']
  const AUDIO_FORMATS = ['mp3', 'm4a', 'oga', 'weba', 'wav', 'flac', 'aac', 'ogg']
  const IMAGE_FORMATS = ['gif', 'jpg', 'jpeg', 'png', 'webp', 'svg', 'bmp', 'ico']

  const getMediaType = (format: string): 'stream' | 'video' | 'audio' | 'image' | 'other' => {
    const f = format.toLowerCase()
    if (STREAM_FORMATS.includes(f)) return 'stream'
    if (VIDEO_FORMATS.includes(f)) return 'video'
    if (AUDIO_FORMATS.includes(f)) return 'audio'
    if (IMAGE_FORMATS.includes(f)) return 'image'
    return 'other'
  }
  const playingId = ref<number | null>(null)
  const audioPlayingId = ref<number | null>(null)
  const hlsInstances = ref<Map<number, Hls>>(new Map())
  const dashInstances = ref<Map<number, dashjs.MediaPlayerClass>>(new Map())
  const listLoaded = ref(false)
  const selectedItems = ref<Set<number>>(new Set())
  const imageLoadStatus = ref<Map<string, boolean>>(new Map())
  const previewImageUrl = ref('')
  const showFilter = ref(false)
  const sizeFilter = ref<{ min: number; max: number }>({ min: 0, max: 0 })
  const dimensionFilter = ref<{ minWidth: number; minHeight: number }>({ minWidth: 0, minHeight: 0 })
  const typeFilter = ref<string>('any')
  const resolutionFilter = ref<string>('any')
  const videoDimensionCache = ref<Map<string, { width: number; height: number }>>(new Map())
  const audioDurationCache = ref<Map<string, number>>(new Map())

  interface AudioPlayerState {
    audioCtx: AudioContext
    analyser: AnalyserNode
    source: MediaElementAudioSourceNode
    animFrameId: number
  }
  const audioPlayers = new Map<number, AudioPlayerState>()
  let currentTabId: number | undefined
  let currentTabTitle = ''
  const version = browser.runtime.getManifest().version

  // ── Settings view state ──────────────────────────────────────────
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, sniffingRules: { ...DEFAULT_SETTINGS.sniffingRules } })
  const settingsSaved = ref(false)
  const excludeDomainsText = ref('')
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let textSaveTimer: ReturnType<typeof setTimeout> | null = null
  const resetConfirm = ref(false)
  let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null
  
  const SNIFFING_ROWS: { key: SniffingGroup; label: string; icon: string }[] = [
    { key: 'streaming', label: 'Streaming (HLS/MPD)', icon: '📡' },
    { key: 'video',     label: 'Video',     icon: '🎬' },
    { key: 'audio',     label: 'Audio',     icon: '🎵' },
    { key: 'image',     label: 'Image',     icon: '🖼️' },
  ]

  // ── Computed ─────────────────────────────────────────────────────
  const tabCounts = computed(() => {
    const counts = { all: mediaList.value.length, stream: 0, video: 0, audio: 0, image: 0 }
    mediaList.value.forEach(item => {
      const type = getMediaType(item.format)
      if (type === 'stream') counts.stream++
      else if (type === 'video') counts.video++
      else if (type === 'audio') counts.audio++
      else if (type === 'image') counts.image++
    })
    return counts
  })

  const typeOptions = computed(() => {
    const formatCounts: Record<string, number> = {}
    const tabMedia = activeTab.value === 'all' 
      ? mediaList.value 
      : mediaList.value.filter(i => getMediaType(i.format) === activeTab.value)
    
    tabMedia.forEach(item => {
      const fmt = item.format.toLowerCase()
      formatCounts[fmt] = (formatCounts[fmt] || 0) + 1
    })

    let allFormats: string[] = []
    if (activeTab.value === 'all') {
      allFormats = [...STREAM_FORMATS, ...VIDEO_FORMATS, ...AUDIO_FORMATS, ...IMAGE_FORMATS]
    } else if (activeTab.value === 'stream') {
      allFormats = [...STREAM_FORMATS]
    } else if (activeTab.value === 'video') {
      allFormats = [...VIDEO_FORMATS]
    } else if (activeTab.value === 'audio') {
      allFormats = [...AUDIO_FORMATS]
    } else if (activeTab.value === 'image') {
      allFormats = [...IMAGE_FORMATS]
    }

    const uniqueFormats = [...new Set(allFormats)]
    
    const options = uniqueFormats.map(format => ({
      value: format,
      label: getFormatLabel(format),
      count: formatCounts[format] || 0,
      disabled: !formatCounts[format]
    }))
    
    options.sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1
      return b.count - a.count
    })
    
    return options
  })

  const filteredMediaList = computed(() => {
    let list = mediaList.value
    if (activeTab.value !== 'all') {
      list = list.filter(i => getMediaType(i.format) === activeTab.value)
    }
    if (typeFilter.value !== 'any') {
      list = list.filter(i => i.format.toLowerCase() === typeFilter.value)
    }
    list = list.filter(item => {
      if (sizeFilter.value.min > 0 && (item.size ?? 0) < sizeFilter.value.min * 1024) return false
      if (sizeFilter.value.max > 0 && (item.size ?? 0) > sizeFilter.value.max * 1024) return false
      if (activeTab.value === 'image') {
        if (dimensionFilter.value.minWidth > 0 && (item.width ?? 0) < dimensionFilter.value.minWidth) return false
        if (dimensionFilter.value.minHeight > 0 && (item.height ?? 0) < dimensionFilter.value.minHeight) return false
      }
      if (activeTab.value === 'video' && resolutionFilter.value !== 'any') {
        const h = Math.min(item.width ?? 0, item.height ?? 0)
        switch (resolutionFilter.value) {
          case '8k': if (h < 4320) return false; break
          case '4k': if (h < 2160) return false; break
          case '1080p': if (h < 1080) return false; break
          case '720p': if (h < 720) return false; break
          case '480p': if (h < 480) return false; break
          case '360p': if (h < 360) return false; break
          case 'sd': if (h >= 360) return false; break
        }
      }
      return true
    })
    return list
  })

  // ── Lifecycle ────────────────────────────────────────────────────
  onMounted(async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    currentTabId = tabs[0]?.id
    currentTabTitle = tabs[0]?.title || ''
    if (currentTabId === undefined) return
    const list = (await browser.runtime.sendMessage({ type: 'GET_LIST', tabId: currentTabId })) as Array<{url: string, format: string}> | undefined
    mediaList.value = (list ?? []).map(itemToMediaItem)
    listLoaded.value = true
    browser.runtime.onMessage.addListener(onMessage)

    const s = await loadSettings()
    settings.value = s
    excludeDomainsText.value = s.excludeDomains.join('\n')

    fetchAllVideoDimensions()
    fetchAllAudioDurations()
  })

  onUnmounted(() => {
    browser.runtime.onMessage.removeListener(onMessage)
    hlsInstances.value.forEach(hls => hls.destroy())
    hlsInstances.value.clear()
    dashInstances.value.forEach(dash => dash.destroy())
    dashInstances.value.clear()
    audioPlayers.forEach((_, index) => stopAudioPlayback(index))
    audioPlayers.clear()
    if (saveTimer) clearTimeout(saveTimer)
    if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
    if (textSaveTimer) clearTimeout(textSaveTimer)
  })

  // ── Message handler ───────────────────────────────────────────────
  function onMessage(msg: { type: string; tabId?: number; list?: Array<{url: string, format: string, size?: number}> }) {
    if (msg.type === 'LIST_UPDATED' && msg.tabId === currentTabId && msg.list) {
      mediaList.value = msg.list.map(itemToMediaItem)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────
  const getFileName = (url: string): string => {
    try {
      const pathname = new URL(url).pathname
      return pathname.split('/').pop() || url
    } catch {
      return url.split('/').pop() || url
    }
  }

  const ensureFileExtension = (filename: string, format: string): string => {
    const ext = format.toLowerCase()
    if (filename.toLowerCase().endsWith(`.${ext}`)) return filename
    const lastDot = filename.lastIndexOf('.')
    if (lastDot > 0) {
      const existingExt = filename.slice(lastDot + 1).toLowerCase()
      if (existingExt === ext) return filename
    }
    return `${filename}.${ext}`
  }

  const getDownloadFilename = (url: string, format: string): string => {
    const filename = getFileName(url)
    return ensureFileExtension(filename, format)
  }

  const sanitizeDirectoryName = (name: string): string => {
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/g
    let sanitized = name.replace(invalidChars, '_')
    sanitized = sanitized.replace(/[\s.]+$/g, '').replace(/^[.\s]+/g, '')
    sanitized = sanitized.replace(/\.{2,}/g, '_')
    if (sanitized.length === 0) sanitized = 'download'
    if (sanitized.length > 100) sanitized = sanitized.slice(0, 100)
    return sanitized
  }

  const getBatchDownloadFilename = (url: string, format: string, subDir: string): string => {
    const filename = getDownloadFilename(url, format)
    return subDir ? `${subDir}/${filename}` : filename
  }

  const getFormatLabel = (format: string): string => {
    if (!format) return browser.i18n.getMessage('unknown')
    const map: Record<string, string> = {
      m3u8: 'HLS', mpd: 'DASH', mp4: 'MP4', mp3: 'MP3', webm: 'WebM', m4a: 'M4A',
      oga: 'OGA', weba: 'WEBA', wav: 'WAV', flac: 'FLAC', aac: 'AAC',
      gif: 'GIF', jpg: 'JPG', png: 'PNG', webp: 'WebP', svg: 'SVG',
    }
    return map[format.toLowerCase()] || format.toUpperCase()
  }

  const getFormatColor = (format: string): string => {
    if (!format) return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
    const map: Record<string, string> = {
      m3u8: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
      mpd: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      mp4: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      mp3: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      webm: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      m4a: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
      oga: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-300',
      weba: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
      wav: 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
      flac: 'bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300',
      aac: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
      gif: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
      jpg: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      png: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      webp: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
      svg: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
    }
    return map[format.toLowerCase()] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }

  const getResolutionLabel = (
    width?: number,
    height?: number
  ): string | null => {

    if (!width || !height) return null

    const h = Math.min(width, height)

    if (h >= 4320) return '8K'
    if (h >= 2160) return '4K'
    if (h >= 1080) return '1080P'
    if (h >= 720) return '720P'
    if (h >= 480) return '480P'
    if (h >= 360) return '360P'
    return 'SD'
  }

  const getResolutionColor = (width?: number, height?: number): string => {
    if (!width || !height) return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
    const max = Math.max(width, height)
    if (max >= 2560) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'
    if (max >= 1920) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
    return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  }

  const getSizeColor = (): string => {
    return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  }

  const isStreamFormat = (f: string) => STREAM_FORMATS.includes(f.toLowerCase())
  const isVideoFormat = (f: string) => VIDEO_FORMATS.includes(f.toLowerCase())
  const isImageFormat = (f: string) => IMAGE_FORMATS.includes(f.toLowerCase())
  const isAudioFormat = (f: string) => AUDIO_FORMATS.includes(f.toLowerCase())

  const fetchVideoDimensions = async (url: string): Promise<{ width: number; height: number } | null> => {
    if (videoDimensionCache.value.has(url)) {
      return videoDimensionCache.value.get(url)!
    }
    
    try {
      const dimensions = await browser.runtime.sendMessage({ type: 'GET_VIDEO_DIMENSIONS', url })
      if (dimensions) {
        videoDimensionCache.value.set(url, dimensions)
        return dimensions
      }
    } catch (e) {
      console.warn('Failed to fetch video dimensions:', e)
    }
    return null
  }

  const fetchAllVideoDimensions = async () => {
    const videoItems = mediaList.value.filter(item => isVideoFormat(item.format))
    for (const item of videoItems) {
      if (!item.width || !item.height || !item.duration) {
        const info = await browser.runtime.sendMessage({ type: 'GET_MEDIA_INFO', url: item.url })
        if (info) {
          if (info.width && info.height) {
            item.width = info.width
            item.height = info.height
          }
          if (info.duration) {
            item.duration = info.duration
          }
        }
      }
    }
  }

  const fetchAudioDuration = async (url: string): Promise<number | null> => {
    if (audioDurationCache.value.has(url)) {
      return audioDurationCache.value.get(url)!
    }
    
    try {
      const result = await browser.runtime.sendMessage({ type: 'GET_AUDIO_DURATION', url })
      if (result?.duration) {
        audioDurationCache.value.set(url, result.duration)
        return result.duration
      }
    } catch (e) {
      console.warn('Failed to fetch audio duration:', e)
    }
    return null
  }

  const fetchAllAudioDurations = async () => {
    const audioItems = mediaList.value.filter(item => isAudioFormat(item.format))
    for (const item of audioItems) {
      if (!item.duration) {
        const duration = await fetchAudioDuration(item.url)
        if (duration) {
          item.duration = duration
        }
      }
    }
  }

  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    }
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const showToastMsg = (msg: string) => {
    toastMessage.value = msg
    showToast.value = true
    setTimeout(() => { showToast.value = false }, 2000)
  }

  // ── Audio ─────────────────────────────────────────────────────────
  const stopAudioPlayback = (index: number) => {
    const state = audioPlayers.get(index)
    if (state) {
      cancelAnimationFrame(state.animFrameId)
      const audioEl = document.getElementById(`audio-player-${index}`) as HTMLAudioElement | null
      if (audioEl) { audioEl.pause(); audioEl.src = '' }
      state.source.disconnect()
      state.analyser.disconnect()
      state.audioCtx.close()
      audioPlayers.delete(index)
    }
    if (audioPlayingId.value === index) audioPlayingId.value = null
  }

  const supportsRoundRect = typeof CanvasRenderingContext2D !== 'undefined' && typeof CanvasRenderingContext2D.prototype.roundRect === 'function'

  const drawSpectrum = (index: number, analyser: AnalyserNode) => {
    const canvas = document.getElementById(`spectrum-${index}`) as HTMLCanvasElement | null
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    const draw = () => {
      const state = audioPlayers.get(index)
      if (!state) return
      state.animFrameId = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)
      const W = canvas.width, H = canvas.height
      ctx.clearRect(0, 0, W, H)
      const barCount = 60
      const barWidth = (W / barCount) * 0.7
      const gap = (W / barCount) * 0.3
      const step = Math.floor(bufferLength / barCount)
      for (let i = 0; i < barCount; i++) {
        const value = dataArray[i * step] / 255
        const barHeight = value * H
        ctx.fillStyle = `hsla(${200 + value * 60}, 80%, 55%, 0.9)`
        const x = i * (barWidth + gap)
        ctx.beginPath()
        ctx.roundRect(x, H - barHeight, barWidth, barHeight, 2)
        ctx.fill()
      }
    }
    draw()
  }

  const startAudioPlayback = async (index: number) => {
    await nextTick()
    const audioEl = document.getElementById(`audio-player-${index}`) as HTMLAudioElement | null
    if (!audioEl) return
    try {
      const audioCtx = new AudioContext()
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      const source = audioCtx.createMediaElementSource(audioEl)
      if (supportsRoundRect) {
        source.connect(analyser)
        analyser.connect(audioCtx.destination)
        audioPlayers.set(index, { audioCtx, analyser, source, animFrameId: 0 })
        audioEl.play().catch(() => {})
        drawSpectrum(index, analyser)
      } else {
        source.connect(audioCtx.destination)
        audioPlayers.set(index, { audioCtx, analyser, source, animFrameId: 0 })
        audioEl.play().catch(() => {})
      }
    } catch {
      showToastMsg(browser.i18n.getMessage('audioPlayError'))
    }
  }

  watch(activeTab, () => {
    showFilter.value = false
    typeFilter.value = 'any'
    sizeFilter.value = { min: 0, max: 0 }
    dimensionFilter.value = { minWidth: 0, minHeight: 0 }
    resolutionFilter.value = 'any'
    selectedItems.value.clear()
  })

  watch(audioPlayingId, async (newId, oldId) => {
    if (oldId !== null && oldId !== newId) stopAudioPlayback(oldId)
    if (newId === null) return
    await startAudioPlayback(newId)
  })

  // ── Playback ──────────────────────────────────────────────────────
  const playUrl = (url: string, index: number, format: string) => {
    if (isStreamFormat(format)) {
      if (playingId.value === index) { stopPlayback(index); playingId.value = null }
      else {
        if (playingId.value !== null) stopPlayback(playingId.value)
        playingId.value = index
      }
    } else if (isAudioFormat(format)) {
      if (audioPlayingId.value === index) stopAudioPlayback(index)
      else {
        if (audioPlayingId.value !== null) stopAudioPlayback(audioPlayingId.value)
        audioPlayingId.value = index
      }
    } else if (isImageFormat(format)) {
      previewImage(url)
    } else {
      browser.tabs.create({ url })
    }
  }

  const stopPlayback = (index: number) => {
    const hls = hlsInstances.value.get(index)
    if (hls) { hls.destroy(); hlsInstances.value.delete(index) }
    const dash = dashInstances.value.get(index)
    if (dash) { dash.destroy(); dashInstances.value.delete(index) }
    if (playingId.value === index) playingId.value = null
  }

  watch(playingId, async (newId, oldId) => {
    if (oldId !== null && oldId !== newId) {
      const oldHls = hlsInstances.value.get(oldId)
      if (oldHls) { oldHls.destroy(); hlsInstances.value.delete(oldId) }
      const oldDash = dashInstances.value.get(oldId)
      if (oldDash) { oldDash.destroy(); dashInstances.value.delete(oldId) }
    }
    if (newId === null) return
    await nextTick()
    const item = filteredMediaList.value[newId]
    if (!item) return
    const videoEl = document.getElementById(`video-player-${newId}`) as HTMLVideoElement | null
    if (!videoEl) return
    const format = item.format.toLowerCase()
    if (format === 'm3u8') {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, backBufferLength: 90 })
        hlsInstances.value.set(newId, hls)
        hls.on(Hls.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}) })
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break
              case Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break
              default: stopPlayback(newId); showToastMsg(browser.i18n.getMessage('playError') + data.details)
            }
          }
        })
        hls.loadSource(item.url)
        hls.attachMedia(videoEl)
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = item.url
        videoEl.play().catch(() => {})
      } else {
        showToastMsg(browser.i18n.getMessage('unplayable'))
      }
    } else if (format === 'mpd') {
      const dash = dashjs.MediaPlayer().create()
      dashInstances.value.set(newId, dash)
      dash.initialize(videoEl, item.url, false)
      dash.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
        if (e.error) {
          showToastMsg(browser.i18n.getMessage('playError') + (e.error.message || 'Unknown error'))
          stopPlayback(newId)
        }
      })
      dash.play()
    }
  })

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => showToastMsg(browser.i18n.getMessage('copyTips')))
  }

  const previewImage = (url: string) => {
    previewImageUrl.value = url
  }

  const onImageLoad = (event: Event, url: string) => {
    const img = event.target as HTMLImageElement
    if (img.naturalWidth && img.naturalHeight) {
      const item = mediaList.value.find(i => i.url === url)
      if (item && (!item.width || !item.height)) {
        item.width = img.naturalWidth
        item.height = img.naturalHeight
      }
    }
    imageLoadStatus.set(url, true)
  }

  const sanitizeFilename = (name: string): string => {
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/g
    let sanitized = name.replace(invalidChars, '_')
    sanitized = sanitized.replace(/[\s.]+$/g, '').replace(/^[.\s]+/g, '')
    sanitized = sanitized.replace(/\.{2,}/g, '_')
    sanitized = sanitized.replace(/\s+/g, '_')
    if (sanitized.length === 0) sanitized = 'download'
    if (sanitized.length > 100) sanitized = sanitized.slice(0, 100)
    return sanitized
  }

  const downloadUrl = (url: string, format: string) => {
    let filename: string
    if (isStreamFormat(format)) {
      filename = sanitizeFilename(currentTabTitle)
      browser.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_PAGE', url, format, filename })
    } else {
      filename = getDownloadFilename(url, format)
      browser.downloads.download({ url, filename })
    }
  }

  const toggleSelect = (index: number) => {
    if (selectedItems.value.has(index)) {
      selectedItems.value.delete(index)
    } else {
      selectedItems.value.add(index)
    }
  }

  const toggleSelectAll = () => {
    if (selectedItems.value.size === filteredMediaList.value.length) {
      selectedItems.value.clear()
    } else {
      filteredMediaList.value.forEach((_, index) => selectedItems.value.add(index))
    }
  }

  const batchDownload = () => {
    const items = filteredMediaList.value.filter((_, index) => selectedItems.value.has(index))
    const subDir = sanitizeDirectoryName(currentTabTitle)
    items.forEach((item, idx) => {
      let filename: string
      if (isStreamFormat(item.format)) {
        const baseName = sanitizeFilename(currentTabTitle)
        const suffix = items.length > 1 ? `_${idx + 1}` : ''
        filename = `${baseName}${suffix}`
        browser.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_PAGE', url: item.url, format: item.format, filename })
      } else {
        filename = getBatchDownloadFilename(item.url, item.format, subDir)
        browser.downloads.download({ url: item.url, filename })
      }
    })
    showToastMsg(`已开始下载 ${items.length} 个文件`)
    selectedItems.value.clear()
  }

  const openFeedback = () => {
    showMore.value = false
    browser.tabs.create({ url: 'https://github.com' })
  }

  const openHelp = () => {
    showMore.value = false
    browser.tabs.create({ url: 'https://github.com' })
  }

  // ── Settings actions ──────────────────────────────────────────────
  function parseExcludeDomains(text: string): string[] {
    return text.split('\n').map(d => d.trim()).filter(d => d.length > 0)
  }

  async function triggerSave() {
    const domains = parseExcludeDomains(excludeDomainsText.value)
    settings.value.excludeDomains = domains
    await saveSettings({
      sniffingRules: settings.value.sniffingRules,
      excludeDomains: Array.from(domains),
    })
    settingsSaved.value = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { settingsSaved.value = false }, 2500)
  }

  function triggerTextSave() {
    if (textSaveTimer) clearTimeout(textSaveTimer)
    textSaveTimer = setTimeout(() => { triggerSave() }, 600)
  }

  async function openShortcuts() {
    if (typeof browser.commands?.openShortcutSettings === 'function') {
      browser.commands.openShortcutSettings()
    } else {
      browser.tabs.create({ url: 'chrome://extensions/shortcuts' })
    }
  }

  function handleResetClick() {
    if (!resetConfirm.value) {
      resetConfirm.value = true
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
      resetConfirmTimer = setTimeout(() => { resetConfirm.value = false }, 3000)
      return
    }
    resetConfirm.value = false
    settings.value = {
      sniffingRules: {
        streaming: { ...DEFAULT_SETTINGS.sniffingRules.streaming },
        video:     { ...DEFAULT_SETTINGS.sniffingRules.video },
        audio:     { ...DEFAULT_SETTINGS.sniffingRules.audio },
        image:     { ...DEFAULT_SETTINGS.sniffingRules.image },
      },
      excludeDomains: [],
    }
    excludeDomainsText.value = ''
    triggerSave()
  }

  function openSettings() {
    view.value = 'settings'
    showMore.value = false
  }

  async function backToList() {
    if (textSaveTimer) {
      clearTimeout(textSaveTimer)
      textSaveTimer = null
    }
    await triggerSave()
    view.value = 'list'
  }
</script>

<template>
  <div class="w-[500px] min-w-[500px] h-[600px] max-h-[600px] bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col relative overflow-hidden">

    <!-- ═══ LIST VIEW ═══════════════════════════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 -translate-x-4"
      enter-to-class="opacity-100 translate-x-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100 translate-x-0"
      leave-to-class="opacity-0 -translate-x-4"
    >
      <div v-if="view === 'list'" class="flex flex-col h-full">
        <div class="border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-900 z-10 shrink-0">
          <div class="flex items-center px-3 py-2 border-b border-gray-100 dark:border-gray-800">
            <img src="/icon/48.png" alt="FlowPick" class="w-6 h-6 mr-2" />
            <div class="flex items-center gap-1.5">
              <span class="text-sm font-bold text-gray-800 dark:text-gray-100">FlowPick</span>
              <span class="text-[10px] text-gray-400 dark:text-gray-500"> | 智能嗅探，一键下载</span>
            </div>
          </div>
          <div class="flex items-center">
            <nav class="flex -mb-px flex-1">
              <button @click="activeTab = 'all'" :class="[activeTab === 'all' ? 'border-blue-500 text-blue-600 dark:text-blue-400 dark:border-blue-400 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                ALL({{ tabCounts.all }})
              </button>
              <button @click="activeTab = 'stream'" :class="[activeTab === 'stream' ? 'border-purple-500 text-purple-600 dark:text-purple-400 dark:border-purple-400 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                Stream({{ tabCounts.stream }})
              </button>
              <button @click="activeTab = 'video'" :class="[activeTab === 'video' ? 'border-blue-500 text-blue-600 dark:text-blue-400 dark:border-blue-400 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                Video({{ tabCounts.video }})
              </button>
              <button @click="activeTab = 'audio'" :class="[activeTab === 'audio' ? 'border-green-500 text-green-600 dark:text-green-400 dark:border-green-400 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                Audio({{ tabCounts.audio }})
              </button>
              <button @click="activeTab = 'image'" :class="[activeTab === 'image' ? 'border-orange-500 text-orange-600 dark:text-orange-400 dark:border-orange-400 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                Image({{ tabCounts.image }})
              </button>
            </nav>
          </div>
          <div v-if="filteredMediaList.length > 0" class="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-2">
              <button @click="toggleSelectAll" class="flex items-center justify-center w-7 h-7 rounded-md text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all" :title="selectedItems.size === filteredMediaList.length ? '取消全选' : '全选'">
                <svg class="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                  <circle cx="12" cy="12" r="9" />
                  <path v-if="selectedItems.size === filteredMediaList.length" stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4" />
                </svg>
              </button>
              <button @click="batchDownload" :disabled="selectedItems.size === 0" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-500 hover:bg-blue-400 disabled:bg-gray-200 dark:disabled:bg-gray-700 text-white rounded-lg transition-all disabled:cursor-not-allowed shadow-sm" title="下载所选" >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span v-if="selectedItems.size > 0">{{ selectedItems.size }}</span>
              </button>
            </div>
            <button @click="showFilter = !showFilter" 
              :class="[
                'flex items-center justify-center w-7 h-7 rounded-md transition-all',
                showFilter || typeFilter !== 'any' || sizeFilter.min > 0 || sizeFilter.max > 0 || dimensionFilter.minWidth > 0 || dimensionFilter.minHeight > 0 || resolutionFilter !== 'any'
                  ? 'text-blue-500 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' 
                  : 'text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              ]"
              title="过滤">
              <svg class="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
            </button>
          </div>
          <Transition
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 max-h-0"
            enter-to-class="opacity-100 max-h-32"
            leave-active-class="transition-all duration-150 ease-in"
            leave-from-class="opacity-100 max-h-32"
            leave-to-class="opacity-0 max-h-0"
          >
            <div v-if="showFilter" class="px-2 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 overflow-hidden">
              <div class="flex flex-wrap gap-3 text-xs">
                <div class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">类型:</span>
                  <select v-model="typeFilter"
                    class="px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                    <option value="any">Any</option>
                    <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value" :disabled="opt.disabled">
                      {{ opt.label }}({{ opt.count }})
                    </option>
                  </select>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">大小:</span>
                  <input type="number" v-model.number="sizeFilter.min" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    placeholder="最小" />
                  <span class="text-gray-400">-</span>
                  <input type="number" v-model.number="sizeFilter.max" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    placeholder="最大" />
                  <span class="text-gray-400">KB</span>
                </div>
                <div v-if="activeTab === 'image'" class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">尺寸:</span>
                  <input type="number" v-model.number="dimensionFilter.minWidth" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    placeholder="宽" />
                  <span class="text-gray-400">×</span>
                  <input type="number" v-model.number="dimensionFilter.minHeight" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    placeholder="高" />
                  <span class="text-gray-400">px</span>
                </div>
                <div v-if="activeTab === 'video'" class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">分辨率:</span>
                  <select v-model="resolutionFilter"
                    class="px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                    <option value="any">Any</option>
                    <option value="8k">8K</option>
                    <option value="4k">4K</option>
                    <option value="1080p">1080P</option>
                    <option value="720p">720P</option>
                    <option value="480p">480P</option>
                    <option value="360p">360P</option>
                    <option value="sd">SD</option>
                  </select>
                </div>
                <button @click="typeFilter = 'any'; sizeFilter = { min: 0, max: 0 }; dimensionFilter = { minWidth: 0, minHeight: 0 }; resolutionFilter = 'any'" 
                  class="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-900 dark:hover:text-white rounded transition-all duration-150">
                  重置
                </button>
              </div>
            </div>
          </Transition>
        </div>

        <main class="flex-1 overflow-y-auto min-h-0">
          <div v-if="filteredMediaList.length === 0"
            class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 px-6 py-12">
            <div class="w-20 h-20 mb-4 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
              <svg class="w-10 h-10 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <p class="text-base font-medium text-gray-600 dark:text-gray-400 mb-2">{{ browser.i18n.getMessage('notFound') }}</p>
            <p class="text-sm text-center text-gray-500 dark:text-gray-500 leading-relaxed">{{ browser.i18n.getMessage('playTips') }}</p>
          </div>

          <template v-else>
            <div v-if="activeTab === 'image'" class="p-2 columns-2 sm:columns-3 gap-2">
              <div v-for="(item, index) in filteredMediaList" :key="item.url + index"
                @click="toggleSelect(index)"
                :class="[
                  'break-inside-avoid mb-2 group relative rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer',
                  selectedItems.has(index) ? 'ring-2 ring-blue-500 ring-offset-1' : ''
                ]">
                <img :src="item.url" :alt="getFileName(item.url)" 
                  class="w-full h-auto object-cover"
                  loading="lazy"
                  @error="imageLoadStatus.set(item.url, false)"
                  @load="onImageLoad($event, item.url)" />
                <div v-if="selectedItems.has(index)" class="absolute top-2 left-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                  <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div v-if="!selectedItems.has(index)" class="absolute top-2 left-2 w-5 h-5 bg-white/80 dark:bg-gray-800/80 rounded-full border-2 border-gray-300 dark:border-gray-600">
                </div>
                <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <div class="absolute bottom-0 left-0 right-0 p-2">
                    <p class="text-xs text-white font-medium truncate mb-1">{{ getFileName(item.url) }}</p>
                    <div class="flex items-center gap-1" @click.stop>
                      <button @click="copyUrl(item.url)"
                        class="p-1 rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                        :title="browser.i18n.getMessage('copyUrl')">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button @click="downloadUrl(item.url, item.format)"
                        class="p-1 rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                        :title="browser.i18n.getMessage('download')">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                      <button @click="previewImage(item.url)"
                        class="p-1 rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                        title="预览">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="px-2 py-1.5 bg-white dark:bg-gray-800 border-t border-gray-100 dark:border-gray-700">
                  <div class="flex items-center justify-end gap-1.5 text-xs">
                    <span :class="getFormatColor(item.format)" class="px-1.5 py-0.5 rounded font-medium">
                      {{ getFormatLabel(item.format) }}
                    </span>
                    <span v-if="item.size" :class="getSizeColor()" class="px-1.5 py-0.5 rounded font-medium">
                      {{ formatFileSize(item.size) }}
                    </span>
                    <span v-if="item.width && item.height" :class="getResolutionColor(item.width, item.height)" class="px-1.5 py-0.5 rounded font-medium">
                      {{ item.width }}×{{ item.height }}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div v-else class="p-2 flex flex-col gap-2">
              <div v-for="(item, index) in filteredMediaList" :key="item.url + index"
                @click="toggleSelect(index)"
                :class="[
                  'group relative rounded-lg overflow-hidden bg-white dark:bg-gray-800 shadow-sm hover:shadow-lg hover:ring-2 hover:ring-blue-200 dark:hover:ring-blue-800 transition-all duration-200 cursor-pointer border',
                  selectedItems.has(index) ? 'ring-2 ring-blue-400 dark:ring-blue-500 border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'
                ]">
                <div class="p-3 flex items-center gap-3">
                  <div class="flex-shrink-0">
                    <div :class="[
                      'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-200',
                      selectedItems.has(index) 
                        ? 'border-blue-500 bg-blue-500' 
                        : 'border-gray-300 dark:border-gray-600 group-hover:border-blue-400'
                    ]">
                      <svg v-if="selectedItems.has(index)" class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="font-medium text-sm truncate mb-1.5" :title="getFileName(item.url)">{{ getFileName(item.url) }}</p>
                    <div class="flex items-center gap-1.5 text-xs">
                      <span :class="getFormatColor(item.format)" class="px-1.5 py-0.5 rounded font-medium">
                        {{ getFormatLabel(item.format) }}
                      </span>
                      <template v-if="isVideoFormat(item.format)">
                        <span v-if="getResolutionLabel(item.width, item.height)" :class="getResolutionColor(item.width, item.height)" class="px-1.5 py-0.5 rounded font-medium">
                          {{ getResolutionLabel(item.width, item.height) }}
                        </span>
                        <span v-if="item.duration" class="px-1.5 py-0.5 rounded font-medium bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300">
                          {{ formatDuration(item.duration) }}
                        </span>
                        <span v-if="item.size" :class="getSizeColor()" class="px-1.5 py-0.5 rounded font-medium">
                          {{ formatFileSize(item.size) }}
                        </span>
                      </template>
                      <template v-else-if="isAudioFormat(item.format)">
                        <span v-if="item.size" :class="getSizeColor()" class="px-1.5 py-0.5 rounded font-medium">
                          {{ formatFileSize(item.size) }}
                        </span>
                        <span v-if="item.duration" class="px-1.5 py-0.5 rounded font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
                          {{ formatDuration(item.duration) }}
                        </span>
                      </template>
                      <template v-else>
                        <span v-if="item.size" :class="getSizeColor()" class="px-1.5 py-0.5 rounded font-medium">
                          {{ formatFileSize(item.size) }}
                        </span>
                        <span v-if="item.width && item.height && isImageFormat(item.format)" :class="getResolutionColor(item.width, item.height)" class="px-1.5 py-0.5 rounded font-medium">
                          {{ item.width }}×{{ item.height }}
                        </span>
                      </template>
                    </div>
                  </div>
                  <div class="flex items-center gap-1 flex-shrink-0" @click.stop>
                    <button @click="copyUrl(item.url)"
                      class="p-1.5 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 active:scale-90 transition-all duration-150"
                      :title="browser.i18n.getMessage('copyUrl')">
                      <svg class="w-4 h-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                    <button @click="playUrl(item.url, index, item.format)"
                      class="p-1.5 rounded transition-all duration-150 active:scale-90"
                      :class="(isStreamFormat(item.format) && playingId === index) || (isAudioFormat(item.format) && audioPlayingId === index) ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'"
                      :title="(isStreamFormat(item.format) && playingId === index) || (isAudioFormat(item.format) && audioPlayingId === index) ? browser.i18n.getMessage('stopPlay') : browser.i18n.getMessage('play')">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <template v-if="(isStreamFormat(item.format) && playingId === index) || (isAudioFormat(item.format) && audioPlayingId === index)">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6" />
                        </template>
                        <template v-else-if="isAudioFormat(item.format)">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </template>
                        <template v-else-if="isImageFormat(item.format)">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </template>
                        <template v-else>
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </template>
                      </svg>
                    </button>
                    <button @click="downloadUrl(item.url, item.format)"
                      class="p-1.5 rounded bg-green-600 hover:bg-green-500 active:scale-90 text-white transition-all duration-150"
                      :title="browser.i18n.getMessage('download')">
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div v-if="isStreamFormat(item.format) && playingId === index" class="px-3 pb-3 pt-0">
                  <div class="bg-gray-900 dark:bg-gray-950 rounded-lg overflow-hidden">
                    <video :id="'video-player-' + index" class="w-full max-h-64" controls />
                  </div>
                </div>
                <div v-if="isAudioFormat(item.format) && audioPlayingId === index" class="px-3 pb-3 pt-0">
                  <div class="bg-gray-900 dark:bg-gray-950 rounded-lg overflow-hidden p-2 flex flex-col gap-2">
                    <canvas :id="'spectrum-' + index" width="300" height="60" class="w-full rounded" />
                    <audio :id="'audio-player-' + index" :src="item.url" class="w-full h-8" controls crossorigin="anonymous" />
                  </div>
                </div>
              </div>
            </div>
        </template>
        </main>

        <Teleport to="body">
          <Transition
            enter-active-class="transition-opacity duration-200 ease-out"
            enter-from-class="opacity-0"
            enter-to-class="opacity-100"
            leave-active-class="transition-opacity duration-150 ease-in"
            leave-from-class="opacity-100"
            leave-to-class="opacity-0"
          >
            <div v-if="previewImageUrl" 
              class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
              @click="previewImageUrl = ''">
              <button @click="previewImageUrl = ''" 
                class="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <img :src="previewImageUrl" 
                class="max-w-[95vw] max-h-[95vh] object-contain rounded-lg shadow-2xl"
                @click.stop />
            </div>
          </Transition>
        </Teleport>

        <footer class="px-3 py-2 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs relative shrink-0 bg-white dark:bg-gray-900">
          <div class="flex items-center gap-1">
            <button @click="openSettings"
              class="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              :title="browser.i18n.getMessage('settings')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>

          <span class="text-gray-400 dark:text-gray-500">v{{ version }}</span>

          <div class="relative">
            <button @click="showMore = !showMore"
              class="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              :title="browser.i18n.getMessage('more')">
              <svg class="w-4 h-4 transition-transform duration-200" :class="{ 'rotate-180': showMore }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <Transition
              enter-active-class="transition-all duration-200 ease-out"
              enter-from-class="opacity-0 scale-95 translate-y-1"
              enter-to-class="opacity-100 scale-100 translate-y-0"
              leave-active-class="transition-all duration-150 ease-in"
              leave-from-class="opacity-100 scale-100 translate-y-0"
              leave-to-class="opacity-0 scale-95 translate-y-1"
            >
              <div v-if="showMore"
                class="absolute bottom-full right-0 mb-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg overflow-hidden min-w-24 origin-bottom-right">
                <a href="#" @click.prevent="openFeedback" class="flex items-center gap-2 px-3 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                  </svg>
                  <span>{{ browser.i18n.getMessage('feedback') }}</span>
                </a>
                <a href="#" @click.prevent="openHelp" class="flex items-center gap-2 px-3 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{{ browser.i18n.getMessage('help') }}</span>
                </a>
              </div>
            </Transition>
          </div>
        </footer>
      </div>
    </Transition>

    <!-- ═══ SETTINGS VIEW ════════════════════════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 translate-x-4"
      enter-to-class="opacity-100 translate-x-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100 translate-x-0"
      leave-to-class="opacity-0 translate-x-4"
    >
      <div v-if="view === 'settings'" class="flex flex-col h-full absolute inset-0 bg-white dark:bg-gray-900">

        <!-- Header -->
        <div class="shrink-0 px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-900 shadow-sm">
          <div class="flex items-center gap-2">
            <button @click="backToList"
              class="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 active:scale-90 transition-all duration-150">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span class="font-semibold text-sm">{{ browser.i18n.getMessage('settings') }}</span>
          </div>

          <!-- Saved indicator - banner style -->
          <Transition
            enter-active-class="transition-all duration-300 ease-out"
            enter-from-class="opacity-0 scale-75"
            enter-to-class="opacity-100 scale-100"
            leave-active-class="transition-all duration-200 ease-in"
            leave-from-class="opacity-100 scale-100"
            leave-to-class="opacity-0 scale-75"
          >
            <div v-if="settingsSaved"
              class="flex items-center gap-1.5 px-3 py-1 bg-green-500 text-white text-xs font-semibold rounded-full shadow-sm shadow-green-200 dark:shadow-green-900">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
              </svg>
              {{ browser.i18n.getMessage('saved') }}
            </div>
          </Transition>
        </div>

        <div class="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3">

          <!-- Sniffing Groups -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-blue-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ browser.i18n.getMessage('sniffingRules') }}</p>
            </div>
            <!-- 表头 -->
            <div class="grid grid-cols-[1fr_auto_120px] items-center px-4 py-2 border-b border-gray-100 dark:border-gray-700/50 bg-gray-100/60 dark:bg-gray-700/40">
              <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{{ browser.i18n.getMessage('type') }}</span>
              <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider text-center pr-3">{{ browser.i18n.getMessage('sniffingRulesDesc') }}</span>
              <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{{ browser.i18n.getMessage('minSizeKB') }}</span>
            </div>
            <!-- 数据行 -->
            <div class="divide-y divide-gray-100 dark:divide-gray-700/50">
              <div v-for="row in SNIFFING_ROWS" :key="row.key"
                class="grid grid-cols-[1fr_auto_120px] items-center px-4 py-3 hover:bg-gray-100/60 dark:hover:bg-gray-700/40 transition-colors duration-150">
                <!-- 第一列：类型 -->
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-base leading-none select-none">{{ row.icon }}</span>
                  <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">{{ row.label }}</span>
                </div>
                <!-- 第二列：嗅探开关 -->
                <div class="flex justify-center pr-3">
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="settings.sniffingRules[row.key].enabled"
                    @click="settings.sniffingRules[row.key].enabled = !settings.sniffingRules[row.key].enabled; triggerSave()"
                    :class="['relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none shadow-inner', settings.sniffingRules[row.key].enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600']"
                  >
                    <span :class="['pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out', settings.sniffingRules[row.key].enabled ? 'translate-x-4' : 'translate-x-0']" />
                  </button>
                </div>
                <!-- 第三列：最小大小 -->
                <div class="flex items-center gap-1.5">
                  <input
                    type="number" min="0" step="1"
                    v-model.number="settings.sniffingRules[row.key].minSizeKB"
                    @change="triggerSave"
                    :disabled="!settings.sniffingRules[row.key].enabled"
                    class="w-full px-2 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed"
                  />
                  <span class="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">KB</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Exclude Domains -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-red-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ browser.i18n.getMessage('excludeDomains') }}</p>
            </div>
            <div class="px-4 py-4">
              <textarea
                v-model="excludeDomainsText"
                @input="triggerTextSave"
                @blur="triggerSave"
                rows="3"
                placeholder="twitter.com&#10;facebook.com"
                class="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-150 resize-none font-mono shadow-sm"
              />
              <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{{ browser.i18n.getMessage('excludeDomainsDesc') }}</p>
            </div>
          </div>

          <!-- Keyboard Shortcuts -->
          <div class="bg-gray-50 dark:bg-gray-800/80 rounded-2xl overflow-hidden border border-gray-100 dark:border-gray-700/50 shadow-sm">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700/70 flex items-center gap-2">
              <div class="w-1.5 h-4 bg-indigo-500 rounded-full"></div>
              <p class="text-xs font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">{{ browser.i18n.getMessage('keyboardShortcuts') }}</p>
            </div>
            <div class="px-4 py-4 flex items-center justify-between">
              <p class="text-sm text-gray-600 dark:text-gray-400">{{ browser.i18n.getMessage('keyboardShortcutsDesc') }}</p>
              <button type="button" @click="openShortcuts"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 active:scale-95 transition-all duration-150">
                Open
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Reset -->
          <div class="pt-1 pb-3">
            <button
              type="button"
              @click="handleResetClick"
              :class="[
                'w-full py-3 rounded-2xl font-semibold text-sm transition-all duration-200 active:scale-98',
                resetConfirm
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-200 dark:shadow-red-900/40 scale-[1.01]'
                  : 'bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 border-2 border-red-200 dark:border-red-800'
              ]"
            >
              <span v-if="resetConfirm" class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {{ browser.i18n.getMessage('resetConfirm') }}
              </span>
              <span v-else class="flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {{ browser.i18n.getMessage('resetToDefaults') }}
              </span>
            </button>
          </div>

        </div>
      </div>
    </Transition>

    <!-- ═══ TOAST ══════════════════════════════════════════════════════ -->
    <Transition enter-active-class="transition ease-out duration-300" enter-from-class="opacity-0 translate-y-2"
      enter-to-class="opacity-100 translate-y-0" leave-active-class="transition ease-in duration-200"
      leave-from-class="opacity-100 translate-y-0" leave-to-class="opacity-0 translate-y-2">
      <div v-if="showToast"
        class="absolute bottom-16 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-800 dark:bg-gray-100 text-white dark:text-gray-800 rounded-lg shadow-lg text-sm flex items-center gap-2 z-50">
        <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        {{ toastMessage }}
      </div>
    </Transition>

  </div>
</template>

<style scoped></style>