import { ref, onMounted, onUnmounted } from 'vue'

export interface UseM3u8ExtOptions {
  onStatusChange?: (status: ExtStatus) => void
}

export type ExtStatus = 'checking' | 'ready' | 'not_installed'

export interface DownloadOptions {
  url: string
  format?: string
  filename?: string
}

export function useM3u8Ext(options: UseM3u8ExtOptions = {}) {
  const extStatus = ref<ExtStatus>('checking')
  let readyHandler: (() => void) | null = null

  function checkExtension() {
    const isInjected = document.querySelector('script[data-m3u8-injected]') !== null
    if (isInjected) {
      setStatus('ready')
      return
    }

    readyHandler = () => setStatus('ready')
    window.addEventListener('m3u8ext:ready', readyHandler, { once: true })

    setTimeout(() => {
      if (extStatus.value === 'checking') {
        setStatus('not_installed')
      }
    }, 1500)
  }

  function setStatus(s: ExtStatus) {
    extStatus.value = s
    options.onStatusChange?.(s)
  }

  function download(opts: DownloadOptions): Promise<boolean> {
    return new Promise((resolve) => {
      if (extStatus.value !== 'ready') {
        resolve(false)
        return
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

      const handler = (event: MessageEvent) => {
        if (
          event.data?.type === 'EXT_DOWNLOAD_RESPONSE' &&
          event.data.requestId === requestId
        ) {
          window.removeEventListener('message', handler)
          resolve(!!event.data.ok)
        }
      }

      window.addEventListener('message', handler)

      window.postMessage({
        type: 'EXT_DOWNLOAD_REQUEST',
        url: opts.url,
        format: opts.format ?? 'm3u8',
        filename: opts.filename,
        requestId,
      }, '*')

      setTimeout(() => {
        window.removeEventListener('message', handler)
        resolve(false)
      }, 15000)
    })
  }

  onMounted(() => {
    checkExtension()
  })

  onUnmounted(() => {
    if (readyHandler) {
      window.removeEventListener('m3u8ext:ready', readyHandler)
    }
  })

  return {
    extStatus,
    download,
  }
}
