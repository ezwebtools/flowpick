import { computed, onUnmounted, ref, watch, type Ref, type ShallowRef } from 'vue'
import { getFormatGroup, type Settings } from '../../../utils/settings'

export type MediaType = 'stream' | 'video' | 'audio' | 'image' | 'doc' | 'other'

export interface FilterableMedia {
  url: string
  format: string
  size?: number
  width?: number
  height?: number
  category?: string
  detectedAt?: number
  groupRole?: string
}

export function useMediaFilters<T extends FilterableMedia>(options: {
  mediaList: ShallowRef<T[]>
  settings: Ref<Settings>
  getType: (format: string, category?: string) => MediaType
  isStream: (format: string) => boolean
  isSegment: (item: T) => boolean
  formatGroups: Record<Exclude<MediaType, 'other'>, string[]>
  getFormatLabel: (format: string) => string
}) {
  const activeTab = ref<Exclude<MediaType, 'other'>>('stream')
  const typeFilter = ref('any')
  const sizeFilter = ref({ min: 0, max: 0 })
  const dimensionFilter = ref({ minWidth: 0, minHeight: 0 })
  const resolutionFilter = ref('any')
  const sortOrder = ref<'asc' | 'desc'>('asc')

  const mediaCatalog = computed(() => {
    const all: T[] = []
    const byType: Record<MediaType, T[]> = { stream: [], video: [], audio: [], image: [], doc: [], other: [] }
    const counts = { all: 0, stream: 0, video: 0, audio: 0, image: 0, doc: 0 }
    for (const item of options.mediaList.value) {
      if (options.settings.value.hideStreamSegments && options.isSegment(item)) continue
      if (!options.isStream(item.format) && item.format !== 'mse' && item.size != null) {
        const group = getFormatGroup(item.format)
        const minKB = group ? options.settings.value.sniffingRules[group]?.minSizeKB ?? 0 : 0
        if (minKB > 0 && item.size < minKB * 1024) continue
      }
      const type = options.getType(item.format, item.category)
      all.push(item)
      byType[type].push(item)
      // A stream master represents all of its quality variants.  Do not
      // inflate the global sniff count with children that are only shown after
      // expanding that master card.
      // Provider groups can use direct MP4 variants, which classify as video
      // rather than stream. Count their children only through the master.
      const isGroupChild = item.groupRole === 'variant' || item.groupRole === 'audio' || item.groupRole === 'segment'
      if (!isGroupChild) counts.all++
      if (type === 'stream') {
        if (!isGroupChild) counts.stream++
      } else if (type !== 'other' && !isGroupChild) counts[type]++
    }
    return { all, byType, counts }
  })

  const searchQuery = ref('')
  const debouncedSearchQuery = ref('')
  const useRegex = ref(false)
  const regexValid = ref(true)
  const searchError = ref('')
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  watch([searchQuery, useRegex], () => {
    const query = searchQuery.value.trim()
    if (useRegex.value && query) {
      try {
        new RegExp(query, 'i')
        regexValid.value = true
        searchError.value = ''
      } catch (error) {
        regexValid.value = false
        searchError.value = (error as Error).message
      }
    } else {
      regexValid.value = true
      searchError.value = ''
    }
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      debouncedSearchQuery.value = query
      searchTimer = null
    }, 120)
  })

  const compiledRegex = computed(() => {
    const query = debouncedSearchQuery.value
    if (!useRegex.value || !query || !regexValid.value) return null
    try { return new RegExp(query, 'i') } catch { return null }
  })

  const filteredMediaList = computed(() => {
    let list = activeTab.value === 'all'
      ? mediaCatalog.value.all
      : mediaCatalog.value.byType[activeTab.value]
    if (typeFilter.value !== 'any') list = list.filter(item => item.format.toLowerCase() === typeFilter.value)
    const query = debouncedSearchQuery.value
    if (query && regexValid.value) {
      const regex = compiledRegex.value
      const lowered = query.toLowerCase()
      list = list.filter(item => regex ? regex.test(item.url) : item.url.toLowerCase().includes(lowered))
    }
    list = list.filter(item => {
      if (sizeFilter.value.min > 0 && (item.size ?? 0) < sizeFilter.value.min * 1024) return false
      if (sizeFilter.value.max > 0 && (item.size ?? 0) > sizeFilter.value.max * 1024) return false
      if (activeTab.value === 'image') {
        if (dimensionFilter.value.minWidth > 0 && (item.width ?? 0) < dimensionFilter.value.minWidth) return false
        if (dimensionFilter.value.minHeight > 0 && (item.height ?? 0) < dimensionFilter.value.minHeight) return false
      }
      if (activeTab.value === 'video' && resolutionFilter.value !== 'any') {
        const height = Math.min(item.width ?? 0, item.height ?? 0)
        const minimums: Record<string, number> = { '8k': 4320, '4k': 2160, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
        if (resolutionFilter.value === 'sd') return height < 360
        if ((minimums[resolutionFilter.value] ?? 0) > height) return false
      }
      return true
    })
    const direction = sortOrder.value === 'asc' ? 1 : -1
    return [...list].sort((a, b) => ((a.detectedAt ?? 0) - (b.detectedAt ?? 0)) * direction)
  })

  const typeOptions = computed(() => {
    const tabMedia = activeTab.value === 'all' ? mediaCatalog.value.all : mediaCatalog.value.byType[activeTab.value]
    const counts: Record<string, number> = {}
    tabMedia.forEach(item => { const format = item.format.toLowerCase(); counts[format] = (counts[format] ?? 0) + 1 })
    const formats = activeTab.value === 'all'
      ? Object.values(options.formatGroups).flat()
      : options.formatGroups[activeTab.value]
    return [...new Set(formats)].map(format => ({
      value: format,
      label: options.getFormatLabel(format),
      count: counts[format] ?? 0,
      disabled: !counts[format],
    })).sort((a, b) => a.disabled === b.disabled ? b.count - a.count : a.disabled ? 1 : -1)
  })

  function clearSearch() {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
    searchQuery.value = ''
    debouncedSearchQuery.value = ''
    searchError.value = ''
  }

  onUnmounted(() => { if (searchTimer) clearTimeout(searchTimer) })

  return {
    activeTab, typeFilter, sizeFilter, dimensionFilter, resolutionFilter, sortOrder,
    mediaCatalog, sizeFilteredMediaList: computed(() => mediaCatalog.value.all),
    tabCounts: computed(() => mediaCatalog.value.counts), typeOptions,
    searchQuery, useRegex, regexValid, searchError, clearSearch, filteredMediaList,
    filteredImageList: computed(() => filteredMediaList.value.filter(item => options.getType(item.format, item.category) === 'image')),
  }
}
