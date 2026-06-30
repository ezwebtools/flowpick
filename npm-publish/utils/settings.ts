export type SniffingGroup = 'streaming' | 'video' | 'audio' | 'image'

export interface SniffingRule {
  enabled: boolean
  minSizeKB: number
}

export type SniffingRules = Record<SniffingGroup, SniffingRule>

export interface Settings {
  sniffingRules: SniffingRules
  excludeDomains: string[]
}

export const DEFAULT_SNIFFING_RULES: SniffingRules = {
  streaming: { enabled: true,  minSizeKB: 0 },
  video:     { enabled: true,  minSizeKB: 0 },
  audio:     { enabled: true,  minSizeKB: 0 },
  image:     { enabled: true, minSizeKB: 0 },
}

export const DEFAULT_SETTINGS: Settings = {
  sniffingRules: {
    streaming: { ...DEFAULT_SNIFFING_RULES.streaming },
    video:     { ...DEFAULT_SNIFFING_RULES.video },
    audio:     { ...DEFAULT_SNIFFING_RULES.audio },
    image:     { ...DEFAULT_SNIFFING_RULES.image },
  },
  excludeDomains: [],
}

const SETTINGS_KEY = 'ext_settings'

function toStringArray(val: any): string[] {
  if (Array.isArray(val)) return val.filter(v => typeof v === 'string')
  if (val && typeof val === 'object') return Object.values(val).filter(v => typeof v === 'string') as string[]
  return []
}

function parseSniffingRules(stored: any): SniffingRules {
  const groups: SniffingGroup[] = ['streaming', 'video', 'audio', 'image']
  const result = {} as SniffingRules
  for (const g of groups) {
    const def = DEFAULT_SNIFFING_RULES[g]
    const raw = stored?.[g]
    if (raw && typeof raw === 'object' && 'enabled' in raw) {
      result[g] = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : def.enabled,
        minSizeKB: typeof raw.minSizeKB === 'number' ? raw.minSizeKB : def.minSizeKB,
      }
    } else if (typeof raw === 'boolean') {
      result[g] = { enabled: raw, minSizeKB: def.minSizeKB }
    } else {
      result[g] = { ...def }
    }
  }
  return result
}

export async function loadSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY)
  const stored = result[SETTINGS_KEY] as any
  if (!stored || typeof stored !== 'object') {
    return {
      sniffingRules: { ...DEFAULT_SETTINGS.sniffingRules },
      excludeDomains: [],
    }
  }
  return {
    sniffingRules: parseSniffingRules(stored.sniffingRules ?? stored.sniffingGroups),
    excludeDomains: toStringArray(stored.excludeDomains),
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: {
      sniffingRules: settings.sniffingRules,
      excludeDomains: Array.from(settings.excludeDomains),
    }
  })
}

export const STREAMING_FORMATS = ['m3u8', 'mpd']
export const VIDEO_FORMATS = ['mp4', 'webm', 'ogv', 'flv', 'mkv', 'mov', 'avi', '3gp', '3g2', 'ts', 'mpeg']
export const AUDIO_FORMATS = ['mp3', 'm4a', 'oga', 'weba', 'wav', 'flac', 'aac']
export const IMAGE_FORMATS = ['gif', 'jpg', 'png', 'webp', 'svg']

export function getFormatGroup(format: string): SniffingGroup | null {
  const f = format.toLowerCase()
  if (STREAMING_FORMATS.includes(f)) return 'streaming'
  if (VIDEO_FORMATS.includes(f)) return 'video'
  if (AUDIO_FORMATS.includes(f)) return 'audio'
  if (IMAGE_FORMATS.includes(f)) return 'image'
  return null
}

export function isFormatAllowed(format: string, settings: Settings): boolean {
  const group = getFormatGroup(format.toLowerCase())
  if (!group) return false
  return settings.sniffingRules[group].enabled
}

export function isSizeAllowed(format: string, contentLength: number | undefined, settings: Settings): boolean {
  if (contentLength === undefined) return true
  const group = getFormatGroup(format.toLowerCase())
  if (!group) return true
  const minSizeKB = settings.sniffingRules[group].minSizeKB
  if (minSizeKB <= 0) return true
  return contentLength >= minSizeKB * 1024
}

const _HIDDEN_EXCLUDED_DOMAINS = [
  'ezwebtools.net',
  'flowpick.net',
  'youtube.com',
]

export function isDomainExcluded(url: string, settings: Settings): boolean {
  try {
    const hostname = new URL(url).hostname
    const userExcluded = settings.excludeDomains.some(domain => {
      const d = domain.trim().toLowerCase()
      if (!d) return false
      return hostname === d
    })
    if (userExcluded) return true
    return _HIDDEN_EXCLUDED_DOMAINS.some(domain => {
      return hostname === domain.toLowerCase()
    })
  } catch {
    return false
  }
}
