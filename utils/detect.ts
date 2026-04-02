export function isM3U8(url: string) {

  if (!url) return false

  const lower = url.toLowerCase()

  return (
    lower.includes(".m3u8") ||
    lower.includes("m3u8?")
  )
}