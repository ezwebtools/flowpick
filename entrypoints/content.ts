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

    let currentTabId: number | undefined

    window.addEventListener('message', async (event) => {
      if (
        event.data?.type === 'M3U8_DETECTED' &&
        typeof event.data.url === 'string'
      ) {
        if (!currentTabId) {
          const tab = await browser.runtime.sendMessage({ type: 'GET_CURRENT_TAB' })
          currentTabId = tab?.id
        }
        
        if (currentTabId) {
          // 发送MEDIA_FOUND消息，使用检测到的格式或默认为m3u8
          browser.runtime.sendMessage({ 
            type: 'MEDIA_FOUND', 
            url: event.data.url, 
            tabId: currentTabId,
            format: event.data.format || 'm3u8'
          })
        }
      }
    })
  },
})
