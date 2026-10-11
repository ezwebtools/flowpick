export interface PersistedRecordingSession {
  id: string
  mode: 'mse' | 'msr'
  sourceTabId: number
  targetTabId: number
  cancelled: boolean
  playingFrames: Set<number>
  preparePromise?: Promise<unknown>
}

/** Only session metadata is saved; never media bytes or in-flight promises. */
export function createRecordingSessionStore<T extends PersistedRecordingSession>(
  sessions: Map<number, T>, sources: Map<number, number>,
  storage: { get(key: string): Promise<Record<string, unknown>>, set(value: Record<string, unknown>): Promise<unknown> },
  isLive: (session: T) => Promise<boolean>,
) {
  const key = 'flowpick_recording_sessions_v1'
  let queue: Promise<unknown> = Promise.resolve()
  const ready = (async () => {
    const stored = (await storage.get(key))[key]
    if (!Array.isArray(stored)) return
    for (const value of stored) {
      if (!value || typeof value.id !== 'string' || !value.id || !['mse', 'msr'].includes(value.mode)
        || !Number.isSafeInteger(value.sourceTabId) || value.sourceTabId <= 0
        || !Number.isSafeInteger(value.targetTabId) || value.targetTabId <= 0 || value.cancelled) continue
      const session = { ...value, playingFrames: new Set<number>(Array.isArray(value.playingFrames)
        ? value.playingFrames.filter((frame: unknown) => Number.isSafeInteger(frame) && Number(frame) >= 0) : []) } as T
      delete session.preparePromise
      if (!await isLive(session)) continue
      sessions.set(session.targetTabId, session)
      sources.set(session.sourceTabId, session.targetTabId)
    }
  })()
  // Attach a handler immediately; callers still receive the original rejection.
  void ready.catch(error => console.warn('[FlowPick] Recording session restore failed:', error))
  const save = () => {
    queue = queue.catch(() => undefined).then(async () => {
      await ready
      const snapshot = [...sessions.values()].filter(session => !session.cancelled).map(session => {
        const { preparePromise: _pending, playingFrames, ...metadata } = session
        return { ...metadata, playingFrames: [...playingFrames] }
      })
      await storage.set({ [key]: snapshot })
    })
    return queue
  }
  return { ready, save }
}
