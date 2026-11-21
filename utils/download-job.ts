/**
 * Cleanup for the legacy per-resource download job records.
 *
 * The jobs themselves are gone: image/document/audio saves go straight to
 * `downloads.download` and live resources go to the hosted downloader, so
 * nothing writes a `resource_download_*` key any more. Only the sweep remains,
 * because a profile that ran an older build can still carry those keys (they
 * hold captured request headers) and they must not outlive the tab.
 */

const prefix = 'resource_download_'

interface ResourceDownloadJob {
  url: string
  filename: string
  format: string
  requestHeaders?: Record<string, string>
  referrer?: string
  resourceKind: 'image' | 'document' | 'audio' | 'live'
  tabId?: number
  createdAt: number
}

const storage = () => browser.storage.session ?? browser.storage.local

export async function removeResourceDownloads(tabId: number) {
  const data = await storage().get(null)
  const keys = Object.entries(data).filter(([key, value]) => {
    const job = value as ResourceDownloadJob
    return key.startsWith(prefix) && (job.tabId === tabId || Date.now() - job.createdAt > 86400_000)
  }).map(([key]) => key)
  if (keys.length) await storage().remove(keys)
}
