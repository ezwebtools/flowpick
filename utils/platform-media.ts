/**
 * A small provider-neutral contract between platform adapters and the
 * extension background.  Adapters discover page data; the background owns
 * validation, grouping and the download hand-off.
 */
export interface PlatformMediaCandidate {
  url: string
  format?: string
  /** A separate audio track is attached to video variants instead of rendered as a card. */
  role?: 'video' | 'audio'
  label?: string
  width?: number
  height?: number
  bandwidth?: number
  duration?: number
}

export interface PlatformMediaTask {
  provider: string
  key: string
  title?: string
  coverUrl?: string
  duration?: number
  referer?: string
  /** Higher-priority player/API data must not be replaced by a DOM fallback. */
  priority?: number
  candidates: PlatformMediaCandidate[]
}
