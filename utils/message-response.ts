/** Callback responses also work on Chromium versions without Promise listeners. */
export function withMessageResponse(handle: (message: any) => unknown) {
  return (message: any, _sender: unknown, sendResponse: (response: any) => void): true | undefined => {
    try {
      const result = handle(message)
      // Do not claim messages intended for another listener or frame.
      if (result === undefined) return
      Promise.resolve(result).then(
        value => sendResponse(value),
        error => sendResponse({ ok: false, error: String(error) }),
      ).catch(error => console.debug('[FlowPick] Message response channel closed:', error))
      return true
    } catch (error) {
      sendResponse({ ok: false, error: String(error) })
    }
  }
}