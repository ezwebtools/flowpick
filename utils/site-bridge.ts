import { SITE_ORIGIN } from './site'

// Source-page detection and recording events are deliberately not in this set.
// Those must continue to work on arbitrary sites and in player iframes.
const SITE_PAGE_MESSAGES = new Set([
  'EXT_DOWNLOAD_REQUEST', 'FLOWPICK_REQUEST_DOWNLOAD', 'FLOWPICK_REQUEST_QUEUE',
  'FLOWPICK_FETCH', 'FLOWPICK_FETCH_CANCEL',
  'FLOWPICK_PROXY_FETCH', 'FLOWPICK_PROXY_FETCH_CANCEL', 'FLOWPICK_NOTIFY',
  'FLOWPICK_RECORDING_READY', 'FLOWPICK_RECORDING_COMMAND', 'FLOWPICK_RECORDING_MSR_UI_STATE',
])

const SITE_RUNTIME_MESSAGES = new Set([
  'PROXY_FETCH', 'PROXY_FETCH_CANCEL', 'PREPARE_MEDIA_PLAYBACK',
  'FLOWPICK_DOWNLOAD_READY', 'FLOWPICK_QUEUE_READY', 'FLOWPICK_NOTIFY',
  'FLOWPICK_RECORDING_PAGE_READY', 'FLOWPICK_RECORDING_PAGE_COMMAND',
])

export function isSiteOrigin(url: string): boolean {
  try { return new URL(url).origin === new URL(SITE_ORIGIN).origin }
  catch { return false }
}

export function allowsSitePageMessage(type: unknown, pageUrl: string, topFrame: boolean, messageOrigin: string): boolean {
  return !SITE_PAGE_MESSAGES.has(String(type))
    || (topFrame && isSiteOrigin(pageUrl) && isSiteOrigin(messageOrigin))
}

interface BridgeSender {
  id?: string
  url?: string
  origin?: string
  frameId?: number
  documentId?: string
  tab?: { id?: number }
}

export function allowsSiteRuntimeMessage(type: unknown, sender: BridgeSender, extensionId: string, extensionUrl: string): boolean {
  if (!SITE_RUNTIME_MESSAGES.has(String(type))) return true
  if (sender.id !== extensionId || !sender.url) return false
  try {
    const url = new URL(sender.url)
    const own = new URL(extensionUrl)
    // Popup, sidebar and extension download pages do not have a website origin.
    if (url.protocol === own.protocol && url.host === own.host) return true
    // Use the actual sending frame URL, never tab.url (which describes the top frame).
    return sender.tab?.id !== undefined && sender.frameId === 0
      && isSiteOrigin(sender.url)
      && (sender.origin === undefined || sender.origin === url.origin)
  } catch { return false }
}

// Page-selected request IDs are not globally unique or proof of ownership.
export function proxyRequestKey(sender: BridgeSender, requestId: string): string {
  return JSON.stringify([sender.id, sender.tab?.id, sender.frameId, sender.documentId, sender.url, requestId])
}
