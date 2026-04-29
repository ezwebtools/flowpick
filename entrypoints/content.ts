export default defineContentScript({
  matches: ['*://*/*'],
  allFrames: true,
  runAt: 'document_end',
  main() {
    if (!document.querySelector('script[data-m3u8-injected]')) {
      const script = document.createElement('script')
      script.src = browser.runtime.getURL('/injected.js')
      script.dataset.m3u8Injected = '1'
      ;(document.head || document.documentElement).appendChild(script)
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (event.data?.type === 'FLOWPICK_PING') {
        window.postMessage({ type: 'FLOWPICK_PONG' }, '*')
      }
      if (event.data?.type === 'FLOWPICK_REQUEST_DOWNLOAD') {
        let retries = 0
        function tryFetch() {
          browser.runtime.sendMessage({ type: 'FLOWPICK_DOWNLOAD_READY' }).then((resp: any) => {
            if (resp?.ok && resp.url) {
              window.postMessage({
                type: 'FLOWPICK_DOWNLOAD_DATA',
                url: resp.url,
                format: resp.format,
                filename: resp.filename,
                sourceUrl: resp.sourceUrl,
              }, '*')
            } else if (retries < 20) {
              retries++
              setTimeout(tryFetch, 300)
            }
          })
        }
        tryFetch()
      }
    })

    window.dispatchEvent(new CustomEvent('m3u8ext:ready'))

    let currentTabId: number | undefined

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return

      if (
        event.data?.type === 'M3U8_DETECTED' &&
        typeof event.data.url === 'string'
      ) {
        if (!currentTabId) {
          const tab = await browser.runtime.sendMessage({ type: 'GET_CURRENT_TAB' })
          currentTabId = tab?.id
        }
        if (currentTabId) {
          browser.runtime.sendMessage({
            type: 'MEDIA_FOUND',
            url: event.data.url,
            tabId: currentTabId,
            format: event.data.format || 'm3u8',
          })
        }
        return
      }

      if (
        event.data?.type === 'EXT_DOWNLOAD_REQUEST' &&
        typeof event.data.url === 'string'
      ) {
        const { url, format = 'm3u8', filename, requestId } = event.data
        try {
          await browser.runtime.sendMessage({
            type: 'OPEN_DOWNLOAD_PAGE',
            url,
            format,
            filename: filename || getFilenameFromUrl(url),
          })
          window.postMessage({ type: 'EXT_DOWNLOAD_RESPONSE', requestId, ok: true }, '*')
        } catch {
          window.postMessage({ type: 'EXT_DOWNLOAD_RESPONSE', requestId, ok: false }, '*')
        }
      }
    })


    function getFilenameFromUrl(url: string): string {
      try {
        const pathname = new URL(url).pathname
        return pathname.split('/').pop() || 'download'
      } catch {
        return 'download'
      }
    }
  },
})
