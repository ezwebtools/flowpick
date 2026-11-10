import type { PageContext } from './page-session'
import { PLAYER_MANIFEST_RESULT, RESOLVE_PLAYER_MANIFEST } from './player-media-pick'

export type PageMediaPick =
  | { status: 'matched'; url: string }
  | { status: 'manualImage'; url: string; format: string }
  | { status: 'cancelled' | 'inactive' | 'unconfirmed' | 'missing' | 'unavailable' | 'domainExcluded' | 'imageDisabled' }

export function installPageMediaPicker(getContext: () => PageContext) {
  let active: { id: string; cancel: () => void } | undefined

  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== browser.runtime.id) return
    if (message.type === 'CANCEL_PAGE_MEDIA_PICK') {
      if (active?.id === message.id) active?.cancel()
      return
    }
    if (message.type !== 'START_PAGE_MEDIA_PICK') return
    active?.cancel()

    return new Promise<PageMediaPick>(resolve => {
      const start = getContext()
      const events = new AbortController()
      const options = { capture: true, signal: events.signal }
      const outline = document.createElement('div')
      const label = document.createElement('span')
      outline.setAttribute('aria-hidden', 'true')
      outline.dataset.flowpickPicker = ''
      outline.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #2563eb;border-radius:6px;background:#2563eb20'
      label.style.cssText = 'position:absolute;top:0;left:0;background:#2563eb;color:white;font:12px sans-serif;padding:3px 6px'
      label.textContent = 'FlowPick'
      outline.append(label)
      document.documentElement.append(outline)

      const cancel = () => finish({ status: 'cancelled' })
      const inactive = () => finish({ status: 'inactive' })
      const timeout = window.setTimeout(inactive, 60_000)
      active = { id: message.id, cancel }

      function finish(result: PageMediaPick) {
        if (active?.cancel !== cancel) return
        active = undefined
        clearTimeout(timeout)
        events.abort()
        outline.remove()
        resolve(result)
      }

      function mediaAt(event: Event) {
        const path = event.composedPath()
        if (message.imagesOnly === true) return path.find(element => element instanceof HTMLImageElement)
        const media = path.find(
          element => element instanceof HTMLImageElement || element instanceof HTMLMediaElement,
        )
        if (media) return media
        // Video.js controls and poster overlays can be siblings of the tech element.
        const player = path.find(element => element instanceof HTMLElement && element.classList.contains('video-js'))
        if (!(player instanceof HTMLElement)) return
        const candidates = player.querySelectorAll<HTMLMediaElement>('video, audio')
        if (candidates.length === 1) return candidates[0]
      }

      let outlinedNativePlayer: HTMLMediaElement | undefined
      window.addEventListener('pointermove', event => {
        if (event.composedPath().includes(outline)) return
        const element = mediaAt(event)
        const rect = element?.getBoundingClientRect()
        outlinedNativePlayer = element instanceof HTMLMediaElement && element.controls ? element : undefined
        // Native media controls consume click events. While picking, the
        // outline receives clicks over those controls instead.
        outline.style.pointerEvents = outlinedNativePlayer ? 'auto' : 'none'
        outline.style.display = rect ? 'block' : 'none'
        if (rect) Object.assign(outline.style, {
          left: `${rect.left}px`, top: `${rect.top}px`,
          width: `${rect.width}px`, height: `${rect.height}px`,
        })
      }, options)
      window.addEventListener('scroll', () => { outline.style.display = 'none' }, options)
      window.addEventListener('pagehide', inactive, options)
      window.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !event.isTrusted) return
        event.preventDefault()
        event.stopImmediatePropagation()
        cancel()
      }, options)
      window.addEventListener('click', event => {
        let element = mediaAt(event)
        if (outlinedNativePlayer && event.composedPath().includes(outline)) {
          outline.style.pointerEvents = 'none'
          const root = outlinedNativePlayer.getRootNode()
          const hitTestRoot = root instanceof ShadowRoot ? root : document
          if (hitTestRoot.elementFromPoint(event.clientX, event.clientY) === outlinedNativePlayer) {
            element = outlinedNativePlayer
          }
          outline.style.pointerEvents = 'auto'
        }
        if (element) void pickMedia(event, element)
      }, options)

      async function pickMedia(event: MouseEvent, element: HTMLMediaElement | HTMLImageElement) {
        if (!event.isTrusted) return
        event.preventDefault()
        event.stopImmediatePropagation()
        const context = getContext()
        if (context.revision !== start.revision) return inactive()
        const source = element instanceof HTMLMediaElement
          ? readyMediaSource(element) : element.currentSrc || element.src
        const kind = element instanceof HTMLImageElement ? 'image' : element instanceof HTMLAudioElement ? 'audio' : 'video'
        const blobPlayer = element instanceof HTMLMediaElement && source?.startsWith('blob:')
        const url = blobPlayer ? resolvePlayerManifest(element) : source
        if (!url || url.startsWith('blob:')) {
          finish({ status: 'unconfirmed' })
          return
        }

        events.abort()
        outline.remove()
        try {
          const sync = await browser.runtime.sendMessage({ type: 'PAGE_SESSION_SYNC', pageContext: context })
          if (!sync?.ok) return inactive()
          const result: PageMediaPick = await browser.runtime.sendMessage({
            type: 'MATCH_PAGE_MEDIA_PICK', url,
            kind, blobPlayer,
            imageLoaded: element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
            pageContext: context, sessionId: sync.sessionId,
          })
          if (getContext().revision !== context.revision) return inactive()
          if (element instanceof HTMLMediaElement && (readyMediaSource(element) !== source
            || (blobPlayer && resolvePlayerManifest(element) !== url))) {
            finish({ status: 'unconfirmed' })
            return
          }
          finish(result)
        } catch {
          finish({ status: 'unavailable' })
        }
      }
    })
  })
}

function readyMediaSource(element: HTMLMediaElement): string | undefined {
  const { currentSrc, src, srcObject, readyState } = element
  // A source assignment can precede the browser's update to currentSrc.
  if (srcObject || readyState < HTMLMediaElement.HAVE_METADATA || !currentSrc
    || (src && src !== currentSrc)) return
  return currentSrc
}

function resolvePlayerManifest(element: HTMLMediaElement): string | undefined {
  const urls = new Set<string>()
  const receive = (event: Event) => {
    const url = (event as CustomEvent<unknown>).detail
    if (event.target === element && typeof url === 'string' && /^https?:\/\//i.test(url)) urls.add(url)
  }
  element.addEventListener(PLAYER_MANIFEST_RESULT, receive)
  try {
    element.dispatchEvent(new Event(RESOLVE_PLAYER_MANIFEST, { composed: true }))
  } finally {
    element.removeEventListener(PLAYER_MANIFEST_RESULT, receive)
  }
  return urls.size === 1 ? [...urls][0] : undefined
}
