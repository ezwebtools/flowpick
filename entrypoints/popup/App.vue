<script lang="ts" setup>
  import type HlsInstance from 'hls.js'
  import type { MediaPlayerClass as DashPlayer } from 'dashjs'
  import type mpegts from 'mpegts.js'
  import { loadAppearance, saveAppearance, applyTheme, currentLocale, currentTheme, currentDensity, t } from '../../utils/i18n'
  import { loadSettings, saveSettings, DEFAULT_SETTINGS,  type Settings } from '../../utils/settings'
  import { useMediaStore } from './composables/useMediaStore'
  import type { ListUpdatedMessage, MediaItem, MetadataBatchRequest, MetadataBatchResponse, RawMediaEntry } from './types'
  import { useMediaFilters } from './composables/useMediaFilters'
  import { loadDash, loadHls, loadMpegts, useStreamThumbnails } from './composables/useStreamThumbnails'
  import { useMediaViewModels } from './composables/useMediaViewModels'
  import { createHlsProxyLoader } from './utils/hlsProxyLoader'
  const SettingsView = defineAsyncComponent(() => import('./components/SettingsView.vue'))

  const props = withDefaults(defineProps<{ mode?: 'popup' | 'sidepanel' }>(), { mode: 'popup' })
  const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  const mobileCapabilityTip = /zh/i.test(navigator.language)
    ? '移动端提示：普通下载可用；直播录制和 MSE 下载可能受后台运行及内存限制。'
    : 'Mobile note: regular downloads are supported; live recording and MSE downloads may be limited by background execution and memory.'

  const rootContainerClass = computed(() => {
    const base = 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col relative overflow-hidden'
    return props.mode === 'sidepanel'
      ? `w-full h-screen max-h-screen ${base}`
      : `w-[500px] min-w-[500px] h-[600px] max-h-[600px] ${base}`
  })

  type View = 'list' | 'settings'

  function getMediaKey(item: Pick<MediaItem, 'url' | 'format' | 'captureId' | 'groupId' | 'groupRole'>): string {
    return [item.captureId ?? '', item.groupId ?? '', item.groupRole ?? '', item.format.toLowerCase(), item.url].join('|')
  }

  function getMediaDomId(item: Pick<MediaItem, 'url' | 'format' | 'captureId' | 'groupId' | 'groupRole'>): string {
    const key = getMediaKey(item)
    let hash = 2166136261
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
  }

  function getDomIdFromMediaKey(key: string): string {
    let hash = 2166136261
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
  }

  function itemToMediaItem(item: RawMediaEntry | string): MediaItem {
    if (typeof item === 'string') {
      return { url: item, format: 'm3u8' }
    } else if (item && typeof item === 'object') {
      return {
        url: item.url || '',
        format: item.format || 'm3u8',
        size: typeof item.size === 'number' ? item.size : undefined,
        width: typeof item.width === 'number' ? item.width : undefined,
        height: typeof item.height === 'number' ? item.height : undefined,
        duration: typeof item.duration === 'number' ? item.duration : undefined,
        coverUrl: typeof item.coverUrl === 'string' ? item.coverUrl : undefined,
        detectedAt: typeof item.detectedAt === 'number' ? item.detectedAt : undefined,
        category: typeof item.category === 'string' ? item.category : undefined,
        requestHeaders: item.requestHeaders && typeof item.requestHeaders === 'object' ? item.requestHeaders : undefined,
        captureId: typeof item.captureId === 'string' ? item.captureId : undefined,
        trackCount: typeof item.trackCount === 'number' ? item.trackCount : undefined,
        mseComplete: typeof item.mseComplete === 'boolean' ? item.mseComplete : undefined,
        groupId: typeof item.groupId === 'string' ? item.groupId : undefined,
        groupRole: item.groupRole as MediaItem['groupRole'] ?? undefined,
        groupLabel: typeof item.groupLabel === 'string' ? item.groupLabel : undefined,
        groupMasterId: typeof item.groupMasterId === 'string' ? item.groupMasterId : undefined,
        variantBandwidth: typeof item.variantBandwidth === 'number' ? item.variantBandwidth : undefined,
        audioUrl: typeof item.audioUrl === 'string' ? item.audioUrl : undefined,
        audioOptions: Array.isArray(item.audioOptions) ? item.audioOptions : undefined,
        tabTitle: typeof item.tabTitle === 'string' ? item.tabTitle : undefined,
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

  function formatItemSize(item: MediaItem): string {
    if (!item.size) return ''
    const base = formatFileSize(item.size)
    return isStreamFormat(item.format) ? `~${base}` : base
  }

  // popup 获取到 duration / width / height / size 后写回 background 持久化（跨 popup 会话保留）
  const updateMediaMeta = (item: MediaItem, tabId = currentTabId) => {
    if (tabId === undefined || !item.url) return
    if (!item.duration && !item.width && !item.height && !item.size) return
    browser.runtime.sendMessage({
      type: 'UPDATE_MEDIA_META',
      tabId,
      url: item.url,
      duration: item.duration,
      width: item.width,
      height: item.height,
      size: item.size,
    }).catch(() => {})
  }

  // ── List view state ──────────────────────────────────────────────
  const view = ref<View>('list')
  const showMore = ref(false)
  const showToast = ref(false)
  const toastMessage = ref('')
  const {
    mediaList, mediaByKey, mediaIndexByKey, mediaByUrl,
    replace: replaceMediaList,
    patchOne: patchMediaItem,
    patchMany: patchMediaItems,
    handleListUpdate,
    clear: clearMediaStore,
    dispose: disposeMediaStore,
  } = useMediaStore<MediaItem, RawMediaEntry | string>({
    getKey: getMediaKey,
    normalize: itemToMediaItem,
    getCurrentTabId: () => currentTabId,
    onCommitted: () => {
      reconcileMediaState()
      fetchAllMetadataBatch(currentTabId, mediaSession)
    },
  })
  const STREAM_FORMATS = ['m3u8', 'mpd', 'mse', 'flv']
  const VIDEO_DOWNLOAD_FORMATS = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ts', 'ogv', 'm4v', 'mp3', 'aac', 'ogg', 'flac', 'wav', '3gp', '3g2', 'mpeg']
  const isStreamFormat = (f: string) => STREAM_FORMATS.includes(f.toLowerCase())
  const isVideoDownloadFormat = (f: string) => VIDEO_DOWNLOAD_FORMATS.includes(f.toLowerCase())
  const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'ogv', 'ts', '3gp', '3g2', 'mpeg', 'm4v']
  const AUDIO_FORMATS = ['mp3', 'm4a', 'oga', 'weba', 'wav', 'flac', 'aac', 'ogg']
  const IMAGE_FORMATS = ['gif', 'jpg', 'jpeg', 'png', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff']
  const ALL_DOC_FORMATS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'csv', 'rtf']
  const ALL_SUB_FORMATS = ['srt', 'vtt', 'ass', 'ssa', 'ttml']

  const DOC_AND_SUB_FORMATS = [...ALL_DOC_FORMATS, ...ALL_SUB_FORMATS]

  const getMediaType = (format: string, category?: string): 'stream' | 'video' | 'audio' | 'image' | 'doc' | 'other' => {
    if (category === 'stream') return 'stream'
    if (category === 'document' || category === 'subtitle') return 'doc'
    const f = format.toLowerCase()
    if (STREAM_FORMATS.includes(f)) return 'stream'
    if (VIDEO_FORMATS.includes(f)) return 'video'
    if (AUDIO_FORMATS.includes(f)) return 'audio'
    if (IMAGE_FORMATS.includes(f)) return 'image'
    if (DOC_AND_SUB_FORMATS.includes(f)) return 'doc'
    return 'other'
  }
  // 判断是否为流媒体分片（HLS 的 .ts / DASH 的 .m4s，或已关联到父级的 segment）。
  // 这类分片是 m3u8/mpd 的子资源，应被隐藏，只显示父级播放列表入口。
  const isStreamSegment = (item: MediaItem): boolean => {
    if (item.groupRole === 'segment') return true
    const f = item.format.toLowerCase()
    if ((f === 'ts' || f === 'm4s') && Boolean(item.groupId || item.groupMasterId)) return true
    // HLS 分片可能先于 m3u8 出现，或与播放列表分布在不同 CDN/目录，
    // 此时后台无法按 URL 前缀建立 group 关联。当前页面存在 HLS 播放列表时，
    // 将未关联的 .ts 仍视为流媒体分片；没有 HLS 播放列表的独立 TS 文件不受影响。
    return f === 'ts' && mediaList.value.some(media => media.format.toLowerCase() === 'm3u8')
  }
  const playingKey = ref<string | null>(null)
  const audioPlayingKey = ref<string | null>(null)
  const hlsInstances = ref<Map<string, HlsInstance>>(new Map())
  const dashInstances = ref<Map<string, DashPlayer>>(new Map())
  const flvInstances = ref<Map<string, mpegts.Player>>(new Map())
  // FLV 直播流录制状态
  const flvRecording = ref<Map<string, { chunks: Uint8Array[]; controller: AbortController; startTime: number }>>(new Map())
  interface SeparatedAudioPlayer {
    element: HTMLAudioElement
    dispose: () => void
  }
  
  const separatedAudioPlayers = new Map<string, SeparatedAudioPlayer>()

  // 视频展开区域的实际高度（ResizeObserver 测量，自适应不同比例视频）
  const expandedHeights = ref<Map<string, number>>(new Map())
  const videoResizeObservers = new Map<string, ResizeObserver>()
  const listLoaded = ref(false)
  const selectedKeys = ref<Set<string>>(new Set())
  const imageLoadStatus = ref<Map<string, boolean>>(new Map())
  const previewImageUrl = ref('')
  const previewImageIndex = ref(-1)
  const showFilter = ref(false)

  const videoDimensionCache = ref<Map<string, { width: number; height: number }>>(new Map())
  const audioDurationCache = ref<Map<string, number>>(new Map())

  interface AudioPlayerState {
    analyser: AnalyserNode
    source: MediaElementAudioSourceNode
    animFrameId: number
  }
  const audioPlayers = new Map<string, AudioPlayerState>()
  let sharedAudioContext: AudioContext | null = null
  let currentTabId: number | undefined
  let mediaSession = 0
  let metadataTaskSequence = 0
  let activeMetadataTaskId: string | null = null
  const currentTabTitle = ref('')
  const version = browser.runtime.getManifest().version

  // ── Settings view state ──────────────────────────────────────────
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, sniffingRules: { ...DEFAULT_SETTINGS.sniffingRules } })
  const settingsSaved = ref(false)
  const excludeDomainsText = ref('')
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let textSaveTimer: ReturnType<typeof setTimeout> | null = null
  const resetConfirm = ref(false)
  let resetConfirmTimer: ReturnType<typeof setTimeout> | null = null
  
  // ── Media filtering ──────────────────────────────────────────────
  const {
    activeTab, typeFilter, sizeFilter, dimensionFilter, resolutionFilter, sortOrder,
    mediaCatalog, sizeFilteredMediaList, tabCounts, typeOptions,
    searchQuery, useRegex, regexValid, searchError, clearSearch,
    filteredMediaList, filteredImageList,
  } = useMediaFilters<MediaItem>({
    mediaList,
    settings,
    getType: getMediaType,
    isStream: isStreamFormat,
    isSegment: isStreamSegment,
    formatGroups: {
      stream: STREAM_FORMATS,
      video: VIDEO_FORMATS,
      audio: AUDIO_FORMATS,
      image: IMAGE_FORMATS,
      doc: DOC_AND_SUB_FORMATS,
    },
    getFormatLabel: format => getFormatLabel(format),
  })
  const previewCurrentItem = computed(() => mediaByUrl.value.get(previewImageUrl.value))
  // ── 虚拟列表（普通列表）────────────────────────────────────────────
  // “全部”标签的普通卡片与流媒体分组卡片使用相同的外框尺寸。
  // 分组卡片的实际高度为：compact 48 + 16 + 2 = 66，normal 56 + 24 + 2 = 82。
  const ITEM_HEIGHT = computed(() => {
    if (activeTab.value === 'all') return currentDensity.value === 'compact' ? 66 : 82
    return currentDensity.value === 'compact' ? 68 : 80
  })
  // 展开后的总高度 = 紧凑主内容（54） + 展开区域。视频/音频分开计算，避免展开区域被 overflow-hidden 裁掉
  // 视频展开：max-h-64(256) + padding(24) ≈ 280
  const EXPANDED_EXTRA_VIDEO = 280
  // 音频展开：canvas(60) + gap(8) + audio(32) + padding(16) ≈ 116
  const EXPANDED_EXTRA_AUDIO = 120
  const VIRTUAL_BUFFER = 5
  const listContainerRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const containerHeight = ref(props.mode === 'sidepanel' ? window.innerHeight : 600)
  // Stream groups precede the virtual list in All. Subtract their measured
  // height before calculating the virtual range, or long group sections leave
  // a false gap before the normal cards.
  const allStreamGroupsHeight = ref(0)
  let containerRO: ResizeObserver | null = null
  let allStreamGroupsRO: ResizeObserver | null = null
  let scrollFrameId: number | null = null
  let pendingScrollTop = 0

  function getItemHeight(item: MediaItem | undefined): number {
    if (!item) return ITEM_HEIGHT.value
    const key = getMediaKey(item)
    if (audioPlayingKey.value === key) return ITEM_HEIGHT.value + EXPANDED_EXTRA_AUDIO
    if (playingKey.value === key) {
      return ITEM_HEIGHT.value + (expandedHeights.value.get(key) ?? EXPANDED_EXTRA_VIDEO)
    }
    return ITEM_HEIGHT.value
  }

  const virtualMetrics = computed(() => {
    const list = flatMediaList.value
    const offsets: number[] = []
    let totalHeight = 0
    for (let i = 0; i < list.length; i++) {
      offsets.push(totalHeight)
      totalHeight += getItemHeight(list[i]) + 6
    }
    return { offsets, totalHeight }
  })

  function lowerBound(values: number[], target: number): number {
    let left = 0
    let right = values.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (values[middle] < target) left = middle + 1
      else right = middle
    }
    return left
  }

  const virtualList = computed(() => {
    const list = flatMediaList.value
    if (activeTab.value === 'image' || activeTab.value === 'stream') {
      return { items: [], offsetTop: 0, totalHeight: 0, startIndex: 0 }
    }
    const { offsets, totalHeight } = virtualMetrics.value
    const listScrollTop = activeTab.value === 'all'
      ? Math.max(0, scrollTop.value - allStreamGroupsHeight.value)
      : scrollTop.value
    const bufferPx = VIRTUAL_BUFFER * ITEM_HEIGHT.value
    const start = Math.max(0, lowerBound(offsets, listScrollTop - bufferPx) - 1)
    const end = Math.min(list.length, lowerBound(offsets, listScrollTop + containerHeight.value + bufferPx) + 1)
    const items = list.slice(start, end).map((item, i) => ({
      item,
      index: start + i,
      top: offsets[start + i],
    }))
    return { items, offsetTop: 0, totalHeight, startIndex: start }
  })

  // Stream masters use the same expandable card as the Stream tab. Exclude
  // their children here so variants never appear twice in All.
  const flatMediaList = computed(() => activeTab.value === 'all'
    ? filteredMediaList.value.filter(item => {
      // A grouped child may still be an MP4 and therefore classify as video
      // in the All tab. Its role, not only its category, decides whether it
      // belongs in the flat list.
      if (item.groupRole === 'variant' || item.groupRole === 'audio' || item.groupRole === 'segment') return false
      // Older generic A/V grouping created a virtual master under category
      // "media". It has no standalone payload and must not become a second
      // card next to the provider-managed stream group.
      if (item.groupRole === 'master' && item.url.startsWith('vid_grp_')) return false
      return getMediaType(item.format, item.category) !== 'stream'
    })
    : filteredMediaList.value)

  function onListScroll(e: Event) {
    pendingScrollTop = (e.target as HTMLElement).scrollTop
    if (scrollFrameId !== null) return
    scrollFrameId = requestAnimationFrame(() => {
      scrollTop.value = pendingScrollTop
      scrollFrameId = null
    })
  }

  function observeAllStreamGroups(el: unknown) {
    allStreamGroupsRO?.disconnect()
    allStreamGroupsRO = null
    if (!(el instanceof HTMLElement)) {
      allStreamGroupsHeight.value = 0
      return
    }
    const updateHeight = () => {
      // The element has mb-2, which is not part of contentRect.
      allStreamGroupsHeight.value = Math.ceil(el.getBoundingClientRect().height) + 8
    }
    updateHeight()
    allStreamGroupsRO = new ResizeObserver(updateHeight)
    allStreamGroupsRO.observe(el)
  }

  function initContainerObserver() {
    if (!listContainerRef.value) return
    containerRO?.disconnect()
    containerRO = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      containerHeight.value = rect.height
      masonryContainerWidth.value = rect.width || listContainerRef.value?.clientWidth || 460
    })
    containerRO.observe(listContainerRef.value)
    containerHeight.value = listContainerRef.value.clientHeight || containerHeight.value
    masonryContainerWidth.value = listContainerRef.value.clientWidth || 460
  }

  // ── 图片瀑布流虚拟化（真实高度双列）──────────────────────────────
  const MASONRY_COLS = 2
  const MASONRY_GAP = 8
  const MASONRY_DEFAULT_HEIGHT = 160
  const MASONRY_BUFFER_PX = 400

  interface MasonryItem {
    item: MediaItem
    index: number
    top: number
    height: number
    col: number
  }

  const masonryItems = ref<MasonryItem[]>([])
  const masonryTotalHeight = ref(0)
  const masonryContainerWidth = ref(460)
  let masonryFrameId: number | null = null

  function estimateImageHeight(item: MediaItem, colW: number): number {
    if (item.width && item.height && item.width > 0) {
      const ratio = item.height / item.width
      return Math.max(80, Math.min(400, Math.round(colW * ratio)))
    }
    return MASONRY_DEFAULT_HEIGHT
  }

  function buildMasonryLayout() {
    const list = filteredMediaList.value
    if (!list.length) { masonryItems.value = []; masonryTotalHeight.value = 0; return }
    const containerW = masonryContainerWidth.value || 460
    const colW = Math.floor((containerW - MASONRY_GAP - 16) / MASONRY_COLS)
    const colH = [0, 0]
    const result: MasonryItem[] = []
    for (let i = 0; i < list.length; i++) {
      const col = colH[0] <= colH[1] ? 0 : 1
      const top = colH[col]
      const height = estimateImageHeight(list[i], colW)
      result.push({ item: list[i], index: i, top, height, col })
      colH[col] = top + height + MASONRY_GAP
    }
    masonryItems.value = result
    masonryTotalHeight.value = Math.max(0, Math.max(colH[0], colH[1]) - MASONRY_GAP)
  }

  function scheduleMasonryBuild() {
    if (masonryFrameId !== null || activeTab.value !== 'image') return
    masonryFrameId = requestAnimationFrame(() => {
      masonryFrameId = null
      buildMasonryLayout()
    })
  }

  function onMasonryImageLoad(event: Event, mItem: MasonryItem) {
    const img = event.target as HTMLImageElement
    if (img.naturalWidth && img.naturalHeight) {
      const item = mItem.item
      if (item.width !== img.naturalWidth || item.height !== img.naturalHeight) {
        patchMediaItem(getMediaKey(item), { width: img.naturalWidth, height: img.naturalHeight })
        scheduleMasonryBuild()
      }
    }
    imageLoadStatus.value.set(mItem.item.url, true)
  }

  const imageVirtualItems = computed(() => {
    if (activeTab.value !== 'image') return []
    const viewTop = scrollTop.value - MASONRY_BUFFER_PX
    const viewBottom = scrollTop.value + containerHeight.value + MASONRY_BUFFER_PX
    return masonryItems.value.filter(m => m.top + m.height > viewTop && m.top < viewBottom)
  })

  const masonryColWidth = computed(() =>
    Math.floor((masonryContainerWidth.value - MASONRY_GAP - 16) / MASONRY_COLS)
  )

  function masonryColLeft(col: number): number {
    return 8 + col * (masonryColWidth.value + MASONRY_GAP)
  }

  // Only a tab change should reset the viewport. Image metadata arrives
  // progressively and changes flatMediaList; resetting here made the masonry
  // view jump while its cards learned their natural dimensions.
  watch(activeTab, () => {
    scrollTop.value = 0
    if (listContainerRef.value) listContainerRef.value.scrollTop = 0
    if (activeTab.value === 'image') nextTick(scheduleMasonryBuild)
  })

  watch(flatMediaList, () => {
    if (activeTab.value === 'image') nextTick(scheduleMasonryBuild)
  })

  watch(masonryContainerWidth, scheduleMasonryBuild)

  // ── 流媒体分组树 ─────────────────────────────────────────────────
  interface StreamVariant {
    label: string
    bandwidth?: number
    item: MediaItem
    audioItem?: MediaItem
    audioOptions?: Array<{ url: string, label: string }>
  }

  interface StreamGroup {
    id: string
    masterItem: MediaItem
    variants: StreamVariant[]
    isVirtual?: boolean
  }

  const expandedGroups = ref<Set<string>>(new Set())

  function toggleGroupExpand(groupId: string) {
    const next = new Set(expandedGroups.value)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    expandedGroups.value = next
  }

  const groupedStreamList = computed((): StreamGroup[] => {
    // 展示过滤与内部关联解耦：隐藏分片不应破坏 master/variant/audio 的封面依赖。
    const visibleItems = filteredMediaList.value
    const supportItems = mediaList.value
    const streamItems = visibleItems.filter(
      i => getMediaType(i.format, i.category) === 'stream'
    )

    const groups = new Map<string, StreamGroup>()
    const ungrouped: MediaItem[] = []

    for (const item of streamItems) {
      if (item.groupRole === 'segment' || item.groupRole === 'audio') continue

      if (item.groupRole === 'master') {
        const isVirtual = item.url.startsWith('vid_grp_')
        if (!groups.has(item.url)) {
          groups.set(item.url, { id: item.url, masterItem: item, variants: [], isVirtual })
        }
      } else if (item.groupRole === 'variant' && item.groupMasterId) {
        let group = groups.get(item.groupMasterId)
        if (!group) {
          // 查找 master（可能是虚拟的 vid_grp_ 条目，也可能是真实 m3u8）
          const masterItem = supportItems.find(i => i.url === item.groupMasterId)
          if (!masterItem) continue
          const isVirtual = masterItem.url.startsWith('vid_grp_')
          group = { id: item.groupMasterId, masterItem, variants: [], isVirtual }
          groups.set(item.groupMasterId, group)
        }
        // 对于 audio-only items，通过 audioUrl 关联（allItems 包含所有类型）
        const audioItem = item.audioUrl
          ? supportItems.find(i => i.url === item.audioUrl)
          : undefined
        group.variants.push({
          label: item.groupLabel || item.url,
          bandwidth: item.variantBandwidth,
          item,
          audioItem,
          audioOptions: item.audioOptions,
        })
      } else {
        ungrouped.push(item)
      }
    }

    // Bilibili DASH variants are direct MP4 URLs, so they belong to the
    // Video tab by format. Attach them to their visible virtual stream master
    // here instead of exposing video/audio/CDN URLs as unrelated cards.
    for (const item of supportItems) {
      if (item.groupRole !== 'variant' || !item.groupMasterId || !item.audioOptions) continue
      const group = groups.get(item.groupMasterId)
      if (!group || group.variants.some(variant => variant.item.url === item.url)) continue
      const audioItem = item.audioUrl ? supportItems.find(candidate => candidate.url === item.audioUrl) : undefined
      group.variants.push({
        label: item.groupLabel || item.url,
        bandwidth: item.variantBandwidth,
        item,
        audioItem,
        audioOptions: item.audioOptions,
      })
    }

    for (const item of ungrouped) {
      if (!groups.has(item.url)) {
        groups.set(item.url, { id: item.url, masterItem: item, variants: [] })
      }
    }

    // 对每个组的 variants 按带宽从高到低排序
    for (const group of groups.values()) {
      if (group.variants.length > 1) {
        group.variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
      }
    }

    // 分组卡片也必须跟随全局时间排序。使用组内最新资源时间，
    // 可避免先创建 master、后补充 variant 时排序看起来没有更新。
    const getGroupDetectedAt = (group: StreamGroup) => Math.max(
      group.masterItem.detectedAt ?? 0,
      ...group.variants.map(variant => variant.item.detectedAt ?? 0),
    )
    const direction = sortOrder.value === 'asc' ? 1 : -1
    return Array.from(groups.values()).sort(
      (a, b) => (getGroupDetectedAt(a) - getGroupDetectedAt(b)) * direction,
    )
  })

  const streamGroupHeights = shallowRef(new Map<string, number>())
  const streamGroupObservers = new Map<string, ResizeObserver>()
  const STREAM_GROUP_GAP = 6
  const STREAM_GROUP_BUFFER = 400

  const streamGroupLayout = computed(() => {
    let top = 8
    const items = groupedStreamList.value.map((group, index) => {
      const baseHeight = currentDensity.value === 'compact' ? 70 : 84
      const variantHeight = currentDensity.value === 'compact' ? 48 : 58
      const estimated = baseHeight + (expandedGroups.value.has(group.id) ? group.variants.length * variantHeight : 0)
      const height = streamGroupHeights.value.get(group.id) ?? estimated
      const entry = { group, index, top, height }
      top += height + STREAM_GROUP_GAP
      return entry
    })
    return { items, totalHeight: Math.max(0, top + 2) }
  })

  const virtualStreamGroups = computed(() => {
    if (activeTab.value !== 'stream') return []
    const start = scrollTop.value - STREAM_GROUP_BUFFER
    const end = scrollTop.value + containerHeight.value + STREAM_GROUP_BUFFER
    return streamGroupLayout.value.items.filter(entry => entry.top + entry.height > start && entry.top < end)
  })

  function observeStreamGroup(el: unknown, id: string) {
    streamGroupObservers.get(id)?.disconnect()
    streamGroupObservers.delete(id)
    if (!(el instanceof HTMLElement)) return
    const observer = new ResizeObserver(entries => {
      const height = Math.ceil(entries[0]?.contentRect.height ?? 0)
      if (!height || streamGroupHeights.value.get(id) === height) return
      const next = new Map(streamGroupHeights.value)
      next.set(id, height)
      streamGroupHeights.value = next
    })
    observer.observe(el)
    streamGroupObservers.set(id, observer)
  }

  const getPreferredStreamItem = (group: StreamGroup): MediaItem =>
    group.variants[0]?.item ?? group.masterItem

  const getRecommendedAudioUrl = (variant: StreamVariant): string | undefined =>
    variant.item.audioUrl || variant.audioItem?.url || variant.audioOptions?.[0]?.url

  const downloadStreamVariant = (variant: StreamVariant) => {
    const item = variant.item
    browser.runtime.sendMessage({
      type: 'OPEN_DOWNLOAD_PAGE',
      url: item.url,
      format: item.format,
      filename: getDownloadName(item.url),
      requestHeaders: item.requestHeaders,
      audioUrl: getRecommendedAudioUrl(variant),
    })
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  function reconcileMediaState() {
    const validKeys = new Set(mediaByKey.value.keys())
    selectedKeys.value = new Set([...selectedKeys.value].filter(key => validKeys.has(key)))
    if (playingKey.value && !validKeys.has(playingKey.value)) stopPlayback(playingKey.value)
    if (audioPlayingKey.value && !validKeys.has(audioPlayingKey.value)) stopAudioPlayback(audioPlayingKey.value)
  }

  function cancelMetadataBatch() {
    const taskId = activeMetadataTaskId
    if (!taskId) return
    activeMetadataTaskId = null
    browser.runtime.sendMessage({ type: 'CANCEL_MEDIA_METADATA_BATCH', taskId }).catch(() => {})
  }

  const loadMediaList = async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    const newTabId = tabs[0]?.id
    const newTabTitle = tabs[0]?.title || ''
    if (newTabId === undefined || newTabId === currentTabId) return
    cancelMetadataBatch()
    failedMetadataKeys.clear()
    const session = ++mediaSession
    currentTabId = newTabId
    currentTabTitle.value = newTabTitle
    const list = (await browser.runtime.sendMessage({ type: 'GET_LIST', tabId: newTabId })) as Array<{url: string, format: string}> | undefined
    if (session !== mediaSession || currentTabId !== newTabId) return
    replaceMediaList(list ?? [])
    reconcileMediaState()
    listLoaded.value = true
    fetchAllMetadataBatch(newTabId, session)
  }

  // 当 tab 标题变化时（页面刷新、跳转、SPA 路由变化等），同步更新 currentTabTitle
  const onTabUpdated = (tabId: number, changeInfo: { title?: string }) => {
    if (tabId !== currentTabId) return
    if (typeof changeInfo.title === 'string' && changeInfo.title && changeInfo.title !== currentTabTitle.value) {
      currentTabTitle.value = changeInfo.title
    }
  }

  const colorSchemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const onColorSchemeChange = () => {
    if (currentTheme.value === 'system') applyTheme('system')
  }

  onMounted(async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    currentTabId = tabs[0]?.id
    currentTabTitle.value = tabs[0]?.title || ''
    if (currentTabId === undefined) return
    const tabId = currentTabId
    const session = ++mediaSession
    const list = (await browser.runtime.sendMessage({ type: 'GET_LIST', tabId })) as Array<{url: string, format: string}> | undefined
    if (session !== mediaSession || currentTabId !== tabId) return
    replaceMediaList(list ?? [])
    listLoaded.value = true
    browser.runtime.onMessage.addListener(onMessage)

    const s = await loadSettings()
    settings.value = s
    excludeDomainsText.value = s.excludeDomains.join('\n')

    await loadAppearance()

    watch(currentTheme, (theme) => {
      applyTheme(theme)
      saveAppearance()
    })
    watch(currentLocale, () => {
      saveAppearance()
    })

    colorSchemeMediaQuery.addEventListener('change', onColorSchemeChange)

    fetchAllMetadataBatch(tabId, session)

    if (props.mode === 'sidepanel') {
      browser.tabs.onActivated.addListener(loadMediaList)
    }
    browser.tabs.onUpdated.addListener(onTabUpdated)

    nextTick(() => initContainerObserver())
    window.addEventListener('keydown', onPreviewKeydown)
  })

  watch(listContainerRef, (el) => {
    resetStreamThumbObserver()
    if (el) initContainerObserver()
  }, { flush: 'sync' })

  onUnmounted(() => {
    browser.runtime.onMessage.removeListener(onMessage)
    containerRO?.disconnect()
    allStreamGroupsRO?.disconnect()
    if (scrollFrameId !== null) cancelAnimationFrame(scrollFrameId)
    if (masonryFrameId !== null) cancelAnimationFrame(masonryFrameId)
    window.removeEventListener('keydown', onPreviewKeydown)
    document.removeEventListener('visibilitychange', onAudioVisibilityChange)
    colorSchemeMediaQuery.removeEventListener('change', onColorSchemeChange)
    if (props.mode === 'sidepanel') {
      browser.tabs.onActivated.removeListener(loadMediaList)
    }
    browser.tabs.onUpdated.removeListener(onTabUpdated)
    // 清理当前播放的视频/流媒体（释放 video src 和 hls/dash 实例）
    if (playingKey.value !== null) stopPlayback(playingKey.value)
    videoResizeObservers.forEach(ro => ro.disconnect())
    videoResizeObservers.clear()
    streamGroupObservers.forEach(observer => observer.disconnect())
    streamGroupObservers.clear()
    hlsInstances.value.forEach(hls => hls.destroy())
    hlsInstances.value.clear()
    dashInstances.value.forEach(dash => dash.destroy())
    dashInstances.value.clear()
    flvInstances.value.forEach(flv => { try { flv.destroy() } catch {} })
    flvInstances.value.clear()
    audioPlayers.forEach((_, index) => stopAudioPlayback(index))
    audioPlayers.clear()
    sharedAudioContext?.close().catch(() => {})
    sharedAudioContext = null
    if (saveTimer) clearTimeout(saveTimer)
    if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
    if (textSaveTimer) clearTimeout(textSaveTimer)
    cancelMetadataBatch()
    disposeMediaStore()
  })

  // ── Message handler ───────────────────────────────────────────────
  function onMessage(msg: ListUpdatedMessage) {
    handleListUpdate(msg)
  }

  async function clearCurrentList() {
    if (currentTabId === undefined) return
    cancelMetadataBatch()
    failedMetadataKeys.clear()
    await browser.runtime.sendMessage({ type: 'CLEAR_LIST', tabId: currentTabId })
    clearMediaStore()
    reconcileMediaState()
    imageLoadStatus.value.clear()
    videoDimensionCache.value.clear()
    audioDurationCache.value.clear()
  }
  async function refreshPage() {
    if (currentTabId === undefined) return
    await browser.tabs.reload(currentTabId)
  }

  async function closeSidebarForCurrentTab() {
    if (currentTabId === undefined) return
    await browser.runtime.sendMessage({ type: 'CLOSE_SIDEBAR_FOR_TAB', tabId: currentTabId })
  }

  // ── Helpers ───────────────────────────────────────────────────────
  const getFileName = (url: string): string => {
    try {
      // data: URL 无路径，用内容哈希生成短文件名
      if (url.startsWith('data:')) {
        let h = 0
        for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0
        return `image-${h.toString(36).slice(0, 8)}`
      }
      const pathname = new URL(url).pathname
      const last = decodeURIComponent(pathname.split('/').pop() || '') || url
      // CDN 路径往往直接是查询参数风格的串（如 "u=1410005327,4082018016&fm=3028..."）
      if (last.length > 48 || /[=?&]/.test(last)) {
        const extMatch = last.match(/\.(mp4|m3u8|webm|mov|m4v|mp3|m4a|ts|png|jpe?g|webp|gif|svg|pdf|mkv|avi|flv|ogg|wav|aac)(?=$|&|\?)/i)
        const ext = extMatch ? extMatch[1].toLowerCase() : ''
        // 用 URL hash 的前 6 位生成稳定短 id
        let h = 0
        for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0
        const short = h.toString(36).slice(0, 6)
        return ext ? `media-${short}.${ext}` : `media-${short}`
      }
      return last
    } catch {
      return url.split('/').pop() || url
    }
  }

  const getDomainLabel = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  const getRelativeTime = (ts?: number): string => {
    if (!ts) return ''
    const diff = Math.floor((Date.now() - ts) / 1000)
    if (diff < 5) return t('timeJustNow')
    if (diff < 60) return t('timeSecondsAgo', String(diff))
    if (diff < 3600) return t('timeMinutesAgo', String(Math.floor(diff / 60)))
    if (diff < 86400) return t('timeHoursAgo', String(Math.floor(diff / 3600)))
    return t('timeDaysAgo', String(Math.floor(diff / 86400)))
  }

  // ── 文件重命名：点击文件名编辑，下载时优先使用自定义名称 ──
  const customNames = ref<Map<string, string>>(new Map())
  const editingUrl = ref<string | null>(null)
  const editingName = ref('')
  // 自动聚焦指令
  const vFocus = { mounted: (el: HTMLInputElement) => { el.focus(); el.select() } }

  // 显示名：优先自定义 → tabTitle → currentTabTitle → getFileName（mse 特殊处理）
  const getDisplayName = (url: string, item: MediaItem): string => {
    const custom = customNames.value.get(url)
    if (custom) return custom
    if (item.format === 'mse') return item.url.split('mse://')[1] || 'MSE Stream'
    if (item.tabTitle) return item.tabTitle
    if (currentTabTitle.value) return currentTabTitle.value
    return getFileName(url)
  }

  const startRename = (url: string, fallback: string) => {
    editingUrl.value = url
    editingName.value = customNames.value.get(url) || fallback
  }

  const confirmRename = () => {
    const url = editingUrl.value
    const name = editingName.value.trim()
    if (url && name) {
      const next = new Map(customNames.value)
      next.set(url, name)
      customNames.value = next
    }
    editingUrl.value = null
    editingName.value = ''
  }

  const cancelRename = () => {
    editingUrl.value = null
    editingName.value = ''
  }

  interface HoverPreview {
    item: MediaItem
    rect: DOMRect
    above: boolean
    thumbDataUrl?: string
    coverUrl?: string
  }
  const hoverPreview = ref<HoverPreview | null>(null)
  let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null
  let hoverEnterTimer: ReturnType<typeof setTimeout> | null = null

  const PREVIEW_HEIGHT = 165
  const PREVIEW_DELAY = 120

  function resolvePreviewPosition(rect: DOMRect): { above: boolean } {
    const spaceBelow = window.innerHeight - rect.bottom - 6
    return { above: spaceBelow < PREVIEW_HEIGHT }
  }

  function captureVideoFrame(videoEl: HTMLVideoElement): string | undefined {
    try {
      if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return undefined
      const canvas = document.createElement('canvas')
      canvas.width = videoEl.videoWidth
      canvas.height = videoEl.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return undefined
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/jpeg', 0.8)
    } catch {
      return undefined
    }
  }

  function onCardHover(index: number, item: MediaItem, event: MouseEvent, coverUrl?: string) {
    if (!isVideoFormat(item.format) && !isImageFormat(item.format) && !isStreamFormat(item.format)) return
    if (hoverLeaveTimer) { clearTimeout(hoverLeaveTimer); hoverLeaveTimer = null }
    if (hoverEnterTimer) { clearTimeout(hoverEnterTimer); hoverEnterTimer = null }
    const target = event.currentTarget as HTMLElement
    hoverEnterTimer = setTimeout(() => {
      const rect = target.getBoundingClientRect()
      const { above } = resolvePreviewPosition(rect)
      let thumbDataUrl: string | undefined
      if (item.format === 'm3u8' || item.format === 'mpd') {
        // 优先读取已缓存的截帧（切换 tab 后 DOM 重建，也能显示）
        thumbDataUrl = touchStreamThumb(item.url)
        if (!thumbDataUrl) {
          const videoEl = document.getElementById(`stream-thumb-${index}`) as HTMLVideoElement | null
          if (videoEl) {
            thumbDataUrl = captureVideoFrame(videoEl)
            if (thumbDataUrl) {
              cacheStreamThumb(item.url, thumbDataUrl)
            }
          }
        }
      }
      hoverPreview.value = {
        item,
        rect,
        above,
        thumbDataUrl,
        coverUrl: coverUrl || item.coverUrl,
      }
      hoverEnterTimer = null
    }, PREVIEW_DELAY)
  }

  function onCardLeave() {
    if (hoverEnterTimer) { clearTimeout(hoverEnterTimer); hoverEnterTimer = null }
    hoverLeaveTimer = setTimeout(() => { hoverPreview.value = null }, 80)
  }

  // 下载文件名：优先自定义名称，否则用当前标签页标题
  const getDownloadName = (url: string): string => {
    const custom = customNames.value.get(url)
    if (custom) return sanitizeFilename(custom)
    return sanitizeFilename(currentTabTitle.value)
  }

  // stream 分组的重命名 key/item（虚拟组用首个 variant 的真实流）
  const getGroupRenameUrl = (group: StreamGroup): string => {
    return group.isVirtual && group.variants.length > 0 ? group.variants[0].item.url : group.masterItem.url
  }
  const getGroupRenameItem = (group: StreamGroup): MediaItem => {
    return group.isVirtual && group.variants.length > 0 ? group.variants[0].item : group.masterItem
  }

  // 获取分组的估算大小：master entry 上有就返回；分离流（virtual）退回到首个 variant 的 size
  const getGroupEstimatedSize = (group: StreamGroup): number | undefined => {
    if (group.masterItem.size && group.masterItem.size > 0) return group.masterItem.size
    if (group.isVirtual && group.variants.length > 0 && group.variants[0].item.size) {
      return group.variants[0].item.size
    }
    return undefined
  }

  // 封面缩略图对应的条目：真实 master 直接用自身；分离流（virtual）用首个 variant 的真实流
  const getStreamThumbItem = (group: StreamGroup): MediaItem => {
    if (group.isVirtual && group.variants.length > 0) return group.variants[0].item
    return group.masterItem
  }

  const getStreamDuration = (group: StreamGroup): number | undefined =>
    group.masterItem.duration ?? getStreamThumbItem(group).duration


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

  const { viewOf: mediaView } = useMediaViewModels<MediaItem>({
    mediaList,
    getKey: getMediaKey,
    getType: getMediaType,
    getFileName,
  })

  const getFormatLabel = (format: string): string => {
    if (!format) return t('unknown')
    const map: Record<string, string> = {
      m3u8: 'HLS', mpd: 'DASH', mse: 'MSE', mp4: 'MP4', mp3: 'MP3', webm: 'WebM', m4a: 'M4A',
      oga: 'OGA', weba: 'WEBA', wav: 'WAV', flac: 'FLAC', aac: 'AAC', ogg: 'OGG',
      mkv: 'MKV', avi: 'AVI', mov: 'MOV', flv: 'FLV', ogv: 'OGV', ts: 'TS',
      '3gp': '3GP', '3g2': '3G2', mpeg: 'MPEG', m4v: 'M4V',
      gif: 'GIF', jpg: 'JPG', jpeg: 'JPEG', png: 'PNG', webp: 'WebP', svg: 'SVG',
      bmp: 'BMP', ico: 'ICO', avif: 'AVIF', tiff: 'TIFF',
      pdf: 'PDF', doc: 'DOC', docx: 'DOCX', xls: 'XLS', xlsx: 'XLSX', ppt: 'PPT', pptx: 'PPTX',
      epub: 'EPUB', csv: 'CSV', rtf: 'RTF',
      srt: 'SRT', vtt: 'VTT', ass: 'ASS', ssa: 'SSA', ttml: 'TTML',
    }
    return map[format.toLowerCase()] || format.toUpperCase()
  }

  const getFormatColor = (format: string): string => {
    if (!format) return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
    const map: Record<string, string> = {
      m3u8: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
      mpd: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      mse: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
      mp4: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      mp3: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      webm: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      m4a: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
      oga: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-300',
      weba: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
      wav: 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
      flac: 'bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300',
      aac: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
      ogg: 'bg-lime-100 text-lime-700 dark:bg-lime-900 dark:text-lime-300',
      mkv: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
      avi: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      mov: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
      flv: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
      ogv: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-300',
      ts: 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300',
      '3gp': 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      '3g2': 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      mpeg: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      m4v: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      gif: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
      jpg: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      jpeg: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
      png: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      webp: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
      svg: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
      bmp: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
      ico: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
      avif: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
      tiff: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
      pdf: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
      doc: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      docx: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
      xls: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      xlsx: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
      ppt: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      pptx: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
      srt: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      vtt: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      ass: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      ssa: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      ttml: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
      epub: 'bg-lime-100 text-lime-700 dark:bg-lime-900 dark:text-lime-300',
      csv: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
      rtf: 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300',
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

  // ── 流媒体缩略图（m3u8/mpd）：用 hls.js/dashjs 加载首帧 ──────────
  // hls.js 通过 fetch 加载分片（不受 video crossorigin 限制），
  // video 元素不设 crossorigin 可以显示跨域视频帧 + 读取 duration
  const {
    cache: streamThumbCache,
    failed: streamThumbFailed,
    touch: touchStreamThumb,
    store: cacheStreamThumb,
    observe: observeStreamThumb,
    resetObserver: resetStreamThumbObserver,
  } = useStreamThumbnails<MediaItem>({
    mediaList,
    mediaByUrl,
    listContainerRef,
    patchDuration: (item, duration) => patchMediaItem(getMediaKey(item), { duration }),
    persistMeta: updateMediaMeta,
    captureFrame: captureVideoFrame,
  })
  const isVideoFormat = (f: string) => VIDEO_FORMATS.includes(f.toLowerCase())
  const isImageFormat = (f: string) => IMAGE_FORMATS.includes(f.toLowerCase())
  const isAudioFormat = (f: string) => AUDIO_FORMATS.includes(f.toLowerCase())

  // 所有视频格式都尝试用 <video> 加载首帧（不设 crossorigin，跨域也能加载；
  // 浏览器不支持的格式会触发 @error，自动 fallback 到图标）
  const videoThumbFailed = ref<Set<string>>(new Set())
  // 音频用 <audio> 读取 duration（不显示画面，只取时长）
  const audioMetaFailed = ref<Set<string>>(new Set())

  const pendingBatchKeys = new Set<string>()
  // 会话级失败记忆：元数据请求返回 error 的资源加入此集合，同一会话不再重试
  // 避免 LIST_UPDATED 广播反复触发 fetchAllMetadataBatch 让坏 URL 反复进请求队列
  // 切换 tab / 手动刷新页面会清空（会话变化）
  const failedMetadataKeys = new Set<string>()
  const METADATA_BATCH_SIZE = 200

  const fetchAllMetadataBatch = async (tabId = currentTabId, session = mediaSession) => {
    if (tabId === undefined) return
    const requests = mediaList.value.flatMap(item => {
      const key = getMediaKey(item)
      const requestKey = `${session}:${key}`
      // 会话内已失败的资源跳过，不再发起元数据请求
      if (failedMetadataKeys.has(key)) return []
      const needMediaInfo = (
        (isVideoFormat(item.format) && (!item.width || !item.height || !item.duration))
        || (isAudioFormat(item.format) && !item.duration)
        || ((item.format === 'm3u8' || item.format === 'mpd' || item.format === 'flv') && !item.duration)
      )
      const needSize = !item.size
        && !isStreamFormat(item.format)
        && item.format !== 'mse'
        && !!item.url
        && !item.url.startsWith('blob:')
        && !item.url.startsWith('data:')
      if ((!needMediaInfo && !needSize) || pendingBatchKeys.has(requestKey)) return []
      pendingBatchKeys.add(requestKey)
      return [{ key, requestKey, url: item.url, format: item.format, requestHeaders: item.requestHeaders, needMediaInfo, needSize }]
    })
    if (!requests.length) return

    cancelMetadataBatch()
    const taskId = `metadata:${tabId}:${session}:${++metadataTaskSequence}`
    const removedKeys = new Set<string>()
    const metadataPatches = new Map<string, Partial<MediaItem>>()
    try {
      for (let offset = 0; offset < requests.length; offset += METADATA_BATCH_SIZE) {
        const chunk = requests.slice(offset, offset + METADATA_BATCH_SIZE)
        const message: MetadataBatchRequest = {
          type: 'GET_MEDIA_METADATA_BATCH',
          taskId,
          tabId,
          items: chunk.map(({ requestKey: _requestKey, ...item }) => item),
        }
        const response = await browser.runtime.sendMessage(message) as MetadataBatchResponse
        if (session !== mediaSession || tabId !== currentTabId) return
        if (!response?.ok || !Array.isArray(response.items)) continue
        for (const result of response.items) {
          if (result.removed) {
            removedKeys.add(result.key)
            // background 端已剔除并拉黑：会话内不再重试
            failedMetadataKeys.add(result.key)
            continue
          }
          // 请求异常（未 removed 但有 error）：记入会话失败集合，避免反复重试
          // 注意：只有真正报错的才记，size 拿不到（size=undefined）不算失败
          if (result.error && result.width === undefined && result.height === undefined && result.duration === undefined && result.size === undefined) {
            failedMetadataKeys.add(result.key)
            continue
          }
          if (!mediaIndexByKey.value.has(result.key)) continue
          const patch: Partial<MediaItem> = {}
          if (typeof result.width === 'number') patch.width = result.width
          if (typeof result.height === 'number') patch.height = result.height
          if (typeof result.duration === 'number') patch.duration = result.duration
          if (typeof result.size === 'number') patch.size = result.size
          if (Object.keys(patch).length) metadataPatches.set(result.key, patch)
        }
      }
      patchMediaItems(metadataPatches)
      if (removedKeys.size > 0) {
        mediaList.value = mediaList.value.filter(item => !removedKeys.has(getMediaKey(item)))
        reconcileMediaState()
      }
    } finally {
      if (activeMetadataTaskId === taskId) activeMetadataTaskId = null
      requests.forEach(request => pendingBatchKeys.delete(request.requestKey))
    }
  }
  const formatDuration = (seconds?: number): string => {
    if (seconds === undefined || !isFinite(seconds) || seconds < 0) return ''
    // Metadata commonly reports 324.999… for a 5:25 asset.  Display the
    // nearest whole second instead of systematically showing one second less.
    const total = Math.round(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
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
  const stopAudioPlayback = (key: string) => {
    const state = audioPlayers.get(key)
    if (state) {
      cancelAnimationFrame(state.animFrameId)
      const audioEl = document.getElementById(`audio-player-${getDomIdFromMediaKey(key)}`) as HTMLAudioElement | null
      if (audioEl) { audioEl.pause(); audioEl.src = '' }
      state.source.disconnect()
      state.analyser.disconnect()
      audioPlayers.delete(key)
    }
    if (audioPlayingKey.value === key) audioPlayingKey.value = null
  }

  const supportsRoundRect = typeof CanvasRenderingContext2D !== 'undefined' && typeof CanvasRenderingContext2D.prototype.roundRect === 'function'

  const drawSpectrum = (key: string, analyser: AnalyserNode) => {
    const canvas = document.getElementById(`spectrum-${getDomIdFromMediaKey(key)}`) as HTMLCanvasElement | null
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    const W = canvas.width
    const H = canvas.height
    const draw = () => {
      const state = audioPlayers.get(key)
      if (!state) return
      if (document.hidden || !canvas.isConnected) { state.animFrameId = 0; return }
      state.animFrameId = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)
      ctx.clearRect(0, 0, W, H)
      const barCount = 36
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

  const startAudioPlayback = async (key: string) => {
    await nextTick()
    const audioEl = document.getElementById(`audio-player-${getDomIdFromMediaKey(key)}`) as HTMLAudioElement | null
    if (!audioEl) return
    try {
      const audioCtx = sharedAudioContext ??= new AudioContext()
      // 浏览器自动播放策略：AudioContext 默认 suspended，必须 resume。
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume().catch(() => {})
      }
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.8
      const source = audioCtx.createMediaElementSource(audioEl)
      if (supportsRoundRect) {
        source.connect(analyser)
        analyser.connect(audioCtx.destination)
        audioPlayers.set(key, { analyser, source, animFrameId: 0 })
        audioEl.play().catch(() => {})
        drawSpectrum(key, analyser)
      } else {
        source.connect(audioCtx.destination)
        audioPlayers.set(key, { analyser, source, animFrameId: 0 })
        audioEl.play().catch(() => {})
      }
    } catch (e) {
      console.warn('[startAudioPlayback] failed:', e)
      showToastMsg(t('audioPlayError'))
    }
  }

  const onAudioVisibilityChange = () => {
    if (document.hidden) {
      audioPlayers.forEach(state => {
        if (state.animFrameId) cancelAnimationFrame(state.animFrameId)
        state.animFrameId = 0
      })
      sharedAudioContext?.suspend().catch(() => {})
    } else {
      sharedAudioContext?.resume().catch(() => {})
      audioPlayers.forEach((state, key) => {
        if (!state.animFrameId) drawSpectrum(key, state.analyser)
      })
    }
  }
  document.addEventListener('visibilitychange', onAudioVisibilityChange)

  watch(virtualList, current => {
    const key = audioPlayingKey.value
    if (key && !current.items.some(({ item }) => getMediaKey(item) === key)) stopAudioPlayback(key)
  })

  watch(activeTab, () => {
    showFilter.value = false
    typeFilter.value = 'any'
    sizeFilter.value = { min: 0, max: 0 }
    dimensionFilter.value = { minWidth: 0, minHeight: 0 }
    resolutionFilter.value = 'any'
    selectedKeys.value.clear()
  })

  watch(audioPlayingKey, async (newId, oldId) => {
    if (oldId !== null && oldId !== newId) stopAudioPlayback(oldId)
    if (newId === null) return
    await startAudioPlayback(newId)
  })

  // ── Playback ──────────────────────────────────────────────────────
  // 判断某个条目是否正在播放（视频/流媒体用 playingKey，音频用 audioPlayingKey）。
  const isItemPlaying = (item: MediaItem): boolean => {
    const key = getMediaKey(item)
    if ((isStreamFormat(item.format) && item.format !== 'mse') || isVideoFormat(item.format)) {
      return playingKey.value === key
    }
    if (isAudioFormat(item.format)) {
      return audioPlayingKey.value === key
    }
    return false
  }

  const playUrl = (url: string, format: string, item?: MediaItem) => {
    if (format === 'mse') {
      if (item?.captureId) downloadUrl(url, 'mse', undefined, item.captureId)
      return
    }
    const key = getMediaKey(item ?? { url, format })
    if (isStreamFormat(format) || isVideoFormat(format)) {
      if (playingKey.value === key) stopPlayback(key)
      else {
        if (playingKey.value !== null) stopPlayback(playingKey.value)
        playingKey.value = key
      }
    } else if (isAudioFormat(format)) {
      if (audioPlayingKey.value === key) stopAudioPlayback(key)
      else {
        if (audioPlayingKey.value !== null) stopAudioPlayback(audioPlayingKey.value)
        audioPlayingKey.value = key
      }
    } else if (isImageFormat(format)) {
      previewImage(url)
    } else {
      browser.tabs.create({ url })
    }
  }

  const stopPlayback = (key: string) => {
    // 先停止并清空媒体节点，再销毁播放库，确保所有播放类型都释放画面与网络请求。
    const videoEl = document.getElementById(`video-player-${getDomIdFromMediaKey(key)}`) as HTMLVideoElement | null
    if (videoEl) {
      videoEl.pause()
      videoEl.onencrypted = null
      videoEl.removeAttribute('src')
      videoEl.load()
    }
    const hls = hlsInstances.value.get(key)
    if (hls) { hls.destroy(); hlsInstances.value.delete(key) }
    const dash = dashInstances.value.get(key)
    if (dash) { dash.destroy(); dashInstances.value.delete(key) }
    const flv = flvInstances.value.get(key)
    if (flv) { try { flv.destroy() } catch {}; flvInstances.value.delete(key) }
    stopSeparatedAudioPlayback(key)
    const ro = videoResizeObservers.get(key)
    if (ro) { ro.disconnect(); videoResizeObservers.delete(key) }

    const ehNext = new Map(expandedHeights.value)
    ehNext.delete(key)
    expandedHeights.value = ehNext
    // Stream 分组高度由 ResizeObserver 缓存；关闭播放器时立即失效，避免保留展开高度。
    streamGroupHeights.value = new Map()
    if (playingKey.value === key) playingKey.value = null
  }

  // 播放器只属于启动它的媒体标签。切换分类时立即销毁实例，
  // 避免同一个 playingKey 在其他标签的同名 DOM 节点上继续挂载。
  watch(activeTab, (newTab, oldTab) => {
    if (newTab === oldTab) return
    if (playingKey.value !== null) stopPlayback(playingKey.value)
    if (audioPlayingKey.value !== null) stopAudioPlayback(audioPlayingKey.value)
  })

  async function getPlaybackContext(item: MediaItem): Promise<{ referrer: string; drm: boolean }> {
    const tabUrl = currentTabId === undefined
      ? undefined
      : (await browser.tabs.get(currentTabId).catch(() => undefined))?.url
    const referrer = item.requestHeaders?.referer || item.requestHeaders?.Referer || tabUrl || ''
    const response = await browser.runtime.sendMessage({
      type: 'PREPARE_MEDIA_PLAYBACK',
      url: item.url,
      format: item.format,
      referrer,
      requestHeaders: item.requestHeaders,
    }).catch(() => undefined) as { ok?: boolean; drm?: boolean } | undefined
    return { referrer, drm: response?.drm === true }
  }

  const getPreviewAudioUrl = (item: MediaItem): string | undefined =>
    item.audioUrl || item.audioOptions?.[0]?.url

  function stopSeparatedAudioPlayback(key: string) {
    const player = separatedAudioPlayers.get(key)
    if (!player) return
    player.dispose()
    separatedAudioPlayers.delete(key)
  }

  async function attachSeparatedAudioPlayback(key: string, videoEl: HTMLVideoElement, item: MediaItem) {
    const audioUrl = getPreviewAudioUrl(item)
    if (!audioUrl || separatedAudioPlayers.has(key)) return

    // Install the same Referer/CORS rules for the audio CDN URL before the
    // browser starts fetching it.
    const audioItem = { ...item, url: audioUrl }
    await getPlaybackContext(audioItem)
    if (playingKey.value !== key || !videoEl.isConnected || separatedAudioPlayers.has(key)) return

    const audioEl = document.createElement('audio')
    audioEl.preload = 'auto'
    audioEl.src = audioUrl

    const syncTime = () => {
      if (Math.abs(audioEl.currentTime - videoEl.currentTime) > 0.18) {
        audioEl.currentTime = videoEl.currentTime
      }
    }
    const syncPlay = () => {
      syncTime()
      audioEl.play().catch(() => {})
    }
    const syncPause = () => audioEl.pause()
    const syncRate = () => { audioEl.playbackRate = videoEl.playbackRate }
    const onAudioError = () => {
      // Keep the picture playable if an optional separate audio track fails.
      console.warn('[FlowPick] separated preview audio failed:', audioUrl)
    }
    videoEl.addEventListener('play', syncPlay)
    videoEl.addEventListener('pause', syncPause)
    videoEl.addEventListener('seeking', syncTime)
    videoEl.addEventListener('timeupdate', syncTime)
    videoEl.addEventListener('ratechange', syncRate)
    audioEl.addEventListener('error', onAudioError)
    separatedAudioPlayers.set(key, {
      element: audioEl,
      dispose: () => {
        videoEl.removeEventListener('play', syncPlay)
        videoEl.removeEventListener('pause', syncPause)
        videoEl.removeEventListener('seeking', syncTime)
        videoEl.removeEventListener('timeupdate', syncTime)
        videoEl.removeEventListener('ratechange', syncRate)
        audioEl.removeEventListener('error', onAudioError)
        audioEl.pause()
        audioEl.removeAttribute('src')
        audioEl.load()
      },
    })
    syncRate()
    if (!videoEl.paused) syncPlay()
  }

  watch(playingKey, async (newId, oldId) => {
    if (oldId !== null && oldId !== newId) {
      const oldHls = hlsInstances.value.get(oldId)
      if (oldHls) { oldHls.destroy(); hlsInstances.value.delete(oldId) }
      const oldDash = dashInstances.value.get(oldId)
      if (oldDash) { oldDash.destroy(); dashInstances.value.delete(oldId) }
      const oldFlv = flvInstances.value.get(oldId)
      if (oldFlv) { try { oldFlv.destroy() } catch {}; flvInstances.value.delete(oldId) }
      stopSeparatedAudioPlayback(oldId)
      // 清理旧的 ResizeObserver
      const oldRO = videoResizeObservers.get(oldId)
      if (oldRO) { oldRO.disconnect(); videoResizeObservers.delete(oldId) }
      const ehNext = new Map(expandedHeights.value)
      ehNext.delete(oldId)
      expandedHeights.value = ehNext
    }
    if (newId === null) return
    await nextTick()
    const item = mediaByKey.value.get(newId)
    if (!item) return
    const videoEl = document.getElementById(`video-player-${getDomIdFromMediaKey(newId)}`) as HTMLVideoElement | null
    if (!videoEl) return
    // Manifest 预检之外再监听 EME，覆盖普通 MP4/WebM init data 中的 DRM。
    videoEl.onencrypted = () => {
      if (playingKey.value !== newId) return
      showToastMsg(t('drmProtected'))
      stopPlayback(newId)
    }    // 创建 ResizeObserver 监听视频实际高度，实现展开高度自适应
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h && h > 0) {
        const next = new Map(expandedHeights.value)
        // 24 = px-3(12) + pb-3(12)
        next.set(newId, Math.round(h) + 24)
        expandedHeights.value = next
      }
    })
    ro.observe(videoEl)
    videoResizeObservers.set(newId, ro)
    const format = item.format.toLowerCase()
    if (format === 'm3u8') {
      try {
        const Hls = await loadHls()
        if (playingKey.value !== newId || !videoEl.isConnected) return
        if (!Hls.isSupported()) {
          // 原生 HLS 作为不支持 MSE 的最后兜底；其失败无法注入自定义请求头。
          if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = item.url
            videoEl.play().catch(() => showToastMsg(t('unplayable')))
          } else {
            showToastMsg(t('unplayable'))
          }
          return
        }

        const { referrer } = await getPlaybackContext(item)

        let proxyFallbackStarted = false

        const startHlsPlayback = (useProxy: boolean) => {
          if (playingKey.value !== newId || !videoEl.isConnected) return
          const previous = hlsInstances.value.get(newId)
          if (previous) previous.destroy()
          videoEl.pause()
          videoEl.removeAttribute('src')
          videoEl.load()

          const hls = new Hls({
            enableWorker: true,
            backBufferLength: 90,
            ...(useProxy ? {
              loader: createHlsProxyLoader({
                requestHeaders: item.requestHeaders,
                referrer,
              }),
            } : {}),
          })
          hlsInstances.value.set(newId, hls)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (hlsInstances.value.get(newId) === hls) videoEl.play().catch(() => {})
          })
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || hlsInstances.value.get(newId) !== hls) return
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !useProxy && !proxyFallbackStarted) {
              proxyFallbackStarted = true
              // 直连遇到 CORS、403 或防盗链时，自动切换到后台代理。
              queueMicrotask(() => startHlsPlayback(true))
              return
            }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad()
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError()
            } else {
              stopPlayback(newId)
              showToastMsg(t('playError') + data.details)
            }
          })
          hls.loadSource(item.url)
          hls.attachMedia(videoEl)
        }

        startHlsPlayback(false)
      } catch {
        if (playingKey.value === newId) showToastMsg(t('unplayable'))
      }
    } else if (format === 'mpd') {
      try {
        const playbackContext = await getPlaybackContext(item)
        if (playingKey.value !== newId || !videoEl.isConnected) return
        if (playbackContext.drm) {
          showToastMsg(t('drmProtected'))
          stopPlayback(newId)
          return
        }
        const dashjs = await loadDash()
        if (playingKey.value !== newId || !videoEl.isConnected) return
        const dash = dashjs.MediaPlayer().create()
        dashInstances.value.set(newId, dash)
        dash.initialize(videoEl, item.url, false)
        dash.on(dashjs.MediaPlayer.events.ERROR, (e: any) => {
          if (e.error) {
            showToastMsg(t('playError') + (e.error.message || 'Unknown error'))
            stopPlayback(newId)
          }
        })
        dash.play()
      } catch {
        if (playingKey.value === newId) showToastMsg(t('unplayable'))
      }
    } else if (format === 'flv' || format === 'ts') {
      // HTTP-FLV / MPEG-TS：用 mpegts.js demux → MSE 喂给 <video>
      try {
        const mts = await loadMpegts()
        if (playingKey.value !== newId || !videoEl.isConnected) return
        if (!mpegts.isSupported()) {
          showToastMsg(t('unplayable'))
          return
        }
        const { referrer } = await getPlaybackContext(item)
        if (playingKey.value !== newId || !videoEl.isConnected) return
        const player = mts.createPlayer({
          type: format === 'ts' ? 'mpegts' : 'flv',
          url: item.url,
          isLive: !item.duration, // 无 duration 视为直播流
        }, {
          enableWorker: true,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
          headers: item.requestHeaders ?? {},
          referer: referrer,
        })
        flvInstances.value.set(newId, player)
        player.on(mpegts.Events.ERROR, (_type, _detail) => {
          if (playingKey.value !== newId) return
          showToastMsg(t('playError') + (typeof _detail === 'string' ? _detail : ''))
          stopPlayback(newId)
        })
        player.on(mpegts.Events.LOADING_COMPLETE, () => {
          // VOD 流加载完成
        })
        player.attachMediaElement(videoEl)
        player.load()
        videoEl.play().catch(() => {})
      } catch {
        if (playingKey.value === newId) showToastMsg(t('unplayable'))
      }
    } else {
      // 后台先安装目标主机的 Referer/认证/CORS 规则；video 元素随后按需发起标准 Range 请求。
      const playbackContext = await getPlaybackContext(item)
      if (playingKey.value !== newId || !videoEl.isConnected) return
      if (playbackContext.drm) {
        showToastMsg(t('drmProtected'))
        stopPlayback(newId)
        return
      }
      // Direct MP4 variants can be video-only DASH tracks (notably Bilibili).
      // Start their associated audio track before the visible video begins.
      await attachSeparatedAudioPlayback(newId, videoEl, item)
      if (playingKey.value !== newId || !videoEl.isConnected) return
      videoEl.src = item.url
      videoEl.play().catch(() => {})
    }  })

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => showToastMsg(t('copyTips')))
  }

  const previewImage = (url: string) => {
    const idx = filteredImageList.value.findIndex(item => item.url === url)
    previewImageIndex.value = idx
    previewImageUrl.value = url
  }

  const previewPrev = () => {
    const list = filteredImageList.value
    if (!list.length) return
    const idx = Math.max(0, previewImageIndex.value - 1)
    previewImageIndex.value = idx
    previewImageUrl.value = list[idx].url
  }

  const previewNext = () => {
    const list = filteredImageList.value
    if (!list.length) return
    const idx = Math.min(list.length - 1, previewImageIndex.value + 1)
    previewImageIndex.value = idx
    previewImageUrl.value = list[idx].url
  }

  const closePreview = () => {
    previewImageUrl.value = ''
    previewImageIndex.value = -1
  }

  function onPreviewKeydown(e: KeyboardEvent) {
    if (!previewImageUrl.value) return
    if (e.key === 'ArrowLeft') { e.preventDefault(); previewPrev() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); previewNext() }
    else if (e.key === 'Escape') closePreview()
  }

  const onImageLoad = (event: Event, url: string) => {
    const img = event.target as HTMLImageElement
    if (img.naturalWidth && img.naturalHeight) {
      const item = mediaByUrl.value.get(url)
      if (item && (!item.width || !item.height)) {
        patchMediaItem(getMediaKey(item), { width: img.naturalWidth, height: img.naturalHeight })
      }
    }
    imageLoadStatus.value.set(url, true)
  }

  // Image elements cannot attach the captured Referer/Cookie headers.  Keep
  // the fast direct path, then retry through the background proxy when a CDN
  // rejects the extension popup request with hotlink protection.
  const proxiedImageUrls = ref<Map<string, string>>(new Map())
  const proxyingImageUrls = new Set<string>()
  const failedProxyImageUrls = new Set<string>()
  const PROXY_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

  function decodeProxyImage(data: string): ArrayBuffer {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let offset = 0; offset < binary.length; offset += 32768) {
      const end = Math.min(offset + 32768, binary.length)
      for (let i = offset; i < end; i++) bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }

  const shouldProxyImage = (requestHeaders?: Record<string, string>) => {
    if (!requestHeaders || typeof requestHeaders !== 'object') return false
    return Boolean(requestHeaders.Referer || requestHeaders.referer)
  }

  const fetchProxiedImage = async (url: string, requestHeaders?: Record<string, string>): Promise<string | undefined> => {
    const cached = proxiedImageUrls.value.get(url)
    if (cached) return cached
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || failedProxyImageUrls.has(url)) return undefined
    if (proxyingImageUrls.has(url)) return undefined
    proxyingImageUrls.add(url)
    try {
      const tabUrl = currentTabId === undefined
        ? ''
        : ((await browser.tabs.get(currentTabId).catch(() => undefined))?.url || '')
      const headers = requestHeaders && typeof requestHeaders === 'object' ? requestHeaders : undefined
      const referrer = headers?.Referer || headers?.referer || tabUrl
      const response = await browser.runtime.sendMessage({
        type: 'PROXY_FETCH',
        url,
        options: { authHeaders: headers, referrer, proxyHeader: true },
      }) as { ok?: boolean; data?: string; headers?: Record<string, string> } | undefined
      if (!response?.ok || !response.data) throw new Error('proxy image request failed')
      const contentType = response.headers?.['content-type'] || response.headers?.['Content-Type'] || 'image/*'
      if (!contentType.toLowerCase().startsWith('image/')) throw new Error('not an image response')
      const blobUrl = URL.createObjectURL(new Blob([decodeProxyImage(response.data)], { type: contentType }))
      const next = new Map(proxiedImageUrls.value)
      next.set(url, blobUrl)
      proxiedImageUrls.value = next
      return blobUrl
    } catch {
      failedProxyImageUrls.add(url)
      return undefined
    } finally {
      proxyingImageUrls.delete(url)
    }
  }

  const imageSrc = (url: string, requestHeaders?: Record<string, string>) => {
    const cached = proxiedImageUrls.value.get(url)
    if (cached) return cached
    if (shouldProxyImage(requestHeaders) && !failedProxyImageUrls.has(url)) {
      void fetchProxiedImage(url, requestHeaders)
      // Do not start a slow direct request while the authenticated proxy load
      // is in flight; the reactive map swaps this for the Blob URL on success.
      return PROXY_IMAGE_PLACEHOLDER
    }
    return url
  }

  const proxyImage = async (event: Event, url: string, requestHeaders?: Record<string, string>) => {
    const img = event.target as HTMLImageElement
    if (!img || !url || url.startsWith('data:') || url.startsWith('blob:')) {
      imageLoadStatus.value.set(url, false)
      return
    }
    const cached = proxiedImageUrls.value.get(url)
    if (cached) {
      img.src = cached
      return
    }
    try {
      const blobUrl = await fetchProxiedImage(url, requestHeaders)
      if (!blobUrl) throw new Error('proxy image request failed')
      img.src = blobUrl
      imageLoadStatus.value.set(url, true)
    } catch {
      imageLoadStatus.value.set(url, false)
    }
  }

  const onPreviewImageError = (event: Event) => {
    const item = previewCurrentItem.value
    void proxyImage(event, previewImageUrl.value, item?.requestHeaders)
  }

  const downloadProtectedResource = async (
    url: string,
    format: string,
    requestHeaders?: Record<string, string>,
    filename?: string,
    resourceKind: 'image' | 'audio' | 'document' = 'document',
  ) => {
    try {
      const tabUrl = currentTabId === undefined
        ? ''
        : ((await browser.tabs.get(currentTabId).catch(() => undefined))?.url || '')
      const headers = requestHeaders && typeof requestHeaders === 'object' ? requestHeaders : undefined
      const referrer = headers?.Referer || headers?.referer || tabUrl
      const response = await browser.runtime.sendMessage({
        type: 'PROXY_FETCH',
        url,
        options: { authHeaders: headers, referrer, proxyHeader: true },
      }) as { ok?: boolean; status?: number; data?: string; headers?: Record<string, string> } | undefined
      if (!response?.ok || !response.data) throw new Error(`HTTP ${response?.status || 0}`)
      const contentType = response.headers?.['content-type'] || response.headers?.['Content-Type'] || ''
      // A hotlink-protection page may return HTTP 200. Never save that HTML
      // response under an image extension.
      const normalizedType = contentType.toLowerCase()
      const typeMatches = resourceKind === 'image'
        ? normalizedType.startsWith('image/')
        : resourceKind === 'audio'
          ? normalizedType.startsWith('audio/') || normalizedType === 'application/ogg'
          : true
      if (normalizedType === 'text/html' || !typeMatches) {
        throw new Error('unexpected protected resource response')
      }
      const blob = new Blob([decodeProxyImage(response.data)], {
        type: contentType || (resourceKind === 'image'
          ? `image/${format.toLowerCase() === 'jpg' ? 'jpeg' : format.toLowerCase()}`
          : resourceKind === 'audio' ? `audio/${format.toLowerCase()}` : 'application/octet-stream'),
      })
      const blobUrl = URL.createObjectURL(blob)
      await browser.downloads.download({ url: blobUrl, filename: filename || getDownloadFilename(url, format) })
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
      showToastMsg(t('docDownloadStarted'))
    } catch {
      showToastMsg(t('docDownloadFailed'))
    }
  }

  // 视频缩略图：loadeddata 后 seek 到 0.1s 显示首帧，同时读取 duration
  // 不设 crossorigin 属性，跨域视频也能正常加载和显示
  const onVideoThumbLoaded = (event: Event, item: MediaItem) => {
    const video = event.target as HTMLVideoElement
    try {
      const patch: Partial<MediaItem> = {}
      if (isFinite(video.duration) && video.duration > 0 && !item.duration) {
        patch.duration = video.duration
      }
      if (video.videoWidth && video.videoHeight && (!item.width || !item.height)) {
        patch.width = video.videoWidth
        patch.height = video.videoHeight
      }
      if (Object.keys(patch).length) {
        const updated = patchMediaItem(getMediaKey(item), patch)
        if (updated) updateMediaMeta(updated)
      }
      if (video.readyState >= 2 && Math.abs(video.currentTime - 0.1) > 0.05) {
        video.currentTime = 0.1
      }
    } catch {}
  }

  const onVideoThumbError = (url: string) => {
    const next = new Set(videoThumbFailed.value)
    next.add(url)
    videoThumbFailed.value = next
  }

  // 音频 duration 读取：<audio preload="metadata"> 加载元数据后 duration 可用
  const onAudioMetaLoaded = (event: Event, item: MediaItem) => {
    const audio = event.target as HTMLAudioElement
    try {
      if (isFinite(audio.duration) && audio.duration > 0 && !item.duration) {
        const updated = patchMediaItem(getMediaKey(item), { duration: audio.duration })
        if (updated) updateMediaMeta(updated)
      }
    } catch {}
  }

  const onAudioMetaError = (url: string) => {
    const next = new Set(audioMetaFailed.value)
    next.add(url)
    audioMetaFailed.value = next
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

  // ── 直播流录制（HTTP-FLV/MPEG-TS）──────────────────────────────
  // 直播流无 Content-Length/Duration，不能跳 test-web 下载页。
  // 用 fetch 持续读流到内存 chunks，用户点"停止"后合并 Blob 下载。
  const startLiveRecording = (url: string, format: string, requestHeaders?: Record<string, string>) => {
    const key = getMediaKey({ url, format })
    // 已在录制中：切换为停止
    const existing = flvRecording.value.get(key)
    if (existing) {
      existing.controller.abort()
      return
    }
    const controller = new AbortController()
    const chunks: Uint8Array[] = []
    const startTime = Date.now()
    flvRecording.value.set(key, { chunks, controller, startTime })
    showToastMsg(t('liveRecordingStarted') || '录制中…再次点击停止')
    ;(async () => {
      try {
        const headers: Record<string, string> = { ...requestHeaders }
        const resp = await fetch(url, {
          signal: controller.signal,
          headers,
          mode: 'cors',
        })
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)
        const reader = resp.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) chunks.push(value)
          // 安全上限：500MB，避免内存爆炸
          const totalBytes = chunks.reduce((s, c) => s + c.length, 0)
          if (totalBytes > 500 * 1024 * 1024) {
            showToastMsg(t('liveRecordingLimit') || '录制达到 500MB 上限，自动停止')
            break
          }
        }
      } catch (e: any) {
        if (e.name !== 'AbortError') {
          showToastMsg(t('liveRecordingError') || '录制失败')
        }
      } finally {
        // 合并下载
        const totalBytes = chunks.reduce((s, c) => s + c.length, 0)
        if (totalBytes > 0) {
          const blob = new Blob(chunks as BlobPart[], {
            type: format === 'flv' ? 'video/x-flv' : 'video/mp2t',
          })
          const blobUrl = URL.createObjectURL(blob)
          const duration = ((Date.now() - startTime) / 1000).toFixed(0)
          const filename = `live-${duration}s-${Date.now().toString(36)}.${format}`
          browser.downloads.download({ url: blobUrl, filename }).then(() => {
            showToastMsg(t('downloadComplete') || '下载完成')
            setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
          }).catch(() => {
            showToastMsg(t('docDownloadFailed'))
            URL.revokeObjectURL(blobUrl)
          })
        }
        flvRecording.value.delete(key)
      }
    })()
  }
  const isLiveRecording = (url: string, format: string): boolean => {
    return flvRecording.value.has(getMediaKey({ url, format }))
  }

  const downloadUrl = (url: string, format: string, requestHeaders?: Record<string, string>, captureId?: string, isLiveStream?: boolean) => {
    if (format === 'mse') {
      if (!captureId) return
      browser.runtime.sendMessage({ type: 'MSE_DOWNLOAD', captureId, tabId: currentTabId })
      return
    }
    // 直播流（HTTP-FLV/MPEG-TS 无 size）：在 popup 端录制，不能跳下载页
    if (isLiveStream && (format === 'flv' || format === 'ts')) {
      startLiveRecording(url, format, requestHeaders)
      return
    }
    const filename = getDownloadName(url)
    if (isStreamFormat(format) || isVideoDownloadFormat(format)) {
      browser.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_PAGE', url, format, filename, requestHeaders })
    } else if (isImageFormat(format)) {
      void downloadProtectedResource(url, format, requestHeaders, getDownloadFilename(url, format), 'image')
    } else if (isAudioFormat(format)) {
      void downloadProtectedResource(url, format, requestHeaders, getDownloadFilename(url, format), 'audio')
    } else if (DOC_AND_SUB_FORMATS.includes(format.toLowerCase())) {
      void downloadProtectedResource(url, format, requestHeaders, getDownloadFilename(url, format), 'document')
    } else {
      browser.downloads.download({ url, filename: getDownloadFilename(url, format) }).then(
        () => showToastMsg(t('docDownloadStarted')),
        () => showToastMsg(t('docDownloadFailed'))
      )
    }
  }

  const toggleSelect = (key: string) => {
    const next = new Set(selectedKeys.value)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    selectedKeys.value = next
  }

  const toggleSelectAll = () => {
    const visibleKeys = flatMediaList.value.map(getMediaKey)
    if (visibleKeys.length > 0 && visibleKeys.every(key => selectedKeys.value.has(key))) {
      selectedKeys.value = new Set()
    } else {
      selectedKeys.value = new Set(visibleKeys)
    }
  }

  const batchDownload = () => {
    const items = flatMediaList.value.filter(item => selectedKeys.value.has(getMediaKey(item)))
    const subDir = sanitizeDirectoryName(currentTabTitle.value)
    items.forEach((item, idx) => {
      const baseName = getDownloadName(item.url)
      const suffix = items.length > 1 ? `_${idx + 1}` : ''
      if (item.format === 'mse') {
        if (item.captureId) browser.runtime.sendMessage({ type: 'MSE_DOWNLOAD', captureId: item.captureId, tabId: currentTabId })
      } else if (item.isLiveStream && (item.format === 'flv' || item.format === 'ts')) {
        startLiveRecording(item.url, item.format, item.requestHeaders)
      } else if (isStreamFormat(item.format) || isVideoDownloadFormat(item.format)) {
        const filename = `${baseName}${suffix}`
        browser.runtime.sendMessage({ type: 'OPEN_DOWNLOAD_PAGE', url: item.url, format: item.format, filename, requestHeaders: item.requestHeaders })
      } else if (isImageFormat(item.format)) {
        const filename = getBatchDownloadFilename(item.url, item.format, subDir)
        void downloadProtectedResource(item.url, item.format, item.requestHeaders, filename, 'image')
      } else if (isAudioFormat(item.format)) {
        const filename = getBatchDownloadFilename(item.url, item.format, subDir)
        void downloadProtectedResource(item.url, item.format, item.requestHeaders, filename, 'audio')
      } else if (DOC_AND_SUB_FORMATS.includes(item.format.toLowerCase())) {
        const filename = getBatchDownloadFilename(item.url, item.format, subDir)
        void downloadProtectedResource(item.url, item.format, item.requestHeaders, filename, 'document')
      } else {
        const filename = getBatchDownloadFilename(item.url, item.format, subDir)
        browser.downloads.download({ url: item.url, filename })
      }
    })
    showToastMsg(t('batchDownloadStarted', items.length.toString()))
    selectedKeys.value.clear()
  }

  const openFeedback = () => {
    showMore.value = false
    browser.tabs.create({ url: 'https://github.com/ezwebtools/flowpick/discussions' })
  }

  const openHelp = () => {
    showMore.value = false
    browser.tabs.create({ url: 'https://flowpick.net/docs/getting-started' })
  }

  // ── Settings actions ──────────────────────────────────────────────
  function parseExcludeDomains(text: string): string[] {
    return text.split('\n').map(d => d.trim()).filter(d => d.length > 0)
  }

  async function triggerSave() {
    const domains = parseExcludeDomains(excludeDomainsText.value)
    settings.value.excludeDomains = domains
    try {
      await saveSettings({
        sniffingRules: settings.value.sniffingRules,
        excludeDomains: Array.from(domains),
        maxItems: settings.value.maxItems,
        enableMseCapture: settings.value.enableMseCapture,
        hideStreamSegments: settings.value.hideStreamSegments,
        captureDataImages: settings.value.captureDataImages,
        dataImageMinSizeKB: settings.value.dataImageMinSizeKB,
      })
    } catch {}
    settingsSaved.value = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { settingsSaved.value = false }, 2500)
  }

  function triggerTextSave() {
    if (textSaveTimer) clearTimeout(textSaveTimer)
    textSaveTimer = setTimeout(() => { triggerSave() }, 600)
  }

  async function openShortcuts() {
    if (typeof (browser.commands as any)?.openShortcutSettings === 'function') {
      ;(browser.commands as any).openShortcutSettings()
    } else {
      const isFirefox = navigator.userAgent.includes('Firefox')
      const url = isFirefox
        ? 'about:addons'
        : 'chrome://extensions/shortcuts'
      browser.tabs.create({ url })
    }
  }

  function handleResetClick() {
    if (!resetConfirm.value) {
      resetConfirm.value = true
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer)
      resetConfirmTimer = setTimeout(() => {
        resetConfirm.value = false
        resetConfirmTimer = null
        showToastMsg(t('resetCanceled'))
      }, 3000)
      showToastMsg(t('resetConfirm'))
      return
    }
    resetConfirm.value = false
    if (resetConfirmTimer) { clearTimeout(resetConfirmTimer); resetConfirmTimer = null }
    settings.value = {
      sniffingRules: {
        streaming: { ...DEFAULT_SETTINGS.sniffingRules.streaming },
        video:     { ...DEFAULT_SETTINGS.sniffingRules.video },
        audio:     { ...DEFAULT_SETTINGS.sniffingRules.audio },
        image:     { ...DEFAULT_SETTINGS.sniffingRules.image },
        document:  { ...DEFAULT_SETTINGS.sniffingRules.document },
        subtitle:  { ...DEFAULT_SETTINGS.sniffingRules.subtitle },
      },
      excludeDomains: [],
      maxItems: DEFAULT_SETTINGS.maxItems,
      enableMseCapture: DEFAULT_SETTINGS.enableMseCapture,
      hideStreamSegments: DEFAULT_SETTINGS.hideStreamSegments,
      captureDataImages: DEFAULT_SETTINGS.captureDataImages,
      dataImageMinSizeKB: DEFAULT_SETTINGS.dataImageMinSizeKB,
    }
    excludeDomainsText.value = ''
    triggerSave()
    showToastMsg(t('resetSuccess'))
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
    try {
      await triggerSave()
    } catch {}
    view.value = 'list'
  }
</script>

<template>
  <div :class="rootContainerClass">

    <!-- ═══ LIST VIEW ═══════════════════════════════════════════════ -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 -translate-x-4"
      enter-to-class="opacity-100 translate-x-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100 translate-x-0"
      leave-to-class="opacity-0 -translate-x-4"
    >
      <div v-if="view === 'list'" class="flex flex-col h-full overflow-hidden">
        <div class="border-b border-gray-200 dark:border-gray-800 sticky top-0 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm z-10 shrink-0">
          <div v-if="mode === 'popup'" class="flex items-center px-3 py-2 border-b border-gray-100 dark:border-gray-800">
            <img src="/icon/48.png" alt="FlowPick" class="w-6 h-6 mr-2" />
            <div class="flex items-center gap-1.5">
              <span class="text-sm font-bold text-gray-800 dark:text-gray-100">FlowPick</span>
              <span class="text-[10px] text-gray-400 dark:text-gray-500"> | {{ t('subtitle') }}</span>
            </div>
          </div>
          <div v-if="isMobileBrowser" class="px-3 py-1.5 text-[11px] leading-4 text-amber-800 bg-amber-50 border-b border-amber-100 dark:text-amber-200 dark:bg-amber-950/40 dark:border-amber-900/50">
            {{ mobileCapabilityTip }}
          </div>
          <div class="flex items-center w-full">
            <nav class="flex -mb-px flex-1 w-full min-w-0">
              <button @click="activeTab = 'all'" :class="[activeTab === 'all' ? 'border-blue-500 text-blue-600 dark:text-blue-300 dark:border-blue-400 dark:bg-blue-500/15 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800/50 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all min-w-0']">
                {{ t('tabAll') }}({{ tabCounts.all }})
              </button>
              <button @click="activeTab = 'stream'" :class="[activeTab === 'stream' ? 'border-purple-500 text-purple-600 dark:text-purple-300 dark:border-purple-400 dark:bg-purple-500/15 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800/50 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                {{ t('tabStream') }}({{ tabCounts.stream }})
              </button>
              <button @click="activeTab = 'video'" :class="[activeTab === 'video' ? 'border-blue-500 text-blue-600 dark:text-blue-300 dark:border-blue-400 dark:bg-blue-500/15 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800/50 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                {{ t('video') }}({{ tabCounts.video }})
              </button>
              <button @click="activeTab = 'audio'" :class="[activeTab === 'audio' ? 'border-green-500 text-green-600 dark:text-green-300 dark:border-green-400 dark:bg-green-500/15 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800/50 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                {{ t('audio') }}({{ tabCounts.audio }})
              </button>
              <button @click="activeTab = 'image'" :class="[activeTab === 'image' ? 'border-orange-500 text-orange-600 dark:text-orange-300 dark:border-orange-400 dark:bg-orange-500/15 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800/50 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                {{ t('image') }}({{ tabCounts.image }})
              </button>
              <button @click="activeTab = 'doc'" :class="[activeTab === 'doc' ? 'border-indigo-500 text-indigo-600 dark:text-indigo-300 dark:border-indigo-400 dark:bg-indigo-500/15 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800/50 font-normal', 'flex-1 py-2.5 px-1 text-center border-b-2 text-sm transition-all']">
                {{ t('tabDoc') }}({{ tabCounts.doc }})
              </button>
            </nav>
            
          </div>
          <div v-if="flatMediaList.length > 0" class="flex items-center gap-1 px-3 py-1 border-b border-gray-100 dark:border-gray-800">
            <button @click="toggleSelectAll" class="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all" :title="flatMediaList.length > 0 && flatMediaList.every(item => selectedKeys.has(mediaView(item).key)) ? t('deselectAll') : t('selectAll')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <circle cx="12" cy="12" r="9" />
                <path v-if="flatMediaList.length > 0 && flatMediaList.every(item => selectedKeys.has(mediaView(item).key))" stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4" />
              </svg>
            </button>
            <button @click="batchDownload" :disabled="selectedKeys.size === 0"
              class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-all disabled:cursor-not-allowed"
              :class="selectedKeys.size > 0 ? 'bg-blue-500 hover:bg-blue-400 text-white shadow-sm' : 'text-gray-400 dark:text-gray-600 bg-transparent'"
              :title="t('downloadSelected')">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span v-if="selectedKeys.size > 0">{{ selectedKeys.size }}</span>
            </button>
            <div class="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-0.5 flex-shrink-0"></div>
            <button
              @click="sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'"
              :title="sortOrder === 'asc' ? t('sortAsc') : t('sortDesc')"
              :class="['flex items-center justify-center w-7 h-7 rounded-md transition-all', sortOrder === 'desc' ? 'text-blue-500 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800']">
              <svg class="w-4 h-4 transition-transform" :class="sortOrder === 'asc' ? 'rotate-180' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />
              </svg>
            </button>
            <button @click="clearCurrentList"
              class="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
              :title="t('clearList')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
            <button @click="refreshPage"
              class="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 dark:text-gray-500 hover:text-green-500 dark:hover:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
              :title="t('refreshPage')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
              </svg>
            </button>
            <button @click="showFilter = !showFilter"
              :class="[
                'flex items-center justify-center w-7 h-7 rounded-md transition-all',
                showFilter || typeFilter !== 'any' || sizeFilter.min > 0 || sizeFilter.max > 0 || dimensionFilter.minWidth > 0 || dimensionFilter.minHeight > 0 || resolutionFilter !== 'any'
                  ? 'text-blue-500 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30'
                  : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              ]"
              :title="t('filter')">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
            </button>
          </div>
          <div class="px-2 py-1.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
            <div class="relative flex-1">
              <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                v-model="searchQuery"
                type="text"
                :class="['w-full pl-7 pr-14 py-1.5 text-sm rounded-lg border bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:bg-white dark:focus:bg-gray-700 focus:border-transparent transition-all duration-150', regexValid ? 'border-gray-200 dark:border-gray-700 focus:ring-blue-500' : 'border-red-400 focus:ring-red-500']"
                :placeholder="t('searchPlaceholder')"
              />
              <div class="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button v-if="searchQuery" @click="clearSearch"
                  class="flex items-center justify-center w-5 h-5 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600 transition-all"
                  :title="t('searchClear')">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <button @click="useRegex = !useRegex"
                  :class="['flex items-center justify-center w-6 h-5 rounded text-[10px] font-mono font-bold border transition-all duration-150', useRegex ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-blue-400 hover:text-blue-500 dark:hover:text-blue-400']"
                  :title="t('searchRegexTitle')">
                  .*
                </button>
              </div>
            </div>
            <p v-if="!regexValid && searchError" class="mt-1 text-xs text-red-500 dark:text-red-400 font-mono truncate">{{ searchError }}</p>
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
                  <span class="text-gray-500 dark:text-gray-400">{{ t('filterType') }}:</span>
                  <select v-model="typeFilter"
                    class="px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                    <option value="any">{{ t('any') }}</option>
                    <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value" :disabled="opt.disabled">
                      {{ opt.label }}({{ opt.count }})
                    </option>
                  </select>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">{{ t('filterSize') }}:</span>
                  <input type="number" v-model.number="sizeFilter.min" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    :placeholder="t('min')" />
                  <span class="text-gray-400">-</span>
                  <input type="number" v-model.number="sizeFilter.max" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    :placeholder="t('max')" />
                  <span class="text-gray-400">{{ t('kb') }}</span>
                </div>
                <div v-if="activeTab === 'image'" class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">{{ t('filterDimension') }}:</span>
                  <input type="number" v-model.number="dimensionFilter.minWidth" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    :placeholder="t('width')" />
                  <span class="text-gray-400">×</span>
                  <input type="number" v-model.number="dimensionFilter.minHeight" min="0" 
                    class="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500" 
                    :placeholder="t('height')" />
                  <span class="text-gray-400">px</span>
                </div>
                <div v-if="activeTab === 'video'" class="flex items-center gap-1.5">
                  <span class="text-gray-500 dark:text-gray-400">{{ t('filterResolution') }}:</span>
                  <select v-model="resolutionFilter"
                    class="px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                    <option value="any">{{ t('any') }}</option>
                    <option value="8k">8K</option>
                    <option value="4k">4K</option>
                    <option value="1080p">1080P</option>
                    <option value="720p">720P</option>
                    <option value="480p">480P</option>
                    <option value="360p">360P</option>
                    <option value="sd">SD</option>
                  </select>
                </div>
                <button @click="typeFilter = 'any'; sizeFilter = { min: 0, max: 0 }; dimensionFilter = { minWidth: 0, minHeight: 0 }; resolutionFilter = 'any'; sortOrder = 'asc'" 
                  class="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 hover:text-gray-900 dark:hover:text-white rounded transition-all duration-150">
                  {{ t('reset') }}
                </button>
              </div>
            </div>
          </Transition>
        </div>

        <main ref="listContainerRef"
          class="flex-1 overflow-y-auto min-h-0"
          :class="{ 'all-tab-scrollbar': activeTab === 'all' || activeTab === 'video' }"
          @scroll="onListScroll">
          <div v-if="filteredMediaList.length === 0"
            class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 px-6 py-12">
            <div class="w-20 h-20 mb-4 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
              <svg class="w-10 h-10 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
            </div>
            <p class="text-base font-medium text-gray-600 dark:text-gray-400 mb-2">{{ t('notFound') }}</p>
            <p class="text-sm text-center text-gray-500 dark:text-gray-500 leading-relaxed">{{ t('playTips') }}</p>
          </div>

          <template v-else>
            <div v-if="activeTab === 'image'" class="relative" :style="{ height: masonryTotalHeight + 'px', margin: '8px 0' }">
              <div v-for="mItem in imageVirtualItems" :key="mItem.item.url + mItem.index"
                class="absolute"
                :style="{
                  top: mItem.top + 'px',
                  left: masonryColLeft(mItem.col) + 'px',
                  width: masonryColWidth + 'px',
                  height: mItem.height + 'px'
                }">
                <div
                  @click="previewImage(mItem.item.url)"
                  :class="[
                    'group relative rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 shadow-sm hover:shadow-md transition-all duration-200 cursor-zoom-in w-full h-full',
                    selectedKeys.has(mediaView(mItem.item).key) ? 'ring-2 ring-blue-500 ring-offset-1' : ''
                  ]">
                  <img :src="imageSrc(mItem.item.url, mItem.item.requestHeaders)" :alt="mediaView(mItem.item).fileName"
                    class="w-full h-full object-cover"
                    loading="lazy"
                    @error="proxyImage($event, mItem.item.url, mItem.item.requestHeaders)"
                    @load="onMasonryImageLoad($event, mItem)" />
                  <div
                    @click.stop="toggleSelect(mediaView(mItem.item).key)"
                    :class="[
                      'absolute top-2 left-2 z-10 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-150 cursor-pointer',
                      selectedKeys.has(mediaView(mItem.item).key)
                        ? 'bg-blue-500 border-blue-500'
                        : 'bg-white/80 dark:bg-gray-800/80 border-gray-300 dark:border-gray-600 hover:border-blue-400 hover:bg-white'
                    ]">
                    <svg v-if="selectedKeys.has(mediaView(mItem.item).key)" class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                    <div class="absolute bottom-0 left-0 right-0 p-2 pointer-events-auto">
                      <p class="text-xs text-white font-medium truncate mb-1">{{ mediaView(mItem.item).fileName }}</p>
                      <div class="flex items-center gap-1" @click.stop>
                        <button @click="copyUrl(mItem.item.url)"
                          class="p-1 rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                          :title="t('copyUrl')">
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                        <button @click="downloadUrl(mItem.item.url, mItem.item.format, mItem.item.requestHeaders)"
                          class="p-1 rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                          :title="t('download')">
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </button>
                        <button @click="previewImage(mItem.item.url)"
                          class="p-1 rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                          :title="t('preview')">
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-black/40 backdrop-blur-sm flex items-center gap-1 flex-wrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                    <span :class="getFormatColor(mItem.item.format)" class="px-1 py-0.5 rounded text-[10px] font-medium">{{ getFormatLabel(mItem.item.format) }}</span>
                    <span v-if="mItem.item.size" :class="getSizeColor()" class="px-1 py-0.5 rounded text-[10px] font-medium">{{ formatFileSize(mItem.item.size) }}</span>
                    <span v-if="mItem.item.width && mItem.item.height" :class="getResolutionColor(mItem.item.width, mItem.item.height)" class="px-1 py-0.5 rounded text-[10px] font-medium">{{ mItem.item.width }}×{{ mItem.item.height }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div v-else-if="activeTab === 'stream'" class="relative" :style="{ height: streamGroupLayout.totalHeight + 'px' }">
              <div v-for="{ group, index: groupIndex, top } in virtualStreamGroups" :key="group.id"
                :ref="el => observeStreamGroup(el, group.id)"
                :style="{ position: 'absolute', top: top + 'px', left: '8px', right: '8px' }"
                class="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">

                <!-- 卡片主体：封面 + 信息 + 操作 -->
                <div class="flex gap-2 px-2 bg-white dark:bg-gray-800"
                  :class="[group.variants.length > 0 ? 'cursor-pointer' : '', currentDensity === 'compact' ? 'py-2' : 'py-3']"
                  @click="group.variants.length > 0 && toggleGroupExpand(group.id)">

                  <!-- 封面 / 缩略图 -->
                  <div :class="currentDensity === 'compact' ? 'w-12 h-12' : 'w-14 h-14'" class="relative flex-shrink-0 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-700 cursor-zoom-in"
                    @mouseenter="onCardHover(groupIndex, getStreamThumbItem(group), $event, group.masterItem.coverUrl)"
                    @mouseleave="onCardLeave">
                    <img v-if="group.masterItem.coverUrl && imageLoadStatus.get(group.masterItem.coverUrl) !== false"
                      :src="imageSrc(group.masterItem.coverUrl, group.masterItem.requestHeaders)"
                      @error="proxyImage($event, group.masterItem.coverUrl, group.masterItem.requestHeaders)"
                      class="w-full h-full object-cover" alt="" />
                    <img v-else-if="streamThumbCache.has(getStreamThumbItem(group).url)"
                      :src="streamThumbCache.get(getStreamThumbItem(group).url)"
                      @load="touchStreamThumb(getStreamThumbItem(group).url)"
                      class="w-full h-full object-cover" alt="" />
                    <video v-else-if="isVideoFormat(getStreamThumbItem(group).format) && !videoThumbFailed.has(getStreamThumbItem(group).url)"
                      :src="getStreamThumbItem(group).url"
                      class="w-full h-full object-cover"
                      preload="metadata" muted playsinline
                      @loadeddata="onVideoThumbLoaded($event, getStreamThumbItem(group))"
                      @error="onVideoThumbError(getStreamThumbItem(group).url)" />
                    <!-- 即使封面已缓存，只要时长缺失仍静默探测流元数据。 -->
                    <video v-if="(!group.masterItem.coverUrl || imageLoadStatus.get(group.masterItem.coverUrl) === false) && streamThumbCache.has(getStreamThumbItem(group).url)
                        && !getStreamThumbItem(group).duration
                        && (getStreamThumbItem(group).format === 'm3u8' || getStreamThumbItem(group).format === 'mpd' || getStreamThumbItem(group).format === 'flv')
                        && !streamThumbFailed.has(getStreamThumbItem(group).url)"
                      :ref="el => observeStreamThumb(el, getStreamThumbItem(group))"
                      class="absolute inset-0 w-px h-px opacity-0 pointer-events-none"
                      preload="metadata" muted playsinline></video>
                    <video v-if="(!group.masterItem.coverUrl || imageLoadStatus.get(group.masterItem.coverUrl) === false) && !streamThumbCache.has(getStreamThumbItem(group).url) && (getStreamThumbItem(group).format === 'm3u8' || getStreamThumbItem(group).format === 'mpd' || getStreamThumbItem(group).format === 'flv') && !streamThumbFailed.has(getStreamThumbItem(group).url)"
                      :ref="el => observeStreamThumb(el, getStreamThumbItem(group))"
                      class="w-full h-full object-cover"
                      preload="metadata" muted playsinline></video>
                    <div v-if="(!group.masterItem.coverUrl || imageLoadStatus.get(group.masterItem.coverUrl) === false) && !streamThumbCache.has(getStreamThumbItem(group).url) && (!isVideoFormat(getStreamThumbItem(group).format) || videoThumbFailed.has(getStreamThumbItem(group).url)) && ((getStreamThumbItem(group).format !== 'm3u8' && getStreamThumbItem(group).format !== 'mpd' && getStreamThumbItem(group).format !== 'flv') || streamThumbFailed.has(getStreamThumbItem(group).url))" class="w-full h-full flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/30 dark:to-orange-800/30 text-orange-400">
                      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                      </svg>
                    </div>
                    <span v-if="getStreamDuration(group)"
                      class="absolute bottom-0.5 right-0.5 px-1 py-px text-[9px] font-semibold bg-black/70 text-white rounded tabular-nums leading-none block">
                      {{ formatDuration(getStreamDuration(group)!) }}
                    </span>
                    <span v-if="getStreamThumbItem(group).isLiveStream"
                      class="absolute top-0.5 left-0.5 px-1 py-px text-[9px] font-bold bg-red-500 text-white rounded animate-pulse leading-none">
                      LIVE
                    </span>
                  </div>

                  <!-- 信息区 -->
                  <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
                    <div class="flex items-start gap-1 min-w-0">
                      <input v-if="editingUrl === getGroupRenameUrl(group)"
                        v-model="editingName"
                        v-focus
                        @blur="confirmRename"
                        @keydown.enter.prevent="confirmRename"
                        @keydown.esc.prevent="cancelRename"
                        @click.stop
                        class="font-medium text-[13px] leading-snug text-gray-900 dark:text-gray-100 bg-blue-50 dark:bg-blue-900/30 border border-blue-400 dark:border-blue-500 rounded px-1 -mx-1 outline-none flex-1 min-w-0" />
                      <p v-else
                        class="font-medium text-[13px] leading-snug text-gray-900 dark:text-gray-100 truncate flex-1 min-w-0 cursor-text hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        :title="group.masterItem.tabTitle || currentTabTitle || group.masterItem.url"
                        @click.stop="startRename(getGroupRenameUrl(group), getDisplayName(getGroupRenameUrl(group), getGroupRenameItem(group)))">
                        {{ getDisplayName(getGroupRenameUrl(group), getGroupRenameItem(group)) }}
                      </p>
                      <span v-if="group.masterItem.detectedAt" class="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0 mt-0.5">
                        {{ getRelativeTime(group.masterItem.detectedAt) }}
                      </span>
                    </div>

                    <div class="flex items-center gap-1 min-w-0 overflow-hidden whitespace-nowrap">
                      <span :class="getFormatColor(group.masterItem.format)" class="px-1.5 py-px rounded text-[10px] font-bold tracking-wide uppercase flex-shrink-0 leading-tight">
                        {{ getFormatLabel(group.masterItem.format) }}
                      </span>
                      <span v-if="group.isVirtual" class="text-[10px] text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 px-1.5 py-0.5 rounded-full flex-shrink-0 leading-tight">
                        分离流
                      </span>
                      <span v-if="getGroupEstimatedSize(group)"
                        class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight"
                        title="估算大小">
                        {{ formatItemSize({ format: group.masterItem.format, size: getGroupEstimatedSize(group) } as MediaItem) }}
                      </span>
                    </div>

                    <p v-if="!group.isVirtual && getDomainLabel(group.masterItem.url)" class="text-[10px] text-gray-400 dark:text-gray-500 truncate">{{ getDomainLabel(group.masterItem.url) }}<span v-if="group.variants.length"> · {{ group.variants.length }} variants</span></p>
                    <p v-else-if="group.variants.length > 0" class="text-[10px] text-gray-400 dark:text-gray-500 truncate">{{ getDomainLabel(group.variants[0].item.url) }} · {{ group.variants.length }} variants</p>
                  </div>

                  <!-- 右侧：展开箭头 + 操作按钮 -->
                  <div class="flex flex-col items-end gap-1 flex-shrink-0">
                    <svg v-if="group.variants.length > 0"
                      :class="['w-3.5 h-3.5 text-gray-400 transition-transform duration-200', expandedGroups.has(group.id) ? 'rotate-90' : '']"
                      fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                    </svg>
                    <span v-else class="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600 block"></span>

                    <div class="flex items-center gap-0.5" @click.stop>
                      <button v-if="!group.isVirtual" @click="copyUrl(group.masterItem.url)"
                        class="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        :title="t('copyUrl')">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button @click="playUrl(getPreferredStreamItem(group).url, getPreferredStreamItem(group).format, getPreferredStreamItem(group))"
                        :class="['p-1.5 rounded text-white transition-colors', isItemPlaying(getPreferredStreamItem(group)) ? 'bg-red-500 hover:bg-red-400' : 'bg-blue-600 hover:bg-blue-500']"
                        :title="isItemPlaying(getPreferredStreamItem(group)) ? t('stopPlay') : t('play')">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <template v-if="isItemPlaying(getPreferredStreamItem(group))">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6" />
                          </template>
                          <template v-else>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </template>
                        </svg>
                      </button>
                      <button v-if="group.isVirtual && group.variants.length > 0"
                        @click="downloadStreamVariant(group.variants[0])"
                        class="p-1.5 rounded text-white bg-green-600 hover:bg-green-500 transition-colors"
                        :title="t('download')">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                      <button v-else-if="!group.isVirtual" @click="downloadUrl(group.masterItem.url, group.masterItem.format, group.masterItem.requestHeaders)"
                        class="p-1.5 rounded text-white bg-green-600 hover:bg-green-500 transition-colors"
                        :title="t('download')">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 播放器必须挂载在 Stream 分组自身，不能借用 All 标签的同名媒体节点 -->
                <div
                  v-if="playingKey === getMediaKey(getPreferredStreamItem(group))"
                  class="border-t border-gray-100 dark:border-gray-700/60 bg-white dark:bg-gray-800 px-3 pb-3 pt-2">
                  <div class="bg-black rounded-lg overflow-hidden flex items-center justify-center aspect-video">
                    <video
                      :id="'video-player-' + getMediaDomId(getPreferredStreamItem(group))"
                      class="w-full h-full object-contain bg-black block"
                      controls
                      preload="metadata" />
                  </div>
                </div>

                <div v-if="expandedGroups.has(group.id) && group.variants.length > 0"
                  class="border-t border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40">
                  <div v-for="(variant, vi) in group.variants" :key="variant.item.url"
                    :class="['px-2.5 py-1.5 flex items-center gap-2 transition-colors hover:bg-gray-100/70 dark:hover:bg-gray-700/40 cursor-default', vi < group.variants.length - 1 ? 'border-b border-gray-100 dark:border-gray-700/40' : '']">

                    <div class="w-4 flex-shrink-0 flex items-center justify-center text-gray-300 dark:text-gray-600 text-sm select-none">
                      {{ vi === group.variants.length - 1 ? '└' : '├' }}
                    </div>

                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ variant.label }}</span>
                        <span v-if="variant.audioItem"
                          class="text-xs text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 px-1.5 py-0.5 rounded-full">
                          分离音轨
                        </span>
                      </div>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 truncate">{{ getDomainLabel(variant.item.url) }}<span v-if="variant.bandwidth"> · {{ Math.round(variant.bandwidth / 1000) }} kbps</span></p>
                    </div>

                    <div class="flex items-center gap-0.5 flex-shrink-0">
                      <button @click="copyUrl(variant.item.url)"
                        class="p-1 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        :title="t('copyUrl')">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button v-if="variant.audioItem"
                        @click="downloadUrl(variant.audioItem.url, variant.audioItem.format, variant.audioItem.requestHeaders)"
                        class="p-1 rounded text-white bg-purple-600 hover:bg-purple-500 transition-colors"
                        title="仅下载音频">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </svg>
                      </button>
                      <button @click="downloadStreamVariant(variant)"
                        class="p-1 rounded text-white bg-green-600 hover:bg-green-500 transition-colors"
                        :title="variant.audioItem ? '下载并合并音视频' : t('download')">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

              </div>
            </div>

            <div v-else class="p-2">
              <!-- Same StreamGroup card visual treatment, reused in All. -->
              <div v-if="activeTab === 'all' && groupedStreamList.length" :ref="observeAllStreamGroups" class="space-y-1.5 mb-2">
                <div v-for="group in groupedStreamList" :key="'all-group-' + group.id"
                  class="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
                  <div class="flex gap-2 px-2 bg-white dark:bg-gray-800 cursor-pointer"
                    :class="[group.variants.length ? '' : '', currentDensity === 'compact' ? 'py-2' : 'py-3']"
                    @click="group.variants.length && toggleGroupExpand(group.id)">
                    <div :class="currentDensity === 'compact' ? 'w-12 h-12' : 'w-14 h-14'" class="relative flex-shrink-0 rounded-md overflow-hidden bg-gray-100 dark:bg-gray-700 cursor-zoom-in"
                      @mouseenter="onCardHover(0, getStreamThumbItem(group), $event, group.masterItem.coverUrl)"
                      @mouseleave="onCardLeave">
                      <img v-if="group.masterItem.coverUrl && imageLoadStatus.get(group.masterItem.coverUrl) !== false" :src="imageSrc(group.masterItem.coverUrl, group.masterItem.requestHeaders)" @error="proxyImage($event, group.masterItem.coverUrl, group.masterItem.requestHeaders)" class="w-full h-full object-cover" alt="" />
                      <img v-else-if="streamThumbCache.has(getStreamThumbItem(group).url)" :src="streamThumbCache.get(getStreamThumbItem(group).url)" @load="touchStreamThumb(getStreamThumbItem(group).url)" class="w-full h-full object-cover" alt="" />
                      <video v-else-if="isVideoFormat(getStreamThumbItem(group).format) && !videoThumbFailed.has(getStreamThumbItem(group).url)" :src="getStreamThumbItem(group).url" class="w-full h-full object-cover" preload="metadata" muted playsinline @loadeddata="onVideoThumbLoaded($event, getStreamThumbItem(group))" @error="onVideoThumbError(getStreamThumbItem(group).url)" />
                      <video v-if="(!group.masterItem.coverUrl || imageLoadStatus.get(group.masterItem.coverUrl) === false) && streamThumbCache.has(getStreamThumbItem(group).url) && !getStreamThumbItem(group).duration && (getStreamThumbItem(group).format === 'm3u8' || getStreamThumbItem(group).format === 'mpd' || getStreamThumbItem(group).format === 'flv') && !streamThumbFailed.has(getStreamThumbItem(group).url)" :ref="el => observeStreamThumb(el, getStreamThumbItem(group))" class="absolute inset-0 w-px h-px opacity-0 pointer-events-none" preload="metadata" muted playsinline></video>
                      <video v-if="(!group.masterItem.coverUrl || imageLoadStatus.get(group.masterItem.coverUrl) === false) && !streamThumbCache.has(getStreamThumbItem(group).url) && (getStreamThumbItem(group).format === 'm3u8' || getStreamThumbItem(group).format === 'mpd' || getStreamThumbItem(group).format === 'flv') && !streamThumbFailed.has(getStreamThumbItem(group).url)" :ref="el => observeStreamThumb(el, getStreamThumbItem(group))" class="w-full h-full object-cover" preload="metadata" muted playsinline></video>
                      <div v-if="(!group.masterItem.coverUrl || imageLoadStatus.get(group.masterItem.coverUrl) === false) && !streamThumbCache.has(getStreamThumbItem(group).url) && (!isVideoFormat(getStreamThumbItem(group).format) || videoThumbFailed.has(getStreamThumbItem(group).url)) && ((getStreamThumbItem(group).format !== 'm3u8' && getStreamThumbItem(group).format !== 'mpd' && getStreamThumbItem(group).format !== 'flv') || streamThumbFailed.has(getStreamThumbItem(group).url))" class="w-full h-full flex items-center justify-center bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/30 dark:to-orange-800/30 text-orange-400"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg></div>
                      <span v-if="getStreamDuration(group)" class="absolute bottom-0.5 right-0.5 px-1 py-px text-[9px] font-semibold bg-black/70 text-white rounded tabular-nums leading-none">{{ formatDuration(getStreamDuration(group)!) }}</span>
                      <span v-if="getStreamThumbItem(group).isLiveStream" class="absolute top-0.5 left-0.5 px-1 py-px text-[9px] font-bold bg-red-500 text-white rounded animate-pulse leading-none">LIVE</span>
                    </div>
                    <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
                      <div class="flex items-start gap-1 min-w-0"><input v-if="editingUrl === getGroupRenameUrl(group)" v-model="editingName" @click.stop @keyup.enter="saveRename" @keyup.escape="cancelRename" @blur="saveRename" class="font-medium text-[13px] leading-snug text-gray-900 dark:text-gray-100 bg-blue-50 dark:bg-blue-900/30 border border-blue-400 dark:border-blue-500 rounded px-1 -mx-1 outline-none flex-1 min-w-0" /><p v-else class="font-medium text-[13px] leading-snug text-gray-900 dark:text-gray-100 truncate flex-1 cursor-text hover:text-blue-600 dark:hover:text-blue-400 transition-colors" :title="group.masterItem.tabTitle || currentTabTitle || group.masterItem.url" @click.stop="startRename(getGroupRenameUrl(group), getDisplayName(getGroupRenameUrl(group), getGroupRenameItem(group)))">{{ getDisplayName(getGroupRenameUrl(group), getGroupRenameItem(group)) }}</p><span v-if="group.masterItem.detectedAt" class="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0 mt-0.5">{{ getRelativeTime(group.masterItem.detectedAt) }}</span></div>
                      <div class="flex items-center gap-1 min-w-0 overflow-hidden whitespace-nowrap"><span :class="getFormatColor(group.masterItem.format)" class="px-1.5 py-px rounded text-[10px] font-bold tracking-wide uppercase flex-shrink-0 leading-tight">{{ getFormatLabel(group.masterItem.format) }}</span><span v-if="group.isVirtual" class="text-[10px] text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 px-1.5 py-0.5 rounded-full flex-shrink-0 leading-tight">分离流</span><span v-if="getGroupEstimatedSize(group)" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400">{{ formatItemSize({ format: group.masterItem.format, size: getGroupEstimatedSize(group) } as MediaItem) }}</span></div>
                      <p class="text-[10px] text-gray-400 dark:text-gray-500 truncate">{{ getDomainLabel(getPreferredStreamItem(group).url) }}<span v-if="group.variants.length"> · {{ group.variants.length }} variants</span></p>
                    </div>
                    <div class="flex flex-col items-end gap-1 flex-shrink-0"><svg v-if="group.variants.length" :class="['w-3.5 h-3.5 text-gray-400 transition-transform duration-200', expandedGroups.has(group.id) ? 'rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg><span v-else class="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600 block"></span><div class="flex items-center gap-0.5" @click.stop><button v-if="!group.isVirtual" @click="copyUrl(group.masterItem.url)" class="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20" :title="t('copyUrl')"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></button><button @click="playUrl(getPreferredStreamItem(group).url, getPreferredStreamItem(group).format, getPreferredStreamItem(group))" :class="['p-1.5 rounded text-white', isItemPlaying(getPreferredStreamItem(group)) ? 'bg-red-500 hover:bg-red-400' : 'bg-blue-600 hover:bg-blue-500']" :title="isItemPlaying(getPreferredStreamItem(group)) ? t('stopPlay') : t('play')"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><template v-if="isItemPlaying(getPreferredStreamItem(group))"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6" /></template><template v-else><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></template></svg></button>
                    <button v-if="group.isVirtual && group.variants.length" @click.stop="downloadStreamVariant(group.variants[0])" class="p-1.5 rounded text-white bg-green-600 hover:bg-green-500" :title="t('download')">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    </button>
                    <button v-else @click.stop="downloadUrl(group.masterItem.url, group.masterItem.format, group.masterItem.requestHeaders)" class="p-1.5 rounded text-white bg-green-600 hover:bg-green-500" :title="t('download')">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    </button>
                    </div></div>
                  </div>
                  <div v-if="playingKey === getMediaKey(getPreferredStreamItem(group))" class="border-t border-gray-100 dark:border-gray-700/60 bg-white dark:bg-gray-800 px-3 pb-3 pt-2">
                    <div class="bg-black rounded-lg overflow-hidden flex items-center justify-center aspect-video">
                      <video :id="'video-player-' + getMediaDomId(getPreferredStreamItem(group))" class="w-full h-full object-contain bg-black block" controls preload="metadata" />
                    </div>
                  </div>
                  <div v-if="expandedGroups.has(group.id) && group.variants.length" class="border-t border-gray-100 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40">
                    <div v-for="(variant, vi) in group.variants" :key="variant.item.url" :class="['px-2.5 py-1.5 flex items-center gap-2 hover:bg-gray-100/70 dark:hover:bg-gray-700/40', vi < group.variants.length - 1 ? 'border-b border-gray-100 dark:border-gray-700/40' : '']">
                      <div class="w-4 flex-shrink-0 text-gray-300 dark:text-gray-600 text-sm select-none">{{ vi === group.variants.length - 1 ? '└' : '├' }}</div>
                      <div class="flex-1 min-w-0"><div class="flex items-center gap-1.5 flex-wrap"><span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ variant.label }}</span></div><p class="text-[10px] text-gray-400 dark:text-gray-500 truncate">{{ getDomainLabel(variant.item.url) }}<span v-if="variant.bandwidth"> · {{ Math.round(variant.bandwidth / 1000) }} kbps</span></p></div>
                      <div class="flex items-center gap-0.5"><button @click="copyUrl(variant.item.url)" class="p-1 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20" :title="t('copyUrl')"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></button><button @click="downloadStreamVariant(variant)" class="p-1 rounded text-white bg-green-600 hover:bg-green-500" :title="t('download')"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg></button></div>
                    </div>
                  </div>
                </div>
              </div>
              <div :style="{ height: virtualList.totalHeight + 'px', position: 'relative' }">
                <div v-for="{ item, index, top } in virtualList.items" :key="mediaView(item).key"
                  :style="{ position: 'absolute', top: top + 'px', left: '0', right: '0', height: getItemHeight(item) + 'px' }"
                  @click="toggleSelect(mediaView(item).key)"
                  :class="[
                    'group relative rounded-lg overflow-hidden bg-white dark:bg-gray-800 transition-all duration-150 cursor-pointer border',
                    selectedKeys.has(mediaView(item).key)
                      ? 'ring-2 ring-blue-400 dark:ring-blue-500 border-blue-200 dark:border-blue-700 shadow-sm shadow-blue-100 dark:shadow-blue-900/30'
                      : 'border-gray-100 dark:border-gray-700/80 hover:border-gray-200 dark:hover:border-gray-600 hover:shadow-sm'
                  ]"
                  @mouseleave="onCardLeave">
                  <div :class="currentDensity === 'compact' ? (activeTab === 'all' ? 'min-h-[64px] py-2' : 'min-h-[66px] py-1.5') : (activeTab === 'all' ? 'min-h-[80px] py-3' : 'min-h-[78px] py-2')" class="flex items-stretch gap-2 px-2">

                    <!-- ═══ 缩略图 ═══ -->
                    <div :class="currentDensity === 'compact' ? 'w-12 h-12' : 'w-14 h-14'" class="relative flex-shrink-0 self-center rounded-md overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 cursor-zoom-in"
                      @mouseenter.stop="onCardHover(index, item, $event)"
                      @mouseleave.stop="onCardLeave">
                      <img v-if="item.coverUrl && imageLoadStatus.get(item.coverUrl) !== false"
                        :src="imageSrc(item.coverUrl, item.requestHeaders)"
                        :alt="mediaView(item).fileName"
                        class="w-full h-full object-cover"
                        loading="lazy"
                        @error="proxyImage($event, item.coverUrl, item.requestHeaders)" />
                      <video v-else-if="mediaView(item).isVideo && !videoThumbFailed.has(item.url)"
                        :src="imageSrc(item.url, item.requestHeaders)"
                        class="w-full h-full object-cover"
                        preload="metadata"
                        muted
                        playsinline
                        @loadeddata="onVideoThumbLoaded($event, item)"
                        @error="onVideoThumbError(item.url)" />
                      <img v-else-if="mediaView(item).isImage"
                        :src="item.url"
                        :alt="mediaView(item).fileName"
                        class="w-full h-full object-cover"
                        loading="lazy"
                        @error="proxyImage($event, item.url, item.requestHeaders)" />
                      <img v-else-if="(item.format === 'm3u8' || item.format === 'mpd') && streamThumbCache.has(item.url)"
                        :src="streamThumbCache.get(item.url)"
                        :alt="mediaView(item).fileName"
                        @load="touchStreamThumb(item.url)"
                        class="w-full h-full object-cover" />
                      <video v-else-if="(item.format === 'm3u8' || item.format === 'mpd') && !streamThumbFailed.has(item.url)"
                        :ref="el => observeStreamThumb(el, item)"
                        class="w-full h-full object-cover"
                        preload="metadata"
                        muted
                        playsinline />
                      <div v-else class="w-full h-full flex flex-col items-center justify-center"
                        :class="{
                          'bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/30': mediaView(item).isVideo,
                          'bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/30': mediaView(item).isAudio,
                          'bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/30 dark:to-orange-800/30': mediaView(item).isStream,
                          'bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/30 dark:to-indigo-800/30': !mediaView(item).isVideo && !mediaView(item).isAudio && !mediaView(item).isStream
                        }">
                        <audio v-if="mediaView(item).isAudio && !item.duration && !audioMetaFailed.has(item.url)"
                          :src="item.url"
                          preload="metadata"
                          class="hidden"
                          @loadedmetadata="onAudioMetaLoaded($event, item)"
                          @error="onAudioMetaError(item.url)" />
                        <svg v-if="mediaView(item).isVideo" class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.361a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        <svg v-else-if="mediaView(item).isAudio" class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </svg>
                        <svg v-else-if="mediaView(item).isStream" class="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                        </svg>
                        <svg v-else class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>

                      <div class="absolute bottom-0.5 right-0.5">
                        <span v-if="item.duration" class="px-1 py-px text-[9px] font-semibold bg-black/70 text-white rounded tabular-nums leading-none block">
                          {{ formatDuration(item.duration) }}
                        </span>
                        <span v-else-if="item.format === 'mse' && item.mseComplete" class="px-1 py-px text-[9px] font-semibold bg-green-600/90 text-white rounded leading-none block">✓</span>
                        <span v-else-if="item.format === 'mse'" class="px-1 py-px text-[9px] font-semibold bg-red-600/90 text-white rounded leading-none block">●</span>
                      </div>

                      <div @click.stop="toggleSelect(mediaView(item).key)"
                        :class="[
                          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all duration-150 cursor-pointer backdrop-blur-sm',
                          selectedKeys.has(mediaView(item).key)
                            ? 'bg-blue-500 border-blue-500'
                            : 'bg-white/70 dark:bg-gray-800/70 border-gray-300 dark:border-gray-500 hover:border-blue-400'
                        ]">
                        <svg v-if="selectedKeys.has(mediaView(item).key)" class="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    </div>

                    <!-- ═══ 信息区 ═══ -->
                    <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
                      <div class="flex items-start gap-1 min-w-0">
                        <input v-if="editingUrl === item.url"
                          v-model="editingName"
                          v-focus
                          @blur="confirmRename"
                          @keydown.enter.prevent="confirmRename"
                          @keydown.esc.prevent="cancelRename"
                          @click.stop
                          class="font-medium text-[13px] leading-snug text-gray-900 dark:text-gray-100 bg-blue-50 dark:bg-blue-900/30 border border-blue-400 dark:border-blue-500 rounded px-1 -mx-1 outline-none flex-1 min-w-0" />
                        <p v-else
                          class="font-medium text-[13px] leading-snug text-gray-900 dark:text-gray-100 truncate flex-1 min-w-0 cursor-text hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                          :title="item.format === 'mse' ? item.url : (item.tabTitle || currentTabTitle || item.url)"
                          @click.stop="startRename(item.url, getDisplayName(item.url, item))">
                          <span v-if="item.format === 'mse'" class="mr-0.5">{{ item.mseComplete ? '🎬' : '⏺' }}</span>
                          {{ getDisplayName(item.url, item) }}
                        </p>
                        <span v-if="item.detectedAt" class="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0 mt-0.5">
                          {{ getRelativeTime(item.detectedAt) }}
                        </span>
                      </div>

                      <div class="flex items-center gap-1 min-w-0 overflow-hidden whitespace-nowrap">
                        <span :class="getFormatColor(item.format)" class="px-1.5 py-px rounded text-[10px] font-bold tracking-wide uppercase flex-shrink-0 leading-tight">
                          {{ getFormatLabel(item.format) }}
                        </span>

                        <template v-if="item.format === 'mse'">
                          <span class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">
                            {{ item.trackCount ?? 0 }} track{{ (item.trackCount ?? 0) !== 1 ? 's' : '' }}
                          </span>
                          <span v-if="item.size" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">{{ formatFileSize(item.size) }}</span>
                          <span :class="item.mseComplete ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'" class="px-1.5 py-px rounded text-[10px] font-medium flex-shrink-0 leading-tight">
                            {{ item.mseComplete ? '✓ ready' : '● live' }}
                          </span>
                        </template>

                        <template v-else-if="mediaView(item).isStream">
                          <span v-if="item.size" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight" title="Estimated size">{{ formatItemSize(item) }}</span>
                        </template>

                        <template v-else-if="mediaView(item).isVideo">
                          <span v-if="item.width && item.height" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">
                            {{ getResolutionLabel(item.width, item.height) || `${item.width}×${item.height}` }}
                          </span>
                          <span v-if="item.size" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">{{ formatFileSize(item.size) }}</span>
                        </template>

                        <template v-else-if="mediaView(item).isAudio">
                          <span v-if="item.size" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">{{ formatFileSize(item.size) }}</span>
                        </template>

                        <template v-else-if="mediaView(item).isImage">
                          <span v-if="item.width && item.height" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">{{ item.width }}×{{ item.height }}</span>
                          <span v-if="item.size" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">{{ formatFileSize(item.size) }}</span>
                        </template>

                        <template v-else>
                          <span v-if="item.size" class="px-1.5 py-px rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700/80 dark:text-gray-400 flex-shrink-0 leading-tight">{{ formatFileSize(item.size) }}</span>
                        </template>

                        <span v-if="getDomainLabel(item.url)" class="text-[10px] text-gray-400 dark:text-gray-500 truncate flex-shrink min-w-0 leading-tight">
                          · {{ getDomainLabel(item.url) }}
                        </span>
                      </div>
                    </div>

                    <!-- ═══ 操作按钮 ═══ -->
                    <div class="flex items-center gap-1 flex-shrink-0 self-center" @click.stop>
                      <button @click="copyUrl(item.url)"
                        class="w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 active:scale-90 transition-all"
                        :title="t('copyUrl')">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button @click="playUrl(item.url, item.format, item)"
                        :class="[
                          'w-6 h-6 flex items-center justify-center rounded-md text-white active:scale-90 transition-all',
                          isItemPlaying(item)
                            ? 'bg-red-500 hover:bg-red-400'
                            : 'bg-blue-500 hover:bg-blue-400'
                        ]"
                        :title="isItemPlaying(item) ? t('stopPlay') : item.format === 'mse' ? t('download') : t('play')">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <template v-if="isItemPlaying(item)">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            <path stroke-linecap="round" stroke-linejoin="round" d="M10 9v6m4-6v6" />
                          </template>
                          <template v-else-if="item.format === 'mse'">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </template>
                          <template v-else-if="mediaView(item).isAudio">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                          </template>
                          <template v-else-if="mediaView(item).isImage">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                          </template>
                          <template v-else>
                            <path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </template>
                        </svg>
                      </button>
                      <button v-if="item.format !== 'mse'" @click="downloadUrl(item.url, item.format, item.requestHeaders, item.captureId, item.isLiveStream)"
                        :class="['w-6 h-6 flex items-center justify-center rounded-md text-white active:scale-90 transition-all', isLiveRecording(item.url, item.format) ? 'bg-red-500 animate-pulse hover:bg-red-400' : 'bg-green-500 hover:bg-green-400']"
                        :title="isLiveRecording(item.url, item.format) ? (t('stopRecording') || '停止录制') : t('download')">
                        <svg v-if="isLiveRecording(item.url, item.format)" class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                        <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <!-- 展开区域：视频/流媒体播放器 -->
                  <div v-if="playingKey === mediaView(item).key && item.format !== 'mse' && (mediaView(item).isStream || mediaView(item).isVideo)" class="px-3 pb-3">
                    <div class="bg-black rounded-lg overflow-hidden flex items-center justify-center aspect-video">
                      <video
                        :id="'video-player-' + getMediaDomId(item)"
                        class="w-full h-full object-contain bg-black block"
                        controls
                        preload="metadata" />
                    </div>
                  </div>
                  <div v-if="mediaView(item).isAudio && audioPlayingKey === mediaView(item).key" class="px-3 pb-3">
                    <div class="bg-gray-900 dark:bg-gray-950 rounded-lg overflow-hidden p-2 flex flex-col gap-2">
                      <canvas :id="'spectrum-' + getMediaDomId(item)" width="300" height="60" class="w-full h-[60px] rounded bg-gray-950 block" />
                      <audio :id="'audio-player-' + getMediaDomId(item)" :src="item.url" class="w-full h-8" controls />
                    </div>
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
              @click="closePreview()">
              <button @click="closePreview()" 
                class="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div v-if="previewImageIndex >= 0" class="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-white/10 text-white text-xs">
                {{ previewImageIndex + 1 }} / {{ filteredImageList.length }}
              </div>
              <button
                v-if="previewImageIndex > 0"
                @click.stop="previewPrev()"
                class="absolute left-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/25 text-white transition-colors z-10">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <img :src="imageSrc(previewImageUrl, previewCurrentItem?.requestHeaders)" 
                 class="max-w-[90vw] max-h-[88vh] object-contain rounded-lg shadow-2xl"
                 @error="onPreviewImageError"
                 @click.stop />
              <button
                v-if="previewImageIndex >= 0 && previewImageIndex < filteredImageList.length - 1"
                @click.stop="previewNext()"
                class="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/25 text-white transition-colors z-10">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2" @click.stop>
                <button @click="copyUrl(previewImageUrl)"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs transition-colors">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  {{ t('copyUrl') }}
                </button>
                <button @click="downloadUrl(previewImageUrl, previewCurrentItem?.format ?? '', previewCurrentItem?.requestHeaders)"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-xs transition-colors">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {{ t('download') }}
                </button>
              </div>
            </div>
          </Transition>
        </Teleport>

        <footer class="px-3 py-2 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs relative shrink-0 bg-white dark:bg-gray-900">
          <div class="flex items-center gap-1">
            <button @click="openSettings"
              class="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              :title="t('settings')">
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
              :title="t('more')">
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
                  <span>{{ t('feedback') }}</span>
                </a>
                <a href="#" @click.prevent="openHelp" class="flex items-center gap-2 px-3 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{{ t('help') }}</span>
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
      <SettingsView
        v-if="view === 'settings'"
        v-model:settings="settings"
        v-model:exclude-domains-text="excludeDomainsText"
        :saved="settingsSaved"
        :reset-confirm="resetConfirm"
        @close="backToList"
        @save="triggerSave"
        @text-save="triggerTextSave"
        @shortcuts="openShortcuts"
        @reset="handleResetClick"
      />
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

    <!-- ═══ 封面大图悬浮预览（全局单一实例，fixed 定位避免 overflow-hidden 裁剪） ═══ -->
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition-all duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95">
      <div v-if="hoverPreview"
        class="fixed z-[9999] pointer-events-none"
        :style="{
          left: hoverPreview.rect.left + 'px',
          top: hoverPreview.above
            ? (hoverPreview.rect.top - PREVIEW_HEIGHT - 6) + 'px'
            : (hoverPreview.rect.bottom + 6) + 'px',
          transformOrigin: hoverPreview.above ? 'bottom left' : 'top left',
        }">
        <div class="w-52 rounded-xl overflow-hidden shadow-xl shadow-gray-900/15 dark:shadow-black/50 border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900 ring-1 ring-black/5 dark:ring-black/20">
          <div class="aspect-video relative bg-gray-100 dark:bg-gray-900">
            <img v-if="hoverPreview.coverUrl && imageLoadStatus.get(hoverPreview.coverUrl) !== false"
              :src="imageSrc(hoverPreview.coverUrl, hoverPreview.item.requestHeaders)"
              class="w-full h-full object-cover"
              @error="proxyImage($event, hoverPreview!.coverUrl!, hoverPreview!.item.requestHeaders)" />
            <img v-else-if="hoverPreview.thumbDataUrl"
              :src="hoverPreview.thumbDataUrl"
              class="w-full h-full object-cover" />
            <video v-else-if="isVideoFormat(hoverPreview.item.format) && !videoThumbFailed.has(hoverPreview.item.url)"
              :src="hoverPreview.item.url"
              class="w-full h-full object-cover"
              preload="metadata"
              muted
              playsinline />
            <img v-else-if="mediaView(hoverPreview.item).isImage"
              :src="hoverPreview.item.url"
              class="w-full h-full object-cover"
              loading="lazy" />
            <div v-else class="w-full h-full flex items-center justify-center"
              :class="{
                'bg-gradient-to-br from-blue-100 to-blue-200 dark:from-blue-900 dark:to-blue-800': mediaView(hoverPreview.item).isVideo,
                'bg-gradient-to-br from-orange-100 to-orange-200 dark:from-orange-900 dark:to-orange-800': mediaView(hoverPreview.item).isStream,
              }">
              <svg class="w-10 h-10 text-gray-400 dark:text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.361a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
          </div>
          <div class="px-2.5 py-2 bg-white/95 dark:bg-gray-900/95 border-t border-gray-100 dark:border-white/5">
            <p class="text-xs font-medium text-gray-800 dark:text-white/90 truncate leading-snug">{{ getDisplayName(hoverPreview.item.url, hoverPreview.item) }}</p>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span :class="getFormatColor(hoverPreview.item.format)" class="px-1 py-px rounded text-[10px] font-bold uppercase leading-tight">{{ getFormatLabel(hoverPreview.item.format) }}</span>
              <span v-if="hoverPreview.item.width && hoverPreview.item.height" class="text-[10px] text-gray-500 dark:text-white/50">{{ hoverPreview.item.width }}×{{ hoverPreview.item.height }}</span>
              <span v-if="hoverPreview.item.size" class="text-[10px] text-gray-500 dark:text-white/50">{{ formatItemSize(hoverPreview.item) }}</span>
              <span v-if="hoverPreview.item.duration" class="text-[10px] text-gray-500 dark:text-white/50">{{ formatDuration(hoverPreview.item.duration) }}</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>

  </div>
</template>
<style scoped>
.all-tab-scrollbar {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.all-tab-scrollbar::-webkit-scrollbar {
  width: 0;
  height: 0;
}
</style>
