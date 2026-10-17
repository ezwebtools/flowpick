import { SITE_ORIGIN } from './site'

export interface QueueSource {
  id: string
  url: string
  format: string
  filename: string
  sourceUrl: string
  requestHeaders?: Record<string, string>
  audioUrl?: string
  audioOptions?: { url: string; label?: string; language?: string }[]
  isLive?: boolean
}
interface QueueSession { tabId: number; windowId: number; createdAt: number; tasks: QueueSource[] }
const key = 'flowpick-download-queues-v1'
let memory: QueueSession[] = []
let serial = Promise.resolve()
export function isQueuePage(url?: string) {
  try {
    const parsed = new URL(url || '')
    return parsed.origin === new URL(SITE_ORIGIN).origin
      && /^\/(?:zh-Hans\/|zh-Hant\/|ja\/|ko\/|fr\/)?download-queue\/?$/.test(parsed.pathname)
  } catch { return false }
}
async function read() {
  // Authenticated source context must never fall back to persistent local storage.
  const value = browser.storage.session ? (await browser.storage.session.get(key))[key] : memory
  return (Array.isArray(value) ? value : []) as QueueSession[]
}
async function write(sessions: QueueSession[]) {
  memory = sessions
  if (browser.storage.session) await browser.storage.session.set({ [key]: sessions })
}
export function openDownloadQueue(items: Omit<QueueSource, 'id'>[], windowId: number) {
  const operation = serial.then(async () => {
    const sessions = await read()
    const valid: QueueSession[] = []
    for (const session of sessions) {
      try {
        const tab = await browser.tabs.get(session.tabId)
        if (isQueuePage(tab.url) && Date.now() - session.createdAt < 86400_000) valid.push(session)
      } catch { /* A closed queue no longer owns task credentials. */ }
    }
    let session = valid.find(s => s.windowId === windowId)
    if (!session) {
      const lang = ({ 'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', ja: 'ja', ko: 'ko', fr: 'fr' } as Record<string, string>)[browser.i18n.getUILanguage()]
      // Store before activation: the page may request its tasks immediately.
      const tab = await browser.tabs.create({ windowId, url: `${SITE_ORIGIN}/${lang ? lang + '/' : ''}download-queue`, active: false })
      if (tab.id === undefined) throw new Error('queue-tab-unavailable')
      session = { tabId: tab.id, windowId, createdAt: Date.now(), tasks: [] }
      valid.push(session)
    }
    let added = 0
    for (const item of items) {
      if (!item || typeof item.url !== 'string' || typeof item.format !== 'string') continue
      if (!/^(https?:|flowpick-meta:)/.test(item.url)) continue
      const existing = session.tasks.find(t => t.url === item.url && t.format === item.format && t.audioUrl === item.audioUrl)
      if (existing) { Object.assign(existing, item); continue }
      if (session.tasks.length >= 500) throw new Error('queue-limit-500')
      session.tasks.push({ ...item, id: crypto.randomUUID() })
      added++
    }
    await write(valid)
    await browser.tabs.sendMessage(session.tabId, { type: 'FLOWPICK_QUEUE_CHANGED' }).catch(() => undefined)
    await browser.tabs.update(session.tabId, { active: true })
    return { ok: true, added, tabId: session.tabId }
  })
  serial = operation.then(() => undefined, () => undefined)
  return operation
}
export async function readDownloadQueue(tabId: number, url?: string) {
  if (!isQueuePage(url)) return { ok: false }
  const session = (await read()).find(s => s.tabId === tabId)
  return session ? { ok: true, tasks: session.tasks } : { ok: false }
}
export async function removeDownloadQueue(tabId: number) {
  const operation = serial.then(async () => write((await read()).filter(s => s.tabId !== tabId)))
  serial = operation.then(() => undefined, () => undefined)
  await operation
}
