export const RESOLVE_PLAYER_MANIFEST = 'flowpick:resolve-player-manifest'
export const PLAYER_MANIFEST_RESULT = 'flowpick:player-manifest-result'

interface VhsTech {
  el(): Element
  vhs?: {
    mediaSourceUrl_?: string
    source_?: { src?: string }
    playlists?: { media(): unknown }
  }
}

interface VideoJsPlayer {
  tech(options: { IWillNotUseThisInPlugins: boolean }): VhsTech | undefined
  currentSource(): { src?: string } | undefined
}

interface HlsJsInstance {
  media?: HTMLMediaElement
  url?: string
  latestLevelDetails?: unknown
  bufferController?: { media?: HTMLMediaElement; mediaSrc?: string; _objectUrl?: string }
}

function trackHlsJsAttachments() {
  const attached = new WeakMap<HTMLMediaElement, HlsJsInstance>()
  const tracked = new WeakSet<object>()

  function observeGlobal() {
    try {
      const hls = (window as Window & { Hls?: { version?: string; prototype: object } }).Hls
      if (typeof hls?.version !== 'string' || !hls.version.startsWith('1.') || tracked.has(hls.prototype)) return
      const descriptor = Object.getOwnPropertyDescriptor(hls.prototype, 'attachMedia')
      if (typeof descriptor?.value !== 'function') return
      const attachMedia = descriptor.value
      Object.defineProperty(hls.prototype, 'attachMedia', {
        ...descriptor,
        value(this: HlsJsInstance, ...args: unknown[]) {
          const result = Reflect.apply(attachMedia, this, args)
          if (this.media instanceof HTMLMediaElement) attached.set(this.media, this)
          return result
        },
      })
      tracked.add(hls.prototype)
    } catch {
      // An unavailable or unsupported global cannot establish an attachment.
    }
  }

  observeGlobal()
  // The external UMD script exposes Hls before its load event. Observe it
  // before the next script creates players, without intercepting window.Hls.
  document.addEventListener('load', event => {
    if (event.target instanceof HTMLScriptElement) observeGlobal()
  }, true)

  return (element: HTMLMediaElement) => {
    const hls = attached.get(element)
    const buffer = hls?.bufferController
    if (hls?.media === element && buffer?.media === element
      && buffer._objectUrl === element.currentSrc && buffer.mediaSrc === element.currentSrc
      && hls.latestLevelDetails) return hls.url
  }
}

export function installPlayerMediaPick() {
  const page = window as Window & { __flowpickPlayerPickInstalled?: boolean }
  if (page.__flowpickPlayerPickInstalled) return
  page.__flowpickPlayerPickInstalled = true
  const hlsJsManifest = trackHlsJsAttachments()
  const dashJsManifest = trackDashJsAttachments()
  document.addEventListener(RESOLVE_PLAYER_MANIFEST, event => {
    const element = event.composedPath()[0]
    if (!(element instanceof HTMLMediaElement) || !element.currentSrc.startsWith('blob:')
      || element.readyState < HTMLMediaElement.HAVE_METADATA) return
    const videojs = (window as Window & {
      videojs?: { getPlayers(): Record<string, VideoJsPlayer | null> }
    }).videojs
    const sources = new Set<string>()
    try {
      const hlsUrl = hlsJsManifest(element)
      if (hlsUrl && /^https?:\/\//i.test(hlsUrl)) sources.add(hlsUrl)
      const dashUrl = dashJsManifest(element)
      if (dashUrl) sources.add(dashUrl)
      const players = typeof videojs?.getPlayers === 'function' ? videojs.getPlayers() : {}
      for (const player of new Set(Object.values(players))) {
        const tech = player?.tech({ IWillNotUseThisInPlugins: true })
        if (!tech || tech.el() !== element) continue
        // VHS creates and owns this exact object URL for its active source.
        // The player cache alone may already point at the next source.
        const vhs = tech.vhs
        const manifest = vhs?.source_?.src
        if (!manifest || vhs.mediaSourceUrl_ !== element.currentSrc || !vhs.playlists?.media()) continue
        const current = player?.currentSource()?.src
        if (!current) continue
        const url = new URL(manifest, document.baseURI)
        if (!/^https?:$/.test(url.protocol) || new URL(current, document.baseURI).href !== url.href) continue
        sources.add(url.href)
      }
      if (sources.size === 1) {
        element.dispatchEvent(new CustomEvent(PLAYER_MANIFEST_RESULT, { detail: [...sources][0] }))
      }
    } catch {
      // Unsupported player versions or an incomplete source change are ambiguous.
    }
  }, true)
}
import { trackDashJsAttachments } from './dashjs-media-pick'

