import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import { isTypingTarget, resolveNavAction, type KeyContext } from '../utils/nav-keys'

export interface NavRow {
  /** Stable identity for the row (media key or group master key). */
  key: string
  /** Absolute y position inside the scrolling container. */
  top: number
  /** Row height, used to keep the row fully visible. */
  height: number
}

interface Options {
  /** False while another view (settings) owns the keyboard. */
  active: Ref<boolean>
  rows: () => NavRow[]
  scrollTo: (y: number) => void
  /** Current scrollTop of the list container, read lazily. */
  scrollTop: () => number
  containerHeight: () => number
  onToggleSelect: (key: string) => void
  onDownload: (key: string) => void
  onPreview: (key: string) => void
  onCopy: (key: string) => void
  onSearchFocus: () => void
  /** Show the shortcut cheatsheet. */
  onHelp: () => void
  /** Return true when Escape was consumed by a higher layer (filter, search). */
  onEscape: () => boolean
}

/** Breathing room kept above/below the revealed row. */
const SCROLL_MARGIN = 12

function contextFor(event: KeyboardEvent, hasFocus: boolean): KeyContext {
  const target = event.target as HTMLElement | null
  const typing = target instanceof HTMLElement
    && isTypingTarget(
      target.tagName,
      target.isContentEditable,
      target instanceof HTMLInputElement ? target.type : '',
    )
  const isControl = target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement
  return {
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    typing,
    hasFocus,
    controlHandlesActivation: isControl,
    defaultPrevented: event.defaultPrevented,
  }
}

/**
 * Panel keyboard navigation.
 *
 * Before this existed only the image lightbox listened for keys, so triaging a
 * list of forty detected resources meant forty trips to the mouse. The bindings
 * are the ones a downloader actually needs: jump to search, walk the list, mark
 * items, download, preview, copy.
 */
export function useKeyboardNav(options: Options) {
  const focusedKey = ref<string | null>(null)

  function indexOfKey(key: string | null): number {
    if (!key) return -1
    return options.rows().findIndex(row => row.key === key)
  }

  /** Keep the focused row on screen without fighting the virtualizer. */
  function reveal(row: NavRow) {
    const viewport = options.containerHeight()
    const visibleTop = options.scrollTop()
    const visibleBottom = visibleTop + viewport
    if (row.top - SCROLL_MARGIN < visibleTop) {
      options.scrollTo(Math.max(0, row.top - SCROLL_MARGIN))
    } else if (row.top + row.height + SCROLL_MARGIN > visibleBottom) {
      options.scrollTo(Math.max(0, row.top + row.height + SCROLL_MARGIN - viewport))
    }
  }

  function move(step: number) {
    const rows = options.rows()
    if (!rows.length) return
    const current = indexOfKey(focusedKey.value)
    // A large Home/End step clamps to the first/last row.
    const next = current < 0
      ? (step > 0 ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, current + step))
    focusedKey.value = rows[next].key
    reveal(rows[next])
  }

  // A filter change can remove the focused row. Drop the focus only when that
  // row is actually gone, so typing in search does not reset the position.
  const rowKeys = computed(() => options.rows().map(row => row.key).join('\n'))
  watch(rowKeys, () => {
    const key = focusedKey.value
    if (!key) return
    if (!options.rows().some(row => row.key === key)) focusedKey.value = null
  })

  function handle(event: KeyboardEvent) {
    if (!options.active.value) return
    const action = resolveNavAction(contextFor(event, focusedKey.value !== null))
    if (action.type === 'none') return
    event.preventDefault()
    switch (action.type) {
      case 'blur':
        // Leave the field; the query itself stays so the user can come back.
        ;(event.target as HTMLElement | null)?.blur?.()
        return
      case 'escape':
        // Escape unwinds one layer at a time; only the last one clears focus.
        if (options.onEscape()) return
        focusedKey.value = null
        return
      case 'search':
        options.onSearchFocus()
        return
      case 'help':
        options.onHelp()
        return
      case 'move':
        move(action.step)
        return
      case 'toggle':
        if (focusedKey.value) options.onToggleSelect(focusedKey.value)
        return
      case 'download':
        if (focusedKey.value) options.onDownload(focusedKey.value)
        return
      case 'copy':
        if (focusedKey.value) options.onCopy(focusedKey.value)
        return
      case 'preview':
        if (focusedKey.value) options.onPreview(focusedKey.value)
        return
    }
  }

  window.addEventListener('keydown', handle)
  onUnmounted(() => window.removeEventListener('keydown', handle))

  return {
    focusedKey,
    move,
    focusKey: (key: string) => { focusedKey.value = key },
    clearFocus: () => { focusedKey.value = null },
  }
}
