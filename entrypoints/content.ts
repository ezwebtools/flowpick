import { createPageReporter } from '../utils/page-reporter'
import { pageIdentity } from '../utils/page-session'
import { isRecordingBridgeMessage, localRecordingBuffer } from '../utils/recording-bridge'

export default defineContentScript({
  matches: ['*://*/*'],
  allFrames: true,
  // An explicitly requested recording must hook before player initialization.
  // Ordinary browsing installs no MSE hooks.
  runAt: 'document_start',
  main() {
    let injectedPageHookReady = false
    const activeBlobDownloads = new Set<string>()
    window.addEventListener('beforeunload', event => {
      if (activeBlobDownloads.size) { event.preventDefault(); event.returnValue = '' }
    })
    const reporter = createPageReporter(() => {
      window.postMessage({ type: 'FLOWPICK_RESCAN', url: location.href }, '*')
    })
    void reporter.sync()
    window.addEventListener('pageshow', () => void reporter.sync())
    if (!document.querySelector('script[data-m3u8-injected]')) {
      // WXT uses an external extension URL for MV3 (Chrome/Edge), but fetches
      // the source and injects it as page-world code for MV2 (Firefox). The
      // hand-written <script src="moz-extension://…"> path is not reliable
      // under Firefox's page-world/CSP isolation.
      void (async () => {
        const hookState = await browser.runtime.sendMessage({
          type: 'FLOWPICK_RECORDING_HOOK_STATE',
        }).catch(() => ({ mse: false }))
        await injectScript('/injected.js', {
          keepInDom: true,
          modifyScript(script) {
            script.dataset.m3u8Injected = '1'
            if (hookState?.mse === true) script.dataset.flowpickMseArmed = '1'
          },
        })
      })().catch((error) => {
        console.warn('[FlowPick] page script injection failed:', error)
      })
    }

    let latestSettings: any
    setTimeout(() => {
      if (!injectedPageHookReady) console.warn('[FlowPick] Page hook did not report READY; MSE recording may be unavailable due to injection timing or page CSP')
    }, 5000)
    let mseCaptureActive = false
    let recordingSourceReadySent = false
    let recordingPushQueue: Promise<unknown> = Promise.resolve()
    let recordingConfigPosted = false
    const pendingRecordingDeliveries: any[] = []
    window.addEventListener('message', event => {
      if (!isRecordingBridgeMessage(event, window, location.origin) || event.data?.type !== 'FLOWPICK_MSE_RECORDING_FLUSH') return
      const port = event.ports[0]
      // All earlier window events have now joined recordingPushQueue. Wait
      // for their delivery to the recorder before acknowledging stop.
      void recordingPushQueue.then(() => {
        port?.postMessage({ ok: true, active: false })
        port?.close()
      }, error => {
        port?.postMessage({ ok: false, active: false, error: String(error) })
        port?.close()
      })
    })
    let lastReportedPlayback: boolean | undefined
    let msrRegionTracking = false
    let captureRegionMode: 'mse' | 'msr' = 'msr'
    let msePlaybackPlaying = false
    let captureRegionTimer: ReturnType<typeof setInterval> | undefined
    let captureRegionFrame: number | undefined
    let lastCaptureRegionSignature = ''
    let captureRegionOverlay: HTMLDivElement | undefined
    let captureRegionOverlayLabel: HTMLDivElement | undefined
    let captureRegionOverlayEnabled = false
    let msrControlSessionId = ''
    let msrControlState = 'ready'
    let captureRegionStartButton: HTMLButtonElement | undefined

    interface CaptureRegion {
      x: number
      y: number
      width: number
      height: number
      viewportWidth: number
      viewportHeight: number
      devicePixelRatio: number
      kind: 'video' | 'iframe'
    }

    function visibleElementRegion(element: Element, kind: CaptureRegion['kind']): CaptureRegion | undefined {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) return undefined
      const rect = element.getBoundingClientRect()
      let contentLeft = rect.left
      let contentTop = rect.top
      let contentWidth = rect.width
      let contentHeight = rect.height

      // A portrait stream is often rendered inside a landscape <video> box
      // with object-fit: contain. The surrounding pillar/letterbox pixels are
      // part of the element box but not the actual picture, so exclude them
      // from the MSR crop instead of recording large black borders.
      if (element instanceof HTMLVideoElement && element.videoWidth > 0 && element.videoHeight > 0) {
        const objectFit = style.objectFit || 'fill'
        if (objectFit === 'contain' || objectFit === 'scale-down') {
          const positionParts = style.objectPosition.trim().split(/\s+/)
          const positionFactor = (value: string | undefined, start: string, end: string) => {
            if (!value || value === 'center') return 0.5
            if (value === start) return 0
            if (value === end) return 1
            if (value.endsWith('%')) return Math.max(0, Math.min(1, Number.parseFloat(value) / 100))
            return 0.5
          }
          const positionX = positionFactor(positionParts[0], 'left', 'right')
          const positionY = positionFactor(positionParts[1] || positionParts[0], 'top', 'bottom')
          const mediaRatio = element.videoWidth / element.videoHeight
          const boxRatio = rect.width / Math.max(1, rect.height)
          if (boxRatio > mediaRatio) {
            contentWidth = rect.height * mediaRatio
            contentLeft = rect.left + (rect.width - contentWidth) * positionX
          } else if (boxRatio < mediaRatio) {
            contentHeight = rect.width / mediaRatio
            contentTop = rect.top + (rect.height - contentHeight) * positionY
          }
        }
      }
      const viewportWidth = Math.max(1, window.innerWidth)
      const viewportHeight = Math.max(1, window.innerHeight)
      const left = Math.max(0, contentLeft)
      const top = Math.max(0, contentTop)
      const right = Math.min(viewportWidth, contentLeft + contentWidth)
      const bottom = Math.min(viewportHeight, contentTop + contentHeight)
      const width = right - left
      const height = bottom - top
      if (width < 160 || height < 90) return undefined
      return {
        x: left,
        y: top,
        width,
        height,
        viewportWidth,
        viewportHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        kind,
      }
    }

    function querySelectorAllDeep<T extends Element>(selector: string): T[] {
      const matches: T[] = []
      const visit = (root: Document | ShadowRoot) => {
        matches.push(...root.querySelectorAll<T>(selector))
        for (const element of root.querySelectorAll<HTMLElement>('*')) {
          if (element.shadowRoot) visit(element.shadowRoot)
        }
      }
      visit(document)
      return matches
    }

    function hideCaptureRegionOverlay() {
      captureRegionOverlay?.remove()
      captureRegionOverlay = undefined
      captureRegionOverlayLabel = undefined
      captureRegionStartButton = undefined
    }

    function showCaptureRegionOverlay(region?: CaptureRegion) {
      if (!region || window.top !== window) {
        hideCaptureRegionOverlay()
        return
      }
      if (!captureRegionOverlay) {
        const host = document.createElement('div')
        host.dataset.flowpickMsrRegion = 'true'
        host.style.cssText = [
          'all:initial',
          'position:fixed',
          'pointer-events:none',
          'z-index:2147483647',
          'box-sizing:border-box',
          'overflow:visible',
        ].join(';')
        const shadow = host.attachShadow({ mode: 'closed' })
        const style = document.createElement('style')
        style.textContent = `
          :host { color-scheme: light dark; }
          /* Keep every painted pixel outside the recording crop. Inward
             shadows/glows would otherwise burn the blue frame into video. */
          .edge { position: absolute; background: #1677ff; }
          .top { left: 0; right: 0; top: -8px; height: 3px; }
          .right { top: 0; bottom: 0; right: -8px; width: 3px; }
          .bottom { left: 0; right: 0; bottom: -8px; height: 3px; }
          .left { top: 0; bottom: 0; left: -8px; width: 3px; }
          .label { position: absolute; left: 0; bottom: calc(100% + 9px); padding: 4px 8px; border-radius: 5px; background: #1677ff; color: #fff; font: 600 12px/1.2 system-ui, sans-serif; white-space: nowrap; }
          .label.below { top: calc(100% + 9px); bottom: auto; }
          .label.mse { left: 12px; bottom: 12px; top: auto; background: #dc2626; padding: 7px 10px; border: 1px solid rgba(255,255,255,.4); }
          .label.mse.waiting { background: #b45309; }
          .start { position: absolute; left: 12px; bottom: 12px; pointer-events: auto; border: 1px solid rgba(255,255,255,.45); border-radius: 8px; padding: 9px 14px; background: #1677ff; color: #fff; font: 600 13px/1.3 system-ui,sans-serif; cursor: pointer; }
          .start:hover { background: #0969da; }
          .start:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
          .start[hidden] { display: none; }
        `
        const label = document.createElement('div')
        label.className = 'label'
        label.textContent = 'FlowPick MSR 录制区域'
        const startButton = document.createElement('button')
        startButton.type = 'button'
        startButton.className = 'start'
        startButton.textContent = 'Start Recording'
        startButton.addEventListener('click', async event => {
          event.preventDefault()
          event.stopPropagation()
          if (msrControlState !== 'ready' || !msrControlSessionId) return
          const requestedSessionId = msrControlSessionId
          msrControlState = 'starting'
          startButton.hidden = true
          try {
            // Let the removal paint before requesting tab capture, so the
            // source-page control never appears in the recorded first frame.
            await new Promise(resolve => setTimeout(resolve, 100))
            const result = await browser.runtime.sendMessage({
              type: 'FLOWPICK_MSR_SOURCE_START', sessionId: requestedSessionId,
            }) as any
            if (!result?.ok) throw new Error(result?.error || 'recording-start-failed')
          } catch (error) {
            if (msrControlSessionId !== requestedSessionId) return
            msrControlState = 'ready'
            startButton.hidden = false
            startButton.title = String(error)
            console.warn('[FlowPick] Source-page recording start failed:', error)
          }
        })
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const edge = document.createElement('div')
          edge.className = `edge ${side}`
          shadow.appendChild(edge)
        }
        shadow.append(style, label, startButton)
        document.documentElement.appendChild(host)
        captureRegionOverlay = host
        captureRegionOverlayLabel = label
        captureRegionStartButton = startButton
      }
      captureRegionOverlay.style.left = `${region.x}px`
      captureRegionOverlay.style.top = `${region.y}px`
      captureRegionOverlay.style.width = `${region.width}px`
      captureRegionOverlay.style.height = `${region.height}px`
      if (captureRegionStartButton) captureRegionStartButton.hidden = captureRegionMode !== 'msr' || msrControlState !== 'ready'
      if (captureRegionOverlayLabel) {
        const source = region.kind === 'iframe' ? 'IFRAME' : 'VIDEO'
        captureRegionOverlayLabel.classList.toggle('mse', captureRegionMode === 'mse')
        captureRegionOverlayLabel.classList.toggle('waiting', captureRegionMode === 'mse' && !msePlaybackPlaying)
        captureRegionOverlayLabel.textContent = captureRegionMode === 'mse'
          ? `FlowPick MSE · ${msePlaybackPlaying ? '● 录制中' : '等待播放'} · ${Math.round(region.width)}×${Math.round(region.height)}`
          : `FlowPick MSR · ${source} · ${Math.round(region.width)}×${Math.round(region.height)}`
      }
      captureRegionOverlayLabel?.classList.toggle('below', captureRegionMode === 'msr' && region.y < 32)
    }

    function findBestCaptureRegion(): CaptureRegion | undefined {
      // tabCapture records the top-level visual viewport. Child-frame element
      // coordinates are local to that frame, so only select elements whose
      // bounds can be mapped accurately into the captured tab.
      if (window.top !== window) return undefined
      const videos = querySelectorAllDeep<HTMLVideoElement>('video')
        .map(element => ({
          region: visibleElementRegion(element, 'video'),
          playing: !element.paused && !element.ended && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        }))
        .filter((item): item is { region: CaptureRegion, playing: boolean } => Boolean(item.region))
        .sort((left, right) => {
          const score = (item: { region: CaptureRegion, playing: boolean }) => (
            item.region.width * item.region.height * (item.playing ? 1.25 : 1)
          )
          return score(right) - score(left)
        })
      if (videos[0]) return videos[0].region

      // Cross-origin players hide their inner <video> from the top document.
      // In that case an iframe with a normal video aspect ratio is the most
      // useful safe approximation of the player window.
      return querySelectorAllDeep<HTMLIFrameElement>('iframe')
        .map(element => visibleElementRegion(element, 'iframe'))
        .filter((region): region is CaptureRegion => {
          if (!region) return false
          const ratio = region.width / region.height
          return ratio >= 1.2 && ratio <= 2.5
        })
        .sort((left, right) => right.width * right.height - left.width * left.height)[0]
    }

    function reportCaptureRegion(force = false) {
      if (!msrRegionTracking || window.top !== window) return
      const region = findBestCaptureRegion()
      if (captureRegionOverlayEnabled) showCaptureRegionOverlay(region)
      else hideCaptureRegionOverlay()
      // MSE records media buffers, not this rectangle. The outline is only
      // a playback-page indicator; never alter MSE data or send crop commands.
      if (captureRegionMode === 'mse') return
      const signature = region
        ? [region.x, region.y, region.width, region.height, region.viewportWidth, region.viewportHeight, region.kind]
            .map(value => typeof value === 'number' ? Math.round(value * 10) / 10 : value)
            .join(':')
        : 'full-tab'
      if (!force && signature === lastCaptureRegionSignature) return
      lastCaptureRegionSignature = signature
      browser.runtime.sendMessage({
        type: 'FLOWPICK_RECORDING_CAPTURE_REGION',
        region,
      }).then((result: any) => {
        if (!result?.ok && result?.error === 'recording-session-not-active') stopCaptureRegionTracking()
      }).catch(() => undefined)
    }

    function scheduleCaptureRegionReport(force = false) {
      if (!msrRegionTracking || window.top !== window) return
      if (captureRegionFrame !== undefined) cancelAnimationFrame(captureRegionFrame)
      captureRegionFrame = requestAnimationFrame(() => {
        captureRegionFrame = undefined
        reportCaptureRegion(force)
      })
    }

    function startCaptureRegionTracking(mode: 'mse' | 'msr' = 'msr') {
      if (window.top !== window) return
      captureRegionMode = mode
      msrRegionTracking = true
      // Persist through play/pause; the outline and label are drawn outside
      // the crop rather than hidden when recording starts.
      captureRegionOverlayEnabled = true
      scheduleCaptureRegionReport(true)
      captureRegionTimer ??= setInterval(() => scheduleCaptureRegionReport(), 750)
    }

    function stopCaptureRegionTracking() {
      msrRegionTracking = false
      msePlaybackPlaying = false
      msrControlSessionId = ''
      msrControlState = 'ready'
      captureRegionOverlayEnabled = false
      lastCaptureRegionSignature = ''
      hideCaptureRegionOverlay()
      if (captureRegionTimer) clearInterval(captureRegionTimer)
      captureRegionTimer = undefined
      if (captureRegionFrame !== undefined) cancelAnimationFrame(captureRegionFrame)
      captureRegionFrame = undefined
    }

    function reportPlaybackState(force = false) {
      const playing = [...document.querySelectorAll<HTMLMediaElement>('video, audio')]
        .some(element => !element.paused && !element.ended)
      if (!force && playing === lastReportedPlayback) return
      lastReportedPlayback = playing
      // Publish the player's settled metadata/size before the recorder starts
      // encoding its first frame after a source-page refresh.
      if (playing && msrRegionTracking) reportCaptureRegion(true)
      return browser.runtime.sendMessage({
        type: 'FLOWPICK_RECORDING_PLAYBACK_STATE',
        playing,
      }).then((result: any) => {
        // READY/enable may happen after playback already began. Refresh the
        // badge from the aggregate response even when no transition was sent.
        if (mseCaptureActive && captureRegionMode === 'mse' && typeof result?.playing === 'boolean') {
          msePlaybackPlaying = result.playing
          scheduleCaptureRegionReport(true)
        }
        return result
      }).catch(() => undefined)
    }

    for (const eventName of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'resize']) {
      document.addEventListener(eventName, () => {
        reportPlaybackState()
        scheduleCaptureRegionReport(true)
      }, true)
    }
    window.addEventListener('resize', () => scheduleCaptureRegionReport())
    window.addEventListener('scroll', () => scheduleCaptureRegionReport(), true)
    document.addEventListener('fullscreenchange', () => scheduleCaptureRegionReport(true))
    window.addEventListener('pageshow', () => reportPlaybackState(true))
    window.addEventListener('pagehide', () => {
      lastReportedPlayback = false
      browser.runtime.sendMessage({
        type: 'FLOWPICK_RECORDING_PLAYBACK_STATE',
        playing: false,
      }).catch(() => undefined)
    })

    function arrayBufferToBase64(buffer: ArrayBuffer) {
      const bytes = new Uint8Array(buffer)
      const parts: string[] = []
      const batchSize = 0x8000
      for (let offset = 0; offset < bytes.length; offset += batchSize) {
        parts.push(String.fromCharCode(...bytes.subarray(offset, offset + batchSize)))
      }
      return btoa(parts.join(''))
    }

    function base64ToArrayBuffer(value: string) {
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return bytes.buffer
    }

    function pushRecordingEvent(payload: Record<string, unknown>) {
      recordingPushQueue = recordingPushQueue
        .catch(() => undefined)
        .then(() => browser.runtime.sendMessage({
          type: 'FLOWPICK_RECORDING_STREAM_DATA',
          payload,
        }))
        .then(result => {
          if (!result?.ok) throw new Error(result?.error || 'recording-delivery-rejected')
          return result
        })
        .catch(error => {
          console.warn('[FlowPick] MSE recording delivery failed:', error)
          throw error
        })
      return recordingPushQueue
    }

    function setMseCaptureEnabled(enabled: boolean): Promise<{ ok: boolean, active: boolean }> {
      return new Promise(resolve => {
        const channel = new MessageChannel()
        let settled = false
        const finish = (result: { ok: boolean, active: boolean }) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          channel.port1.close()
          mseCaptureActive = result.active
          if (result.active) {
            startCaptureRegionTracking('mse')
            void reportPlaybackState(true)
          } else if (captureRegionMode === 'mse') stopCaptureRegionTracking()
          resolve(result)
        }
        const timeout = setTimeout(() => {
          console.warn('[FlowPick] MSE page-hook acknowledgement timed out; check Firefox injection/CSP and message bridge')
          finish({ ok: false, active: mseCaptureActive })
        }, enabled ? 3000 : 60000)
        channel.port1.onmessage = event => finish({
          ok: event.data?.ok === true,
          active: event.data?.active === true,
        })
        window.postMessage({ type: 'FLOWPICK_MSE_SET_ENABLED', enabled }, '*', [channel.port2])
      })
    }
    const applyPageSettings = (s: any) => {
      window.postMessage({
        type: 'FLOWPICK_DATA_IMAGES_ENABLE',
        enabled: s?.captureDataImages === true,
        minSizeKB: s?.dataImageMinSizeKB ?? 50,
      }, '*')
    }
    browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: any) => {
      latestSettings = s
      applyPageSettings(s)
    }).catch(() => {})

    window.addEventListener('message', (event) => {
      if (!isRecordingBridgeMessage(event, window, location.origin)) return
      if (event.data?.type === 'FLOWPICK_INJECTED_READY') injectedPageHookReady = true
      if (event.data?.type === 'FLOWPICK_PING') {
        window.postMessage({ type: 'FLOWPICK_PONG', version: browser.runtime.getManifest().version }, '*')
      }
      if (event.data?.type === 'FLOWPICK_INJECTED_READY' && latestSettings) {
        applyPageSettings(latestSettings)
      }
      if (event.data?.type === 'FLOWPICK_INJECTED_READY' && mseCaptureActive) {
        window.postMessage({ type: 'FLOWPICK_MSE_SET_ENABLED', enabled: true }, '*')
      }
      if (event.data?.type === 'FLOWPICK_INJECTED_READY' && !recordingSourceReadySent) {
        recordingSourceReadySent = true
        browser.runtime.sendMessage({ type: 'FLOWPICK_RECORDING_SOURCE_READY' }).then((result: any) => {
          if (result?.capture === true) void setMseCaptureEnabled(true)
          if (result?.mode === 'msr') startCaptureRegionTracking()
          if (result?.ok) reportPlaybackState(true)
        }).catch(() => undefined)
      }
      if (event.data?.type === 'FLOWPICK_INJECTED_READY') void reporter.sync()
      if (event.data?.type === 'FLOWPICK_PAGE_NAVIGATED' && typeof event.data.url === 'string') {
        if (reporter.observeNavigation(event.data.url)) {
          mediaBuffer.length = 0
          douyinTracks.clear()
        }
        if (pageIdentity(event.data.url) === pageIdentity(location.href)) void reporter.sync()
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
                requestHeaders: resp.requestHeaders,
                audioUrl: resp.audioUrl,
              }, '*')
            } else if (retries < 20) {
              retries++
              setTimeout(tryFetch, 300)
            }
          })
        }
        tryFetch()
      }
      if (event.data?.type === 'FLOWPICK_RECORDING_READY') {
        const requestedSessionId = event.data.sessionId
        browser.runtime.sendMessage({
          type: 'FLOWPICK_RECORDING_PAGE_READY',
          sessionId: event.data.sessionId,
        }).then((result: any) => {
          window.postMessage({ type: 'FLOWPICK_RECORDING_CONFIG', sessionId: requestedSessionId, ...(result || { ok: false, error: 'recording-background-no-response' }) }, '*')
          if (result?.ok) {
            recordingConfigPosted = true
            // CONFIG and DATA use the same window message queue: the recorder
            // installs its session ID before consuming the first init bytes.
            for (const payload of pendingRecordingDeliveries.splice(0)) deliverRecordingPayload(payload)
          } else {
            pendingRecordingDeliveries.length = 0
          }
        }).catch(error => {
          window.postMessage({ type: 'FLOWPICK_RECORDING_CONFIG', sessionId: requestedSessionId, ok: false, error: String(error) }, '*')
        })
      }
      if (event.data?.type === 'FLOWPICK_RECORDING_COMMAND') {
        browser.runtime.sendMessage({
          type: 'FLOWPICK_RECORDING_PAGE_COMMAND',
          command: event.data.command,
          sessionId: event.data.sessionId,
        }).then((result: any) => {
          window.postMessage({ type: 'FLOWPICK_RECORDING_COMMAND_RESULT', command: event.data.command, ...(result || { ok: false }) }, '*')
        }).catch(error => {
          window.postMessage({ type: 'FLOWPICK_RECORDING_COMMAND_RESULT', command: event.data.command, ok: false, error: String(error) }, '*')
        })
      }
      if (event.data?.type === 'FLOWPICK_RECORDING_MSR_UI_STATE') {
        void browser.runtime.sendMessage({
          type: 'FLOWPICK_RECORDING_PAGE_COMMAND', command: 'msr-state',
          sessionId: event.data.sessionId, state: event.data.state, label: event.data.label,
        }).catch(() => undefined)
      }
    })

    function requestMsePageAction(action: 'play' | 'download', captureId: string, uiText?: Record<string, string>): Promise<{ ok: boolean; error?: string; errorCode?: string; errorDetail?: string; downloadCount?: number }> {
      return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        let missingCaptureTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (result: { ok: boolean; error?: string; errorCode?: string; errorDetail?: string; downloadCount?: number }) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutTimer)
          if (missingCaptureTimer) clearTimeout(missingCaptureTimer)
          channel.port1.close()
          resolve(result)
        }
        const timeoutTimer = setTimeout(() => finish({
          ok: false,
          errorCode: 'mseCaptureTimeout',
        }), 10000)
        channel.port1.onmessage = (event) => {
          const data = event.data
          // During an unpacked-extension reload, an obsolete injected
          // listener can answer "not found" before the real owner responds.
          // Give the owner a short window; any success wins this race.
          if (data?.type === 'MSE_CAPTURE_ERROR') {
            if (!missingCaptureTimer) {
              missingCaptureTimer = setTimeout(() => finish({
                ok: false,
                errorCode: data.errorCode || 'mseCaptureInvalid',
                errorDetail: data.errorDetail,
              }), 800)
            }
            return
          }
          if (data?.type === 'MSE_DOWNLOAD_DATA') {
            try {
              const downloadCount = handleMseDownload(data)
              finish(downloadCount > 0
                ? { ok: true, downloadCount }
                : { ok: false, errorCode: 'mseNoDownloadData' })
            } catch (error) {
              finish({ ok: false, errorCode: 'mseFileBuildFailed', errorDetail: String(error) })
            }
            return
          }
          if (data?.type === 'MSE_PLAY_RESULT') {
            finish(data.ok
              ? { ok: true }
              : { ok: false, errorCode: data.errorCode || 'msePlayFailedDetail', errorDetail: data.errorDetail || data.error })
            return
          }
          finish({
            ok: false,
            errorCode: data?.errorCode || 'mseNoResult',
            errorDetail: data?.errorDetail || data?.error,
          })
        }
        window.postMessage({
          type: action === 'play' ? 'MSE_PLAY_REQUEST' : 'MSE_DOWNLOAD_REQUEST',
          captureId,
          uiText,
        }, '*', [channel.port2])
      })
    }

    function deliverRecordingPayload(payload: any) {
      const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : undefined
      if (dataBase64) {
        const buffer = base64ToArrayBuffer(dataBase64)
        const { dataBase64: _dataBase64, ...metadata } = payload
        window.postMessage({ type: 'FLOWPICK_RECORDING_DATA', ...metadata, buffer }, '*', [buffer])
      } else {
        window.postMessage({ type: 'FLOWPICK_RECORDING_DATA', ...payload }, '*')
      }
    }

    // 接收 background 发来的消息，通过 postMessage 转发给页面
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'FLOWPICK_SESSION_CHANGED' || msg.type === 'FLOWPICK_SYNC_PAGE') {
        if (msg.type === 'FLOWPICK_SESSION_CHANGED') reporter.invalidate()
        window.postMessage({ type: 'FLOWPICK_CHECK_PAGE' }, '*')
        void reporter.sync()
      }
      if (msg.type === 'FLOWPICK_SOURCE_URL' && msg.sourceUrl) {
        window.postMessage({ type: 'FLOWPICK_SOURCE_URL', sourceUrl: msg.sourceUrl }, '*')
      }
      if (msg.type === 'PROXY_FETCH_RESPONSE') {
        window.postMessage(msg, '*')
      }
      if (msg.type === 'FLOWPICK_NOTIFY_CLICK') {
        window.postMessage({ type: 'FLOWPICK_NOTIFY_CLICK', tag: msg.tag }, '*')
      }
      if (msg.type === 'FLOWPICK_RECORDING_DELIVER') {
        const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {}
        if (!recordingConfigPosted) pendingRecordingDeliveries.push(payload)
        else deliverRecordingPayload(payload)
      }
      if (msg.type === 'FLOWPICK_MSR_REGION_TRACKING_START') {
        if (window.top !== window) return
        if (msrControlSessionId !== msg.sessionId) msrControlState = 'connecting'
        msrControlSessionId = msg.sessionId || ''
        startCaptureRegionTracking()
        return Promise.resolve({ ok: true, region: findBestCaptureRegion() })
      }
      if (msg.type === 'FLOWPICK_RECORDING_SOURCE_START') {
        window.postMessage(msg, '*')
        return Promise.resolve({ ok: true })
      }
      if (msg.type === 'FLOWPICK_MSR_CONTROL_STATE') {
        if (msg.sessionId !== msrControlSessionId) return
        msrControlState = msg.state
        if (captureRegionStartButton) {
          captureRegionStartButton.hidden = msrControlState !== 'ready'
          if (typeof msg.label === 'string' && msg.label) captureRegionStartButton.textContent = msg.label
        }
        if (msg.state === 'starting') return new Promise(resolve => setTimeout(() => resolve({ ok: true }), 100))
        return Promise.resolve({ ok: true })
      }
      if (msg.type === 'FLOWPICK_RECORDING_PLAYBACK_SYNC') {
        return Promise.resolve(reportPlaybackState(true)).then(() => ({ ok: true }))
      }
      if (msg.type === 'FLOWPICK_RECORDING_SESSION_STATE') {
        if (msg.state === 'closed' || msg.state === 'stopped' || msg.state === 'source-closed') stopCaptureRegionTracking()
        window.postMessage({ ...msg, type: 'FLOWPICK_RECORDING_SESSION_STATE' }, '*')
      }
      if (msg.type === 'FLOWPICK_RECORDING_PLAYBACK_STATE') {
        if (mseCaptureActive && captureRegionMode === 'mse') {
          msePlaybackPlaying = msg.playing === true
          scheduleCaptureRegionReport(true)
        }
        window.postMessage({ ...msg, type: 'FLOWPICK_RECORDING_PLAYBACK_STATE' }, '*')
      }
      if (msg.type === 'FLOWPICK_MEDIA_AUTOPLAY') {
        const tryAutoplay = async () => {
          let mediaCount = 0
          let playingCount = 0
          for (const delay of [0, 250, 500, 1000, 1500]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay))
            const media = [...document.querySelectorAll<HTMLMediaElement>('video, audio')]
            mediaCount = Math.max(mediaCount, media.length)
            for (const element of media) {
              if (!element.paused) {
                playingCount++
                continue
              }
              const played = await Promise.race([
                element.play().then(() => true).catch(() => false),
                new Promise<boolean>(resolve => setTimeout(() => resolve(false), 800)),
              ])
              if (played) playingCount++
            }
            if (playingCount > 0) break
          }
          // Keep a few non-blocking retries for players that replace their
          // media element shortly after the load event.
          const playLater = () => {
            for (const element of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
              if (element.paused) void element.play().catch(() => undefined)
            }
          }
          for (const delay of [1000, 2500, 5000]) setTimeout(playLater, delay)
          return { ok: playingCount > 0, mediaCount, playingCount }
        }
        return tryAutoplay()
      }
      if (msg.type === 'MSE_PLAY_TRIGGER' || msg.type === 'MSE_DOWNLOAD_TRIGGER') {
        return requestMsePageAction(msg.type === 'MSE_PLAY_TRIGGER' ? 'play' : 'download', msg.captureId, msg.uiText)
      }
      if (msg.type === 'FLOWPICK_MSE_CAPTURE_SET') {
        const enabled = msg.enabled === true
        return (async () => {
          const result = await setMseCaptureEnabled(enabled)
          await recordingPushQueue.catch(() => undefined)
          return result
        })()
      }
      if (msg.type === 'FLOWPICK_MSE_CAPTURE_STATUS') {
        return Promise.resolve({ ok: true, active: mseCaptureActive })
      }
      if (msg.type === 'FLOWPICK_SETTINGS_CHANGED') {
        window.postMessage({
          type: 'FLOWPICK_DATA_IMAGES_ENABLE',
          enabled: msg.captureDataImages === true,
          minSizeKB: msg.dataImageMinSizeKB ?? 50,
        }, '*')
      }
    })

    window.dispatchEvent(new CustomEvent('m3u8ext:ready'))

    const flowpickFetchControllers = new Map<string, AbortController>()

    // 批量缓冲 M3U8_DETECTED：HLS 直播首屏可能并发数十条分片，逐条 sendMessage
    // 会产生大量 IPC 往返。用 50ms 窗口合并成单条 MEDIA_FOUND_BATCH。
    const mediaBuffer: Array<{ url: string; format: string; pageUrl: string }> = []
    let mediaFlushTimer: ReturnType<typeof setTimeout> | null = null
    // Last-resort Douyin player collector. Unlike generic media sniffing this
    // preserves the relation carried by the CDN playback token, before either
    // URL is rendered as an independent card.
    const douyinTracks = new Map<string, Array<{ url: string; role: 'video' | 'audio'; at: number }>>()
    const douyinGroupKey = (url: string) => {
      let hash = 2166136261
      for (let i = 0; i < url.length; i++) hash = Math.imul(hash ^ url.charCodeAt(i), 16777619)
      return `track_${(hash >>> 0).toString(36)}`
    }
    const isDouyinCdnTrack = (value: string): { key: string; role: 'video' | 'audio' } | undefined => {
      if (window.top !== window) return undefined
      try {
        const parsed = new URL(value)
        if (!/\.(douyinvod|douyincdn|amemv|iesdouyin|snssdk|bytecdn|bytego|bytedance|toutiaovod)\.(?:com|cn|net)$/i.test(parsed.hostname)) return undefined
        const role = /(?:^|[-_/])media-audio(?:[-_/]|$)|\/audio[-_/]/i.test(parsed.pathname)
          ? 'audio'
          : /(?:^|[-_/])media-video(?:[-_/]|$)|\/video[-_/]/i.test(parsed.pathname) ? 'video' : undefined
        const key = parsed.searchParams.get('l') || parsed.searchParams.get('video_id') || parsed.searchParams.get('aweme_id')
        return role && key ? { key, role } : undefined
      } catch {
        return undefined
      }
    }
    const collectDouyinPlayerTrack = (url: string) => {
      const track = isDouyinCdnTrack(url)
      if (!track) return
      const now = Date.now()
      const pending = (douyinTracks.get(track.key) || []).filter(item => now - item.at < 30_000)
      const oppositeIndex = pending.findIndex(item => item.role !== track.role)
      if (oppositeIndex < 0) {
        pending.push({ url, role: track.role, at: now })
        douyinTracks.set(track.key, pending)
        return
      }
      const opposite = pending.splice(oppositeIndex, 1)[0]!
      douyinTracks.set(track.key, pending)
      const video = track.role === 'video' ? url : opposite.url
      const audio = track.role === 'audio' ? url : opposite.url
      const coverUrl = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content
      const duration = document.querySelector('video')?.duration
      reporter.report({
        type: 'PLATFORM_MEDIA_FOUND',
        task: {
          provider: 'douyin', key: douyinGroupKey(video), referer: location.href, priority: 3,
          title: document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title || undefined,
          coverUrl: coverUrl || undefined,
          duration: Number.isFinite(duration) && duration! > 0 ? duration : undefined,
          candidates: [
            { url: video, format: 'mp4', role: 'video', label: '视频' },
            { url: audio, format: 'mp4', role: 'audio', label: '音频' },
          ],
        },
      }).catch(() => {})
    }
    function flushMediaBuffer() {
      mediaFlushTimer = null
      if (mediaBuffer.length === 0) return
      const batch = mediaBuffer.splice(0).filter(item => pageIdentity(item.pageUrl) === pageIdentity(location.href))
      if (!batch.length) return
      reporter.report({
        type: 'MEDIA_FOUND_BATCH',
        items: batch,
      }).catch(() => {})
    }

    window.addEventListener('message', async (event) => {
      if (!isRecordingBridgeMessage(event, window, location.origin)) return
      if (typeof event.data?.pageUrl === 'string' && pageIdentity(event.data.pageUrl) !== pageIdentity(location.href)) return

      // injected 脚本加载后主动请求设置，补发避免竞态丢失
      if (event.data?.type === 'FLOWPICK_REQUEST_SETTINGS') {
        browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((s: any) => {
          if (mseCaptureActive) {
            window.postMessage({ type: 'FLOWPICK_MSE_SET_ENABLED', enabled: true }, '*')
          }
          window.postMessage({
            type: 'FLOWPICK_DATA_IMAGES_ENABLE',
            enabled: s?.captureDataImages === true,
            minSizeKB: s?.dataImageMinSizeKB ?? 50,
          }, '*')
        }).catch(() => {})
      }

      if (
        event.data?.type === 'M3U8_DETECTED' &&
        typeof event.data.url === 'string'
      ) {
        collectDouyinPlayerTrack(event.data.url)
        mediaBuffer.push({ url: event.data.url, format: event.data.format || 'm3u8', pageUrl: event.data.pageUrl || location.href })
        if (mediaFlushTimer === null) {
          mediaFlushTimer = setTimeout(flushMediaBuffer, 50)
        }
        return
      }

      if (event.data?.type === 'BILIBILI_DASH_DETECTED' && event.data.task) {
        void reporter.report({ type: 'BILIBILI_DASH_FOUND', task: event.data.task })
        return
      }

      if (event.data?.type === 'PLATFORM_MEDIA_DETECTED' && event.data.task) {
        reporter.report({ type: 'PLATFORM_MEDIA_FOUND', task: event.data.task }).catch(() => {})
        return
      }

      if (event.data?.type === 'FLOWPICK_MSE_RECORDING_EVENT') {
        const payload: Record<string, unknown> = {
          event: event.data.event,
          captureId: event.data.captureId,
          title: event.data.title,
          totalBytes: event.data.totalBytes,
          trackCount: event.data.trackCount,
          trackIndex: event.data.trackIndex,
          mimeType: event.data.mimeType,
          sequence: event.data.sequence,
        }
        // Chrome runtime messaging serializes messages as JSON, so encode the
        // binary chunk for the extension hop. The target content script turns
        // it back into a transferable ArrayBuffer before exposing it to the UI.
        const buffer = localRecordingBuffer(event.data.buffer)
        if (buffer) payload.dataBase64 = arrayBufferToBase64(buffer)
        else if (event.data.event === 'chunk') console.warn('[FlowPick] MSE chunk has no readable binary buffer')
        void pushRecordingEvent(payload).catch(() => undefined)
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

      if (
        event.data?.type === 'FLOWPICK_FETCH' &&
        typeof event.data.url === 'string'
      ) {
        const { url, requestId, options, responseType = 'arraybuffer' } = event.data
        const abortController = new AbortController()
        flowpickFetchControllers.set(requestId, abortController)
        try {
          const fetchOptions: RequestInit = { signal: abortController.signal, cache: 'no-store' }
          if (options?.headers) {
            // 剔除浏览器可能附加的缓存/条件请求头，避免命中 HTTP 缓存返回 206 局部内容
            const CACHE_HEADER_NAMES = new Set([
              'cache-control', 'pragma', 'if-modified-since', 'if-none-match',
              'if-range', 'if-match', 'if-unmodified-since', 'warning'
            ])
            const clean: Record<string, string> = {}
            for (const [k, v] of Object.entries(options.headers)) {
              if (!CACHE_HEADER_NAMES.has(String(k).toLowerCase())) clean[k] = v as string
            }
            fetchOptions.headers = clean
          }
          const response = await fetch(url, fetchOptions)
          flowpickFetchControllers.delete(requestId)
          const headers: Record<string, string> = {}
          response.headers.forEach((value, key) => { headers[key] = value })

          if (responseType === 'text') {
            const text = await response.text()
            window.postMessage({
              type: 'FLOWPICK_FETCH_RESPONSE',
              requestId,
              ok: response.ok,
              status: response.status,
              headers,
              text,
              responseType: 'text',
            }, '*')
          } else {
            const arrayBuffer = await response.arrayBuffer()
            window.postMessage({
              type: 'FLOWPICK_FETCH_RESPONSE',
              requestId,
              ok: response.ok,
              status: response.status,
              headers,
              buffer: arrayBuffer,
              responseType: 'arraybuffer',
            }, '*', [arrayBuffer])
          }
        } catch (err) {
          flowpickFetchControllers.delete(requestId)
          if (err instanceof DOMException && err.name === 'AbortError') return
          window.postMessage({ type: 'FLOWPICK_FETCH_RESPONSE', requestId, ok: false }, '*')
        }
      }

      if (
        event.data?.type === 'FLOWPICK_FETCH_CANCEL' &&
        typeof event.data.requestId === 'string'
      ) {
        const ctrl = flowpickFetchControllers.get(event.data.requestId)
        if (ctrl) {
          ctrl.abort()
          flowpickFetchControllers.delete(event.data.requestId)
        }
      }

      if (
        event.data?.type === 'FLOWPICK_PROXY_FETCH' &&
        typeof event.data.url === 'string'
      ) {
        const { url, requestId, responseType, options } = event.data

        browser.runtime.sendMessage({
          type: 'PROXY_FETCH',
          url,
          options,
          requestId,
        }).then((resp: any) => {
          if (!resp || !resp.ok) {
            window.postMessage({
              type: 'FLOWPICK_PROXY_FETCH_RESPONSE',
              requestId,
              ok: false,
              status: resp?.status,
              error: resp?.error,
            }, '*')
            return
          }
          const arrayBuffer = b64ToArrayBuffer(resp.data)
          const msg: any = {
            type: 'FLOWPICK_PROXY_FETCH_RESPONSE',
            requestId,
            ok: true,
            status: resp.status,
            headers: resp.headers || {},
            buffer: arrayBuffer,
            responseType: responseType || 'arraybuffer',
          }
          if (responseType === 'text') {
            msg.text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer))
          }
          window.postMessage(msg, '*', [arrayBuffer])
        }).catch(() => {
          window.postMessage({
            type: 'FLOWPICK_PROXY_FETCH_RESPONSE',
            requestId,
            ok: false,
          }, '*')
        })
      }

      if (
        event.data?.type === 'FLOWPICK_PROXY_FETCH_CANCEL' &&
        typeof event.data.requestId === 'string'
      ) {
        // 页面停止播放/离开时主动取消后台的代理拉取，避免后台继续请求分片
        browser.runtime.sendMessage({
          type: 'PROXY_FETCH_CANCEL',
          requestId: event.data.requestId,
        }).catch(() => {})
      }

      if (
        event.data?.type === 'FLOWPICK_NOTIFY' &&
        typeof event.data.title === 'string'
      ) {
        // 普通网页（content 注入）请求扩展后台代发系统通知：
        // 转发给 background，由其调用 chrome.notifications；处理完成后回传 ACK，
        // 页面据此判定扩展已接管，避免再退化为网页通知造成重复。
        const { title, body, tag, pageUrl } = event.data
        browser.runtime.sendMessage({ type: 'FLOWPICK_NOTIFY', title, body, tag, pageUrl: pageUrl || window.location.href })
          .then(() => window.postMessage({ type: 'FLOWPICK_NOTIFY_ACK', tag }, '*'))
          .catch(() => { /* 扩展未处理：页面将回退到网页通知 */ })
      }
    })


    function handleMseDownload(data: {
      captureId: string
      title: string
      tracks: Array<{ mimeType: string; buffers: ArrayBuffer[] }>
    }): number {
      const { title, tracks } = data
      const safeTitle = (title || 'mse-capture').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)
      let downloadCount = 0

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]
        if (!track.buffers || !track.buffers.length) continue

        const totalSize = track.buffers.reduce((s, b) => s + b.byteLength, 0)
        if (totalSize <= 0) continue
        const merged = new Uint8Array(totalSize)
        let offset = 0
        for (const buf of track.buffers) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }

        const isVideo = track.mimeType.startsWith('video/')
        const isAudio = track.mimeType.startsWith('audio/')
        const ext = isVideo ? 'mp4' : isAudio ? 'm4a' : 'bin'
        const suffix = tracks.length > 1 ? `_track${i + 1}` : ''
        const filename = `${safeTitle}${suffix}.${ext}`

        const blob = new Blob([merged], { type: track.mimeType || 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        activeBlobDownloads.add(url)
        // Keep the source document's object URL until the native downloader
        // confirms a terminal state. A messaging error is not completion.
        browser.runtime.sendMessage({ type: 'SAVE_PAGE_BLOB', url, filename, size: blob.size }).then(result => {
          if (result?.terminal) {
            activeBlobDownloads.delete(url)
            URL.revokeObjectURL(url)
          }
          if (!result?.ok) console.warn('[FlowPick] MSE download was not completed:', result?.error)
        }).catch(error => console.warn('[FlowPick] MSE download status unavailable; retaining file:', error))
        downloadCount++
      }
      return downloadCount
    }

    function b64ToArrayBuffer(b64: string): ArrayBuffer {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }

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
