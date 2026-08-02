import { computed, type ShallowRef } from 'vue'
import type { MediaType } from './useMediaFilters'

export interface ViewModelMedia {
  url: string
  format: string
  category?: string
}

export interface MediaViewModel<T> {
  item: T
  key: string
  type: MediaType
  normalizedFormat: string
  fileName: string
  lowerCaseUrl: string
  isStream: boolean
  isVideo: boolean
  isAudio: boolean
  isImage: boolean
}

export function useMediaViewModels<T extends ViewModelMedia>(options: {
  mediaList: ShallowRef<T[]>
  getKey: (item: T) => string
  getType: (format: string, category?: string) => MediaType
  getFileName: (url: string) => string
}) {
  const stableByKey = new Map<string, Omit<MediaViewModel<T>, 'item'>>()
  const snapshot = computed(() => {
    const byItem = new WeakMap<T & object, MediaViewModel<T>>()
    const liveKeys = new Set<string>()
    for (const item of options.mediaList.value) {
      const key = options.getKey(item)
      liveKeys.add(key)
      let stable = stableByKey.get(key)
      if (!stable) {
        const type = options.getType(item.format, item.category)
        stable = {
          key,
          type,
          normalizedFormat: item.format.toLowerCase(),
          fileName: options.getFileName(item.url),
          lowerCaseUrl: item.url.toLowerCase(),
          isStream: type === 'stream',
          isVideo: type === 'video',
          isAudio: type === 'audio',
          isImage: type === 'image',
        }
        stableByKey.set(key, stable)
      }
      byItem.set(item as T & object, { item, ...stable })
    }
    for (const key of stableByKey.keys()) {
      if (!liveKeys.has(key)) stableByKey.delete(key)
    }
    return byItem
  })

  function viewOf(item: T): MediaViewModel<T> {
    const cached = snapshot.value.get(item as T & object)
    if (cached) return cached
    const type = options.getType(item.format, item.category)
    return {
      item,
      key: options.getKey(item),
      type,
      normalizedFormat: item.format.toLowerCase(),
      fileName: options.getFileName(item.url),
      lowerCaseUrl: item.url.toLowerCase(),
      isStream: type === 'stream',
      isVideo: type === 'video',
      isAudio: type === 'audio',
      isImage: type === 'image',
    }
  }

  return { viewOf }
}
