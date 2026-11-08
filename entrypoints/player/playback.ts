import type { PlayerSession } from '../../utils/media-player-tabs'
import { t } from '../../utils/i18n'
import { loadDash, loadHls, loadMpegts } from '../popup/composables/useStreamThumbnails'
import { createHlsProxyLoader } from '../popup/utils/hlsProxyLoader'
import { cloneMediaItem } from '../../utils/media-message'
import { syncSeparatedAudio } from '../../utils/separated-audio'

/** Own every resource synchronously, including libraries still loading on close. */
export function attachPlayer(media: HTMLMediaElement, session: PlayerSession, onError: (message: string) => void): () => void {
  session = { ...session, item: cloneMediaItem(session.item) }
  let disposed = false
  const cleanup: Array<() => void> = []
  const alive = () => !disposed && media.isConnected
  const fail = (message: string) => {
    if (disposed) return
    media.pause()
    onError(message)
  }
  const play = () => media.play().catch(error => {
    // Native controls remain available when the browser blocks autoplay.
    if (error?.name !== 'NotAllowedError' && alive()) fail(t('unplayable'))
  })
  const prepare = async (url: string) => {
    const result = await browser.runtime.sendMessage({
      type: 'PREPARE_MEDIA_PLAYBACK', url, format: session.item.format,
      referrer: session.referrer, requestHeaders: session.item.requestHeaders,
    })
    if (!result?.ok) throw new Error(t('unplayable'))
    if (result.drm) throw new Error(t('drmProtected'))
  }
  const encrypted = () => fail(t('drmProtected'))
  media.addEventListener('encrypted', encrypted)
  cleanup.push(() => media.removeEventListener('encrypted', encrypted))

  void (async () => {
    const item = session.item
    const format = item.format.toLowerCase()
    await prepare(item.url)
    if (!alive()) return
    if (format === 'm3u8') {
      const Hls = await loadHls()
      if (!alive()) return
      if (!Hls.isSupported()) {
        if (!media.canPlayType('application/vnd.apple.mpegurl')) throw new Error(t('unplayable'))
        media.src = item.url
        await play()
        return
      }
      let hls: InstanceType<typeof Hls> | undefined
      const start = (proxy: boolean) => {
        if (!alive()) return
        hls?.destroy()
        hls = new Hls({ enableWorker: true, backBufferLength: 90,
          ...(proxy ? { loader: createHlsProxyLoader({ requestHeaders: item.requestHeaders, referrer: session.referrer }) } : {}),
        })
        const current = hls
        current.on(Hls.Events.MANIFEST_PARSED, () => { if (alive()) void play() })
        current.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || current !== hls || !alive()) return
          if (!proxy && data.type === Hls.ErrorTypes.NETWORK_ERROR) { queueMicrotask(() => start(true)); return }
          fail(t('playError') + data.details)
          current.destroy()
        })
        current.loadSource(item.url)
        current.attachMedia(media)
      }
      cleanup.push(() => hls?.destroy())
      start(false)
    } else if (format === 'mpd') {
      const dashjs = await loadDash()
      if (!alive()) return
      const dash = dashjs.MediaPlayer().create()
      cleanup.push(() => dash.reset())
      dash.on(dashjs.MediaPlayer.events.ERROR, () => fail(t('unplayable')))
      dash.initialize(media as HTMLVideoElement, item.url, true)
    } else if (format === 'flv' || format === 'ts') {
      const mts = await loadMpegts()
      if (!alive()) return
      if (!mts.isSupported()) throw new Error(t('unplayable'))
      const player = mts.createPlayer({ type: format === 'ts' ? 'mpegts' : 'flv', url: item.url, isLive: item.isLiveStream ?? !item.duration },
        { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true, headers: item.requestHeaders || {} })
      cleanup.push(() => player.destroy())
      player.on(mts.Events.ERROR, () => fail(t('unplayable')))
      player.attachMediaElement(media)
      player.load()
      await play()
    } else {
      const audioUrl = item.audioUrl || item.audioOptions?.[0]?.url
      if (audioUrl) {
        await prepare(audioUrl)
        if (!alive()) return
        const audio = new Audio()
        audio.src = audioUrl
        cleanup.push(syncSeparatedAudio(media, audio, () => fail(t('audioPlayError'))))
      }
      media.src = item.url
      await play()
    }
  })().catch(error => { if (alive()) fail(error instanceof Error ? error.message : t('unplayable')) })

  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of cleanup.reverse()) { try { dispose() } catch {} }
    media.pause(); media.removeAttribute('src'); media.load()
  }
}
