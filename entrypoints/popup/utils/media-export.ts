import type { MediaItem } from '../types'

/** Columns exported for a resource. Kept stable: spreadsheets may reference them. */
const CSV_HEADER = [
  'name', 'url', 'format', 'size_bytes', 'width', 'height', 'duration_seconds', 'page_title',
] as const

function csvCell(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return ''
  const text = String(value)
  // Quote whenever the value could break the row, and escape embedded quotes.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** One URL per line, which is what download managers and wget-style tools eat. */
export function buildUrlListText(items: MediaItem[]): string {
  return items.map(item => item.url).join('\r\n')
}

export function buildCsv(items: MediaItem[], nameOf: (item: MediaItem) => string): string {
  const rows = [CSV_HEADER.join(',')]
  for (const item of items) {
    rows.push([
      csvCell(nameOf(item)),
      csvCell(item.url),
      csvCell(item.format),
      csvCell(item.size),
      csvCell(item.width),
      csvCell(item.height),
      csvCell(item.duration),
      csvCell(item.tabTitle),
    ].join(','))
  }
  // Excel needs the BOM to read UTF-8 without mangling non-Latin titles.
  return `\uFEFF${rows.join('\r\n')}\r\n`
}

/** Hand a generated text file to the browser's download manager. */
export async function downloadTextFile(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  // The popup can close at any moment, so a blob: URL would be revoked before
  // the download starts. A data: URL owns its bytes and survives the teardown.
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const url = `data:${mime};base64,${btoa(binary)}`
  await browser.downloads.download({ url, filename, saveAs: true })
}
