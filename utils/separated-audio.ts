/** Keep an explicitly paired audio track under the visible player's controls. */
export function syncSeparatedAudio(media: HTMLMediaElement, audio: HTMLAudioElement, onError: () => void): () => void {
  let disposed = false
  let playGeneration = 0
  const syncTime = () => {
    if (Math.abs(audio.currentTime - media.currentTime) > 0.18) audio.currentTime = media.currentTime
  }
  const syncControls = () => {
    audio.playbackRate = media.playbackRate
    audio.volume = media.volume
    audio.muted = media.muted
  }
  const start = () => {
    if (disposed || media.paused || media.ended) return
    syncTime(); syncControls()
    const generation = ++playGeneration
    void audio.play().catch(() => { if (!disposed && generation === playGeneration && !media.paused) onError() })
  }
  const pause = () => { playGeneration++; audio.pause() }
  const seek = () => { pause(); syncTime() }
  const fail = () => { if (!disposed) { pause(); onError() } }
  const events = {
    play: start, playing: start, pause, ended: pause, waiting: pause,
    seeking: seek, seeked: start, timeupdate: syncTime,
    ratechange: syncControls, volumechange: syncControls,
  }
  for (const [event, listener] of Object.entries(events)) media.addEventListener(event, listener)
  audio.addEventListener('error', fail)
  syncControls()
  start()
  return () => {
    if (disposed) return
    disposed = true
    for (const [event, listener] of Object.entries(events)) media.removeEventListener(event, listener)
    audio.removeEventListener('error', fail)
    audio.pause(); audio.removeAttribute('src'); audio.load()
  }
}
