/** Firefox forks usually keep the Firefox token; Gecko also covers renamed forks. */
export function isFirefoxFamily(userAgent: string): boolean {
  return /Firefox\/|FxiOS\/|Waterfox|LibreWolf|Floorp|Zen\/|\bGecko\/\d/i.test(userAgent)
}
