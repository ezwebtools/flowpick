export interface RawMediaEntry {
  url?: string
  format?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  coverUrl?: string
  detectedAt?: number
  category?: string
  requestHeaders?: Record<string, string>
  captureId?: string
  trackCount?: number
  mseComplete?: boolean
  groupId?: string
  groupRole?: 'master' | 'variant' | 'audio' | 'segment'
  groupLabel?: string
  groupMasterId?: string
  variantBandwidth?: number
  audioUrl?: string
  /** Structured audio choices for a site-specific separated A/V task. */
  audioOptions?: Array<{ url: string, label: string }>
  tabTitle?: string
  /** 直播流标记（HTTP-FLV 无 Content-Length/Duration 时为 true） */
  isLiveStream?: boolean
}

export interface MediaItem extends Required<Pick<RawMediaEntry, 'url' | 'format'>>, Omit<RawMediaEntry, 'url' | 'format'> {}

export interface MetadataBatchItem {
  key: string
  url: string
  format: string
  requestHeaders?: Record<string, string>
  needMediaInfo: boolean
  needSize: boolean
}

export interface MetadataBatchRequest {
  type: 'GET_MEDIA_METADATA_BATCH'
  taskId: string
  tabId: number
  items: MetadataBatchItem[]
}

export interface MetadataBatchCancelRequest {
  type: 'CANCEL_MEDIA_METADATA_BATCH'
  taskId: string
}

export interface MetadataBatchResult {
  key: string
  url: string
  width?: number
  height?: number
  duration?: number
  size?: number | null
  removed: boolean
  error?: string
}

export interface MetadataBatchResponse {
  ok: boolean
  cancelled?: boolean
  items: MetadataBatchResult[]
  error?: string
}

export interface ListUpdatedMessage {
  type: 'LIST_UPDATED'
  tabId: number
  list: RawMediaEntry[]
}
