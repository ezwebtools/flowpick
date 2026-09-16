import { pageIdentity, type PageContext } from './page-session'

/** Ordered, acknowledged bridge. A retry never relabels a queued old-route event. */
export function createPageReporter(onReady: () => void) {
  const documentToken = crypto.randomUUID()
  let identity = pageIdentity(location.href)
  let revision = 0
  let generation = 0
  let tail: Promise<unknown> = Promise.resolve()
  let acknowledgedSession: number | undefined
  function observeNavigation(url: string): boolean {
    const next = pageIdentity(url)
    if (next === identity) return false
    identity = next; revision++; generation++
    return true
  }

  function context(): PageContext {
    observeNavigation(location.href)
    return { documentToken, url: location.href, revision }
  }

  function enqueue(payload?: Record<string, unknown>): Promise<void> {
    const snapshot = context()
    const expectedGeneration = generation
    const current = () => {
      context()
      return generation === expectedGeneration
    }
    const work = async () => {
      for (let attempt = 0; current(); attempt++) {
        try {
          const sync = await browser.runtime.sendMessage({ type: 'PAGE_SESSION_SYNC', pageContext: snapshot })
          if (!current()) return
          if (!sync?.ok) {
            if (sync?.stale) return
            throw new Error('Session unavailable')
          }
          const changed = acknowledgedSession !== sync.sessionId
          acknowledgedSession = sync.sessionId
          if (payload) {
            const response = await browser.runtime.sendMessage({ ...payload, pageContext: snapshot, sessionId: sync.sessionId })
            if (!current()) return
            if (!response?.ok) {
              if (response?.stale) { onReady(); return }
              throw new Error('Capture was not acknowledged')
            }
          }
          if (changed || !payload) onReady()
          return
        } catch (error) {
          if (/extension context invalidated/i.test(String(error))) {
            console.warn('[FlowPick] capture bridge unavailable:', error)
            return
          }
          if (attempt === 2) console.warn('[FlowPick] retrying capture bridge:', error)
          await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** Math.min(attempt, 6), 5000)))
        }
      }
    }
    const next = tail.then(work, work)
    tail = next.catch(() => {})
    return next
  }

  return {
    report: (payload: Record<string, unknown>) => enqueue(payload),
    sync: () => enqueue(),
    observeNavigation,
    invalidate() { generation++; acknowledgedSession = undefined },
  }
}
