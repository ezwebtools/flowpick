import { onUnmounted, ref, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type HlsInstance from 'hls.js'
import type { MediaPlayerClass as DashPlayer } from 'dashjs'
import type mpegts from 'mpegts.js'

let hlsLoader: Promise<typeof import('hls.js')['default']> | null = null
let dashLoader: Promise<typeof import('dashjs')> | null = null
let mpegtsLoader: Promise<typeof import('mpegts.js')['default']> | null = null
export const loadHls = () => hlsLoader ??= import('hls.js').then(module => module.default)
export const loadDash = () => dashLoader ??= import('dashjs')
export const loadMpegts = () => mpegtsLoader ??= import('mpegts.js').then(module => module.default)

export interface StreamThumbnailItem {
  url: string
  format: string
  duration?: number
}

export function useStreamThumbnails<T extends StreamThumbnailItem>(options: {
  mediaList: ShallowRef<T[]>
  mediaByUrl: ComputedRef<Map<string, T>>
  listContainerRef: Ref<HTMLElement | null>
  patchDuration: (item: T, duration: number) => T | undefined
  persistMeta: (item: T) => void
  captureFrame: (video: HTMLVideoElement) => string | undefined
}) {
  const hlsInstances = new Map<string, HlsInstance>()
  const dashInstances = new Map<string, DashPlayer>()
  const mpegtsInstances = new Map<string, mpegts.Player>()
  const failed = ref<Set<string>>(new Set())
  const cache = ref<Map<string, string>>(new Map())
  const failureAttempts = new Map<string, number>()
  const failureTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const queue = new Map<string, { item: T; video: HTMLVideoElement; priority: number }>()
  const active = new Set<string>()
  const timeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const observed = new Map<string, HTMLVideoElement>()
  let observer: IntersectionObserver | null = null
  let disposed = false

  const CACHE_LIMIT = 50
  const CACHE_MEMORY_LIMIT = 12 * 1024 * 1024
  const CONCURRENCY = 2
  const TIMEOUT_MS = 12_000
  const MAX_RETRIES = 3
  const RETRY_BASE_MS = 15_000
  const MAX_COOLDOWN_MS = 5 * 60_000

  function touch(url: string): string | undefined {
    const data = cache.value.get(url)
    if (!data) return
    const newest = [...cache.value.keys()].at(-1)
    if (newest !== url) {
      const next = new Map(cache.value)
      next.delete(url)
      next.set(url, data)
      cache.value = next
    }
    return data
  }

  function clearFailure(url: string) {
    const timer = failureTimers.get(url)
    if (timer) clearTimeout(timer)
    failureTimers.delete(url)
    failureAttempts.delete(url)
    if (failed.value.has(url)) {
      const next = new Set(failed.value)
      next.delete(url)
      failed.value = next
    }
  }

  function store(url: string, data: string) {
    clearFailure(url)
    const next = new Map(cache.value)
    next.delete(url)
    next.set(url, data)
    const estimatedBytes = () => {
      let total = 0
      next.forEach((value, key) => { total += (value.length + key.length) * 2 })
      return total
    }
    while (next.size > CACHE_LIMIT || estimatedBytes() > CACHE_MEMORY_LIMIT) {
      const oldest = next.keys().next().value
      if (oldest === undefined) break
      next.delete(oldest)
    }
    cache.value = next
  }

  function cleanup(url: string) {
    const timeout = timeouts.get(url)
    if (timeout) clearTimeout(timeout)
    timeouts.delete(url)
    const hls = hlsInstances.get(url)
    if (hls) { hls.destroy(); hlsInstances.delete(url) }
    const dash = dashInstances.get(url)
    if (dash) { dash.destroy(); dashInstances.delete(url) }
    const mts = mpegtsInstances.get(url)
    if (mts) { try { mts.destroy() } catch {}; mpegtsInstances.delete(url) }
    const video = observed.get(url)
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.removeAttribute('data-hls-attached')
      video.removeAttribute('data-dash-attached')
      video.load()
    }
    active.delete(url)
    queue.delete(url)
    queueMicrotask(pump)
  }

  function markFailure(url: string) {
    if (failed.value.has(url)) return
    const attempts = Math.min((failureAttempts.get(url) ?? 0) + 1, MAX_RETRIES)
    failureAttempts.set(url, attempts)
    failed.value = new Set(failed.value).add(url)
    cleanup(url)
    const previous = failureTimers.get(url)
    if (previous) clearTimeout(previous)
    const cooldown = attempts >= MAX_RETRIES ? MAX_COOLDOWN_MS : RETRY_BASE_MS * 2 ** (attempts - 1)
    failureTimers.set(url, setTimeout(() => {
      failureTimers.delete(url)
      const next = new Set(failed.value)
      next.delete(url)
      failed.value = next
      if (attempts >= MAX_RETRIES) failureAttempts.delete(url)
    }, cooldown))
  }

  async function setup(item: T, video: HTMLVideoElement) {
    const url = item.url
    if (hlsInstances.has(url) || dashInstances.has(url) || mpegtsInstances.has(url)) return
    let durationResolved = Boolean(item.duration)
    const persistDuration = (duration: number) => {
      if (!Number.isFinite(duration) || duration <= 0 || durationResolved) return
      durationResolved = true
      const updated = options.patchDuration(item, duration)
      if (updated) options.persistMeta(updated)
      if (cache.value.has(url)) queueMicrotask(() => cleanup(url))
    }
    const ready = () => {
      persistDuration(video.duration)
      try { video.pause(); video.currentTime = 0.1 } catch {}
    }
    const seeked = () => {
      if (cache.value.has(url)) {
        if (durationResolved) cleanup(url)
        return
      }
      const frame = options.captureFrame(video)
      if (frame) {
        store(url, frame)
        if (durationResolved) cleanup(url)
      }
    }
    video.addEventListener('loadeddata', ready, { once: true })
    video.addEventListener('seeked', seeked, { once: true })
    const current = () => !disposed && active.has(url) && video.isConnected
    try {
      if (item.format === 'm3u8') {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; return }
        const Hls = await loadHls()
        if (!current()) return
        if (!Hls.isSupported()) { markFailure(url); return }
        const hls = new Hls({ enableWorker: true, maxBufferLength: 5 })
        hlsInstances.set(url, hls)
        hls.loadSource(url)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, ready)
        // MANIFEST_PARSED 时 video.duration 经常仍为 NaN/Infinity；媒体码表加载后
        // details.totalduration 才是 VOD HLS 的可靠总时长。
        hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          persistDuration(data.details.totalduration)
        })
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) markFailure(url) })
      } else if (item.format === 'mpd') {
        const dashjs = await loadDash()
        if (!current()) return
        const dash = dashjs.MediaPlayer().create()
        dashInstances.set(url, dash)
        dash.initialize(video, url, false)
        dash.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
          persistDuration(dash.duration())
          ready()
        })
        dash.on(dashjs.MediaPlayer.events.ERROR, () => markFailure(url))
      } else if (item.format === 'flv' || item.format === 'ts') {
        // HTTP-FLV / MPEG-TS 直播流：用 mpegts.js demux → MSE 喂给 <video>
        const mts = await loadMpegts()
        if (!current()) return
        if (!mts.isSupported()) { markFailure(url); return }
        const player = mts.createPlayer({
          type: item.format === 'ts' ? 'mpegts' : 'flv',
          url: url,
          isLive: !item.duration, // 无 duration 视为直播
        }, {
          enableWorker: true,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
        })
        mpegtsInstances.set(url, player)
        player.on(mts.Events.ERROR, () => markFailure(url))
        player.on(mts.Events.LOADING_COMPLETE, () => {
          // VOD 流加载完成
          if (!durationResolved && Number.isFinite(video.duration)) persistDuration(video.duration)
        })
        player.attachMediaElement(video)
        player.load()
        // 直播流没有 duration，loadedmetadata 后 duration 会是 Infinity
        video.addEventListener('loadedmetadata', () => {
          if (Number.isFinite(video.duration) && video.duration > 0) {
            persistDuration(video.duration)
          } else {
            // 直播流：直接截首帧
            ready()
          }
        }, { once: true })
      }
    } catch {
      if (current()) markFailure(url)
    }
  }

  function pump() {
    if (disposed) return
    while (active.size < CONCURRENCY && queue.size) {
      const entry = [...queue.entries()].reduce<typeof queue extends Map<infer K, infer V> ? [K, V] | undefined : never>(
        (best, candidate) => !best || candidate[1].priority < best[1].priority ? candidate : best,
        undefined,
      )
      if (!entry) break
      const [url, task] = entry
      queue.delete(url)
      if (!task.video.isConnected || (cache.value.has(url) && task.item.duration) || failed.value.has(url)) continue
      active.add(url)
      timeouts.set(url, setTimeout(() => markFailure(url), TIMEOUT_MS))
      void setup(task.item, task.video)
    }
  }

  function enqueue(item: T, video: HTMLVideoElement, priority = 0) {
    const url = item.url
    if (disposed || (cache.value.has(url) && item.duration) || failed.value.has(url)) return
    if (active.has(url) || hlsInstances.has(url) || dashInstances.has(url) || mpegtsInstances.has(url)) return
    const queued = queue.get(url)
    if (!queued || priority < queued.priority || queued.video !== video) queue.set(url, { item, video, priority })
    pump()
  }

  function resetObserver() {
    observer?.disconnect()
    observer = null
  }

  function ensureObserver() {
    if (observer || !options.listContainerRef.value) return
    observer = new IntersectionObserver(entries => {
      const root = options.listContainerRef.value?.getBoundingClientRect()
      const center = root ? (root.top + root.bottom) / 2 : window.innerHeight / 2
      for (const entry of entries) {
        const video = entry.target as HTMLVideoElement
        const url = video.dataset.streamThumbUrl
        if (!url) continue
        const item = options.mediaByUrl.value.get(url)
        if (entry.isIntersecting && item) {
          enqueue(item, video, Math.abs((entry.boundingClientRect.top + entry.boundingClientRect.bottom) / 2 - center))
        } else {
          queue.delete(url)
          if (active.has(url)) cleanup(url)
        }
      }
    }, { root: options.listContainerRef.value, rootMargin: '240px 0px', threshold: 0.01 })
  }

  function observe(el: unknown, item: T) {
    const previous = observed.get(item.url)
    if (previous && previous !== el) observer?.unobserve(previous)
    if (!(el instanceof HTMLVideoElement)) {
      observed.delete(item.url)
      queue.delete(item.url)
      if (active.has(item.url)) cleanup(item.url)
      return
    }
    ensureObserver()
    el.dataset.streamThumbUrl = item.url
    observed.set(item.url, el)
    observer?.observe(el)
  }

  watch(options.mediaList, () => {
    const urls = new Set(options.mediaList.value.map(item => item.url))
    for (const url of [...hlsInstances.keys(), ...dashInstances.keys(), ...mpegtsInstances.keys(), ...queue.keys()]) {
      if (!urls.has(url)) cleanup(url)
    }
  })

  function dispose() {
    disposed = true
    resetObserver()
    queue.clear()
    timeouts.forEach(clearTimeout); timeouts.clear()
    failureTimers.forEach(clearTimeout); failureTimers.clear()
    failureAttempts.clear()
    active.clear()
    hlsInstances.forEach(instance => instance.destroy()); hlsInstances.clear()
    dashInstances.forEach(instance => instance.destroy()); dashInstances.clear()
    mpegtsInstances.forEach(instance => { try { instance.destroy() } catch {} }); mpegtsInstances.clear()
    observed.clear()
  }

  onUnmounted(dispose)
  return { cache, failed, touch, store, observe, resetObserver }
}
