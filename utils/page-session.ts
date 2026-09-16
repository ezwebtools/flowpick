/** Ignore only known attribution parameters; unknown query/hash values may select media. */
export function pageIdentity(value: string): string {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|spm_id_from|spm|vd_source|from_spmid)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.href
  } catch { return value }
}

export interface PageContext {
  documentToken: string
  url: string
  revision: number
}

interface FrameSession {
  documentId?: string
  token?: string
  revision: number
  identity: string
  generation: number
}
export type StoredPageSession = { tabId: number; epoch: number; frames: Array<[number, FrameSession]> }

/** Navigation and capture use the same state machine. Only frame 0 owns the tab epoch. */
export class PageSessions {
  private frames = new Map<number, Map<number, FrameSession>>()
  private epochs = new Map<number, number>()
  constructor(private changed: (tabId: number, url: string) => void) {}

  epoch(tabId: number): number { return this.epochs.get(tabId) ?? 0 }

  private advance(tabId: number, url: string) {
    this.epochs.set(tabId, this.epoch(tabId) + 1)
    this.changed(tabId, url)
  }

  commit(tabId: number, frameId: number, url: string, documentId?: string) {
    let frames = this.frames.get(tabId)
    const previous = frames?.get(frameId)
    // A content handshake can precede delivery of the matching commit event.
    if (documentId && previous?.documentId === documentId) return
    if (!frames || frameId === 0) {
      frames = new Map()
      this.frames.set(tabId, frames)
    }
    frames.set(frameId, { documentId, revision: -1, identity: pageIdentity(url), generation: (previous?.generation ?? 0) + 1 })
    if (frameId === 0) this.advance(tabId, url)
  }

  hasDocument(tabId: number, frameId: number, context: PageContext, documentId?: string) {
    const frame = this.frames.get(tabId)?.get(frameId)
    return !!frame && frame.token === context.documentToken && (!documentId || frame.documentId === documentId)
  }

  frameGeneration(tabId: number, frameId: number) { return this.frames.get(tabId)?.get(frameId)?.generation ?? 0 }

  matchesDocument(tabId: number, frameId: number, documentId?: string) {
    const current = this.frames.get(tabId)?.get(frameId)?.documentId
    return !documentId || !current || current === documentId
  }

  // Called only after getFrame confirms that this reporter belongs to the live document.
  reconnect(tabId: number, frameId: number, documentId?: string) {
    const frame = this.frames.get(tabId)?.get(frameId)
    if (frame && (!documentId || !frame.documentId || frame.documentId === documentId)) {
      frame.token = undefined
      frame.revision = -1
    }
  }

  sync(tabId: number, frameId: number, context: PageContext, documentId?: string): number | undefined {
    let frames = this.frames.get(tabId)
    if (!frames) { frames = new Map(); this.frames.set(tabId, frames) }
    let frame = frames.get(frameId)
    const identity = pageIdentity(context.url)
    if (frame?.documentId && documentId && frame.documentId !== documentId) return
    if (frame?.token && frame.token !== context.documentToken) return
    if (frame && context.revision < frame.revision) return
    if (frame && context.revision === frame.revision && frame.identity !== identity) return
    const routeChanged = !!frame && (frame.identity !== identity || (frame.revision >= 0 && context.revision > frame.revision))
    const newPage = frameId === 0 && (!frame || routeChanged)
    frame = { documentId, token: context.documentToken, identity, revision: context.revision,
      generation: (frame?.generation ?? 0) + (routeChanged ? 1 : 0) }
    frames.set(frameId, frame)
    if (newPage) this.advance(tabId, context.url)
    return this.epoch(tabId)
  }

  accepts(tabId: number, frameId: number, context: PageContext, epoch: number, documentId?: string): boolean {
    const frame = this.frames.get(tabId)?.get(frameId)
    return this.hasDocument(tabId, frameId, context, documentId)
      && frame?.revision === context.revision && frame.identity === pageIdentity(context.url)
      && epoch === this.epoch(tabId)
  }

  remove(tabId: number) { this.frames.delete(tabId); this.epochs.delete(tabId) }

  snapshot(): StoredPageSession[] {
    return [...this.frames].map(([tabId, frames]) => ({ tabId, epoch: this.epoch(tabId), frames: [...frames].map(([id, frame]) => [id, { ...frame }]) }))
  }

  restore(data: StoredPageSession[]) {
    for (const item of data) {
      // Live navigation received while storage was loading always wins.
      if (this.frames.has(item.tabId)) continue
      this.frames.set(item.tabId, new Map(item.frames))
      this.epochs.set(item.tabId, item.epoch)
    }
  }
}
