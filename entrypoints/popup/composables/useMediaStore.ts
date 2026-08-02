import { computed, shallowRef } from 'vue'

export interface MediaStoreItem {
  url: string
  duration?: number
  width?: number
  height?: number
  size?: number
}

export interface ListUpdateMessage<TRaw> {
  type: string
  tabId?: number
  list?: TRaw[]
}

export function useMediaStore<T extends MediaStoreItem, TRaw>(options: {
  getKey: (item: T) => string
  normalize: (item: TRaw) => T
  getCurrentTabId: () => number | undefined
  onCommitted?: () => void
  coalesceMs?: number
}) {
  const mediaList = shallowRef<T[]>([])
  const mediaLookup = computed(() => {
    const byKey = new Map<string, T>()
    const indexByKey = new Map<string, number>()
    const byUrl = new Map<string, T>()
    mediaList.value.forEach((item, index) => {
      const key = options.getKey(item)
      byKey.set(key, item)
      indexByKey.set(key, index)
      if (!byUrl.has(item.url)) byUrl.set(item.url, item)
    })
    return { byKey, indexByKey, byUrl }
  })

  function replace(list: TRaw[] | T[]) {
    mediaList.value = list.map(item => options.normalize(item as TRaw))
  }

  function patchOne(key: string, patch: Partial<T>): T | undefined {
    const index = mediaLookup.value.indexByKey.get(key)
    if (index === undefined) return
    const next = { ...mediaList.value[index], ...patch }
    const list = mediaList.value.slice()
    list[index] = next
    mediaList.value = list
    return next
  }

  function patchMany(patches: Map<string, Partial<T>>) {
    if (!patches.size) return
    const list = mediaList.value.slice()
    let changed = false
    for (const [key, patch] of patches) {
      const index = mediaLookup.value.indexByKey.get(key)
      if (index === undefined) continue
      list[index] = { ...list[index], ...patch }
      changed = true
    }
    if (changed) mediaList.value = list
  }

  let pending: ListUpdateMessage<TRaw> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function flush() {
    timer = null
    const message = pending
    pending = null
    if (!message?.list || message.tabId !== options.getCurrentTabId()) return
    const oldByKey = mediaLookup.value.byKey
    mediaList.value = message.list.map(raw => {
      const item = options.normalize(raw)
      const old = oldByKey.get(options.getKey(item))
      if (!old) return item
      return {
        ...item,
        duration: item.duration || old.duration,
        width: item.width || old.width,
        height: item.height || old.height,
        size: item.size || old.size,
      }
    })
    options.onCommitted?.()
  }

  function handleListUpdate(message: ListUpdateMessage<TRaw>) {
    if (message.type !== 'LIST_UPDATED' || message.tabId !== options.getCurrentTabId() || !message.list) return
    pending = message
    if (timer === null) timer = setTimeout(flush, options.coalesceMs ?? 80)
  }

  function clear() {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
    mediaList.value = []
  }

  function dispose() {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }

  return {
    mediaList,
    mediaLookup,
    mediaByKey: computed(() => mediaLookup.value.byKey),
    mediaIndexByKey: computed(() => mediaLookup.value.indexByKey),
    mediaByUrl: computed(() => mediaLookup.value.byUrl),
    replace,
    patchOne,
    patchMany,
    handleListUpdate,
    clear,
    dispose,
  }
}
