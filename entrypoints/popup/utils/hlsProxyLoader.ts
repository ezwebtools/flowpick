import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderResponse,
  LoaderStats,
} from 'hls.js'

interface ProxyFetchResponse {
  ok: boolean
  status?: number
  headers?: Record<string, string>
  data?: string
  error?: string
}

export interface HlsProxyOptions {
  requestHeaders?: Record<string, string>
  referrer?: string
}

function createStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let offset = 0; offset < binary.length; offset += 32768) {
    const end = Math.min(offset + 32768, binary.length)
    for (let index = offset; index < end; index++) bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

export function createHlsProxyLoader(options: HlsProxyOptions): new (config: HlsConfig) => Loader<LoaderContext> {
  return class BackgroundProxyLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats = createStats()
    private requestId: string | null = null
    private timeoutId: ReturnType<typeof setTimeout> | null = null
    private responseHeaders = new Map<string, string>()
    private callbacks: LoaderCallbacks<LoaderContext> | null = null

    constructor(_config: HlsConfig) {}

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context
      this.callbacks = callbacks
      this.stats.loading.start = performance.now()
      const requestId = `hls-proxy:${Date.now()}:${Math.random().toString(36).slice(2)}`
      this.requestId = requestId
      const headers: Record<string, string> = { ...(context.headers ?? {}) }
      if (typeof context.rangeStart === 'number') {
        const end = typeof context.rangeEnd === 'number' ? Math.max(context.rangeStart, context.rangeEnd - 1) : ''
        headers.Range = `bytes=${context.rangeStart}-${end}`
      }
      const maxLoadTime = config.loadPolicy?.maxLoadTimeMs || config.timeout || 20_000
      this.timeoutId = setTimeout(() => {
        if (this.requestId !== requestId || !this.context) return
        this.cancelRequest(requestId)
        this.requestId = null
        this.stats.loading.end = performance.now()
        callbacks.onTimeout(this.stats, context, null)
      }, maxLoadTime)

      browser.runtime.sendMessage({
        type: 'PROXY_FETCH',
        requestId,
        url: context.url,
        options: {
          headers,
          authHeaders: options.requestHeaders,
          referrer: options.referrer,
          proxyHeader: true,
        },
      }).then((response: ProxyFetchResponse) => {
        if (this.requestId !== requestId || this.stats.aborted) return
        this.clearTimer()
        this.requestId = null
        this.stats.loading.first = this.stats.loading.first || performance.now()
        this.stats.loading.end = performance.now()
        if (!response?.ok || !response.data) {
          callbacks.onError({ code: response?.status ?? 0, text: response?.error || 'Proxy request failed' }, context, response, this.stats)
          return
        }
        const buffer = decodeBase64(response.data)
        this.stats.loaded = buffer.byteLength
        this.stats.total = buffer.byteLength
        this.stats.chunkCount = 1
        this.responseHeaders = new Map(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
        const data = context.responseType === 'text'
          ? new TextDecoder().decode(buffer)
          : buffer
        const result: LoaderResponse = { url: context.url, data, code: response.status ?? 200 }
        callbacks.onProgress?.(this.stats, context, data, response)
        callbacks.onSuccess(result, this.stats, context, response)
      }).catch((error: Error) => {
        if (this.requestId !== requestId || this.stats.aborted) return
        this.clearTimer()
        this.requestId = null
        this.stats.loading.end = performance.now()
        callbacks.onError({ code: 0, text: error.message }, context, error, this.stats)
      })
    }

    abort(): void {
      if (this.stats.aborted) return
      this.stats.aborted = true
      const context = this.context
      const requestId = this.requestId
      this.requestId = null
      this.clearTimer()
      if (requestId) this.cancelRequest(requestId)
      if (context) this.callbacks?.onAbort?.(this.stats, context, null)
    }

    destroy(): void {
      this.abort()
      this.context = null
      this.callbacks = null
      this.responseHeaders.clear()
    }

    getResponseHeader(name: string): string | null {
      return this.responseHeaders.get(name.toLowerCase()) ?? null
    }

    getCacheAge(): number | null {
      const age = this.getResponseHeader('age')
      return age ? Number(age) || 0 : null
    }

    private clearTimer(): void {
      if (this.timeoutId) clearTimeout(this.timeoutId)
      this.timeoutId = null
    }

    private cancelRequest(requestId: string): void {
      void browser.runtime.sendMessage({ type: 'PROXY_FETCH_CANCEL', requestId }).catch(() => {})
    }
  }
}