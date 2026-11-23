import type { MediaItem } from '../entrypoints/popup/types'

/** Copy nested media data into plain objects for WebExtension messaging. */
export function cloneMediaItem(item: MediaItem): MediaItem {
  return {
    ...item,
    requestHeaders: item.requestHeaders ? { ...item.requestHeaders } : undefined,
    audioOptions: item.audioOptions?.map(option => ({ url: option.url, label: option.label })),
  }
}
