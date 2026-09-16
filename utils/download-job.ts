export interface ResourceDownloadJob {
  url: string
  filename: string
  format: string
  requestHeaders?: Record<string, string>
  referrer?: string
  resourceKind: 'image' | 'document' | 'audio' | 'live'
  tabId?: number
  createdAt: number
}
const prefix = 'resource_download_'
const storage = () => browser.storage.session ?? browser.storage.local

export async function openResourceDownload(job: Omit<ResourceDownloadJob, 'createdAt'>) {
  if (!/^https?:$/.test(new URL(job.url).protocol)) throw new Error('unsupported-download-url')
  const key = prefix + crypto.randomUUID()
  const value: ResourceDownloadJob = { ...job, createdAt: Date.now() }
  await storage().set({ [key]: value })
  try {
    const tab = await browser.tabs.create({ url: browser.runtime.getURL('/download.html') + '?job=' + encodeURIComponent(key) })
    await storage().set({ [key]: { ...value, tabId: tab.id } })
    return { ok: true, tabId: tab.id }
  } catch (error) { await storage().remove(key); throw error }
}

export async function readResourceDownload(key: string): Promise<ResourceDownloadJob | undefined> {
  if (!key.startsWith(prefix)) return
  return (await storage().get(key))[key] as ResourceDownloadJob | undefined
}

export async function removeResourceDownloads(tabId: number) {
  const data = await storage().get(null)
  const keys = Object.entries(data).filter(([key, value]) => {
    const job = value as ResourceDownloadJob
    return key.startsWith(prefix) && (job.tabId === tabId || Date.now() - job.createdAt > 86400_000)
  }).map(([key]) => key)
  if (keys.length) await storage().remove(keys)
}
