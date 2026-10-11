/** Firefox can report null sources for messages sent by extension contexts. */
export function isRecordingBridgeMessage(event: MessageEvent, pageWindow: Window, origin: string) {
  if (event.source === pageWindow) return true
  return event.source === null && event.origin === origin && [
    'FLOWPICK_INJECTED_READY', 'FLOWPICK_MSE_SET_ENABLED',
    'FLOWPICK_MSE_RECORDING_EVENT', 'FLOWPICK_MSE_RECORDING_FLUSH',
  ].includes(event.data?.type)
}

/** Brand-check/copy instead of instanceof, which fails across realms. */
export function localRecordingBuffer(value: unknown): ArrayBuffer | undefined {
  try {
    return ArrayBuffer.prototype.slice.call(value, 0)
  } catch {
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer
    }
    return undefined
  }
}
