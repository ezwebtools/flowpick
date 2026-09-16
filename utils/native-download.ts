/** Resolving downloads.download only means started; success requires terminal state and bytes. */
export async function waitForNativeDownload(url: string, filename: string, expectedBytes: number): Promise<number> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error('empty-download')
  let downloadId: number | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let finish: (error?: Error) => void = () => {}
  const completed = new Promise<void>((resolve, reject) => {
    finish = error => error ? reject(error) : resolve()
  })
  // Avoid an unhandled rejection while the start callback is still pending.
  void completed.catch(() => {})
  async function inspect() {
    if (downloadId === undefined) return
    try {
      const [item] = await browser.downloads.search({ id: downloadId })
      if (!item) return
      if (item.state === 'interrupted') { finish(new Error(item.error || 'download-interrupted')); return }
      if (item.state !== 'complete') return
      const bytes = item.fileSize >= 0 ? item.fileSize : item.bytesReceived
      finish(bytes === expectedBytes ? undefined : new Error(`incomplete-download: ${bytes}/${expectedBytes}`))
    } catch (error) {
      // A transient query failure is not evidence that the download stopped.
      // Keep the owner alive and retry instead of invalidating its Blob URL.
      console.warn('[FlowPick] Unable to query download status:', error)
    }
  }
  const changed = (delta: { id: number }) => { if (delta.id === downloadId) void inspect() }
  browser.downloads.onChanged.addListener(changed)
  try {
    downloadId = await browser.downloads.download({ url, filename })
    if (!Number.isInteger(downloadId)) throw new Error('download-not-started')
    poll = setInterval(() => void inspect(), 1000)
    // A small file may finish before downloads.download resolves.
    await inspect()
    await completed
    return downloadId
  } finally {
    browser.downloads.onChanged.removeListener(changed)
    if (poll) clearInterval(poll)
  }
}
