import { extractInstagramMediaTasks, parseInstagramPayloadText } from './instagram-player'
import type { PlatformMediaTask } from './platform-media'

/** Read hydration and parse XML in the extension's isolated world, not the page. */
export function installInstagramCapture(report: (task: PlatformMediaTask) => Promise<unknown>) {
  if (!/(^|\.)instagram\.com$/i.test(location.hostname)) return undefined
  let scripts = new WeakMap<Element, string>()
  const payloads: Array<{ data: unknown; at: number }> = []
  const sent = new Set<string>()
  const pending = new Set<string>()
  let route = location.href
  let disposed = false
  let retry = false
  const replay = () => {
    if (disposed) return
    if (route !== location.href) { route = location.href; sent.clear() }
    for (const payload of payloads) {
      if (Date.now() - payload.at > 60_000) continue
      for (const task of extractInstagramMediaTasks(payload.data, location.href)) {
        const signature = `${route}:${task.key}:${task.candidates.map(candidate => candidate.url).join('|')}`
        if (sent.has(signature) || pending.has(signature)) continue
        pending.add(signature)
        void report(task).then(() => {
          if (!disposed) sent.add(signature)
        }).catch(() => { retry = true }).finally(() => pending.delete(signature))
      }
    }
  }
  const receive = (text: string) => {
    if (disposed || typeof text !== 'string' || text.length > 8_000_000
      || (!text.includes('video_dash_manifest') && !text.includes('dash_manifest'))) return
    for (const data of parseInstagramPayloadText(text)) {
      payloads.push({ data, at: Date.now() })
      if (payloads.length > 4) payloads.shift()
    }
    replay()
  }
  const scan = (root: Document | Element = document) => {
    if (disposed) return
    const nodes = root instanceof Element && root.tagName === 'SCRIPT'
      ? [root] : Array.from(root.querySelectorAll('script[type="application/json"]'))
    for (const script of nodes) {
      const text = script.textContent || ''
      if (!text.includes('video_dash_manifest') && !text.includes('dash_manifest')) continue
      if (scripts.get(script) === text) continue
      scripts.set(script, text)
      receive(text)
    }
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      // JSON scripts can be inserted empty and filled by a later text mutation.
      if (record.target instanceof Element && record.target.tagName === 'SCRIPT') scan(record.target)
      else if (record.target.parentElement?.tagName === 'SCRIPT') scan(record.target.parentElement)
      for (const node of record.addedNodes) if (node instanceof Element) scan(node)
    }
  })
  observer.observe(document, { childList: true, subtree: true, characterData: true })
  scan()
  const timer = setInterval(() => {
    if (route !== location.href || retry) { retry = false; replay() }
  }, 1000)
  const dispose = () => { disposed = true; observer.disconnect(); clearInterval(timer) }
  window.addEventListener('pagehide', dispose, { once: true })
  return { receive, rescan: () => {
    sent.clear()
    if (!payloads.some(payload => Date.now() - payload.at <= 60_000)) scripts = new WeakMap()
    scan(); replay()
  }, dispose }
}
