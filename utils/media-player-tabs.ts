import type { MediaItem } from '../entrypoints/popup/types'

export interface PlayerSession {
  id: string
  tabId?: number
  sourceTabId?: number
  title: string
  referrer: string
  item: MediaItem
}

const STORE_KEY = 'flowpick_player_sessions'

/** Serialize opens and reads so double clicks and worker restarts reuse one tab. */
export function createMediaPlayerTabs(api: typeof browser) {
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.catch(() => {}).then(work)
    queue = result
    return result
  }
  const pageUrl = (id: string) => `${api.runtime.getURL('/player.html')}?session=${encodeURIComponent(id)}`
  const read = async (): Promise<Record<string, PlayerSession>> =>
    (await api.storage.local.get(STORE_KEY))[STORE_KEY] as Record<string, PlayerSession> || {}
  const save = (sessions: Record<string, PlayerSession>) => api.storage.local.set({ [STORE_KEY]: sessions })
  const identity = (session: PlayerSession) => JSON.stringify([
    session.sourceTabId, session.item.url, session.item.format,
    session.item.audioUrl || session.item.audioOptions?.[0]?.url,
  ])
  const isUi = (sender: { id?: string; url?: string }) => sender.id === api.runtime.id
    && (['/popup.html', '/sidepanel.html'] as const).some(path => sender.url === api.runtime.getURL(path))

  return {
    open: (request: { item: MediaItem; sourceTabId?: number; title?: string }, sender: { id?: string; url?: string }) => serialize(async () => {
      if (!isUi(sender)) throw new Error('untrusted-player-sender')
      const item = request.item
      if (!item || !/^https?:\/\//i.test(item.url) || item.format === 'mse') throw new Error('invalid-player-resource')
      const sessions = await read()
      const session: PlayerSession = {
        id: crypto.randomUUID(), sourceTabId: request.sourceTabId,
        title: request.title || item.tabTitle || 'FlowPick', item,
        referrer: item.requestHeaders?.referer || item.requestHeaders?.Referer || '',
      }
      if (!session.referrer && request.sourceTabId !== undefined) {
        session.referrer = (await api.tabs.get(request.sourceTabId).catch(() => undefined))?.url || ''
      }
      for (const [id, previous] of Object.entries(sessions)) {
        const tab = previous.tabId === undefined ? undefined : await api.tabs.get(previous.tabId).catch(() => undefined)
        if (!tab || tab.url !== pageUrl(id)) { delete sessions[id]; continue }
        if (identity(previous) === identity(session)) {
          await save(sessions)
          await api.tabs.update(tab.id!, { active: true })
          if (tab.windowId !== undefined) await api.windows.update(tab.windowId, { focused: true })
          return { ok: true, tabId: tab.id }
        }
      }
      sessions[session.id] = session
      await save(sessions)
      try {
        const tab = await api.tabs.create({ url: pageUrl(session.id), active: true })
        if (tab.id === undefined) throw new Error('player-tab-unavailable')
        session.tabId = tab.id
        await save(sessions)
        return { ok: true, tabId: tab.id }
      } catch (error) {
        delete sessions[session.id]
        await save(sessions)
        throw error
      }
    }),
    get: (id: string, sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number } }) => serialize(async () => {
      const session = (await read())[id]
      if (!session || sender.id !== api.runtime.id || sender.url !== pageUrl(id)
        || sender.frameId !== 0 || sender.tab?.id !== session.tabId) throw new Error('player-session-unavailable')
      return { ok: true, session }
    }),
    remove: (tabId: number) => serialize(async () => {
      const sessions = await read()
      for (const [id, session] of Object.entries(sessions)) if (session.tabId === tabId) delete sessions[id]
      await save(sessions)
    }),
  }
}
