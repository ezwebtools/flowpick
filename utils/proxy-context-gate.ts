/** Concurrent requests may share a host only while their header context matches. */
export class ProxyContextGate {
  private hosts = new Map<string, { context: string; active: number; waiting: { context: string; start: () => void }[] }>()
  acquire(url: string, context: string, signal: AbortSignal): Promise<() => void> {
    const host = new URL(url).host
    let state = this.hosts.get(host)
    if (!state) { state = { context, active: 0, waiting: [] }; this.hosts.set(host, state) }
    const current = state
    return new Promise((resolve, reject) => {
      const entry = { context, start: () => {
        signal.removeEventListener('abort', abort)
        current.context = context; current.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true; current.active--
          if (!current.active) {
            const next = current.waiting[0]?.context
            while (current.waiting[0]?.context === next && current.waiting.length) current.waiting.shift()!.start()
            if (!current.active && !current.waiting.length) this.hosts.delete(host)
          }
        })
      } }
      const abort = () => {
        current.waiting = current.waiting.filter(item => item !== entry)
        if (!current.active && !current.waiting.length) this.hosts.delete(host)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal.aborted) return abort()
      if (!current.active || (current.context === context && !current.waiting.length)) entry.start()
      else { current.waiting.push(entry); signal.addEventListener('abort', abort, { once: true }) }
    })
  }
}
