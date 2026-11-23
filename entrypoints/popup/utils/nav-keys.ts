/**
 * Pure key-resolution for panel navigation.
 *
 * Kept apart from the composable so the rules can be tested without a DOM: the
 * bugs here (stealing Space from a focused button, swallowing Escape in a text
 * field) are invisible in a manual click-through and obvious in a table.
 */

export type NavAction =
  | { type: 'none' }
  | { type: 'blur' }
  | { type: 'escape' }
  | { type: 'search' }
  | { type: 'help' }
  | { type: 'move'; step: number }
  | { type: 'toggle' }
  | { type: 'download' }
  | { type: 'copy' }
  | { type: 'preview' }

const NONE: NavAction = { type: 'none' }

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'password', 'url', 'tel'])

/** Does this element own the keystroke as text input? */
export function isTypingTarget(
  tagName: string,
  isContentEditable = false,
  inputType = '',
): boolean {
  if (isContentEditable) return true
  const tag = tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = inputType.toLowerCase()
  return type === '' || TEXT_INPUT_TYPES.has(type)
}

export interface KeyContext {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  /** The event target is a text field. */
  typing?: boolean
  /** A row is highlighted. */
  hasFocus?: boolean
  /**
   * The target is a button/link that already reacts to Space/Enter; the browser
   * must keep those, or users cannot activate what they tabbed to.
   */
  controlHandlesActivation?: boolean
  defaultPrevented?: boolean
}

/** `Home`/`End` jump by a step large enough to clamp to either end. */
const JUMP = 1e6

export function resolveNavAction(context: KeyContext): NavAction {
  if (context.defaultPrevented) return NONE
  // Browser and OS shortcuts (Ctrl+D bookmarks, Cmd+C copies the page) win.
  if (context.altKey || context.ctrlKey || context.metaKey) return NONE

  const typing = context.typing === true

  if (context.key === 'Escape') {
    // In a text field Escape means "leave the field", not "wipe the query".
    return typing ? { type: 'blur' } : { type: 'escape' }
  }

  // "/" is the fastest way into search; only steal it when not already typing.
  if (context.key === '/' && !typing) return { type: 'search' }

  // "?" opens the cheatsheet. Shift is allowed here because "?" needs it on
  // most layouts, and the modifier check above only blocks Alt/Ctrl/Meta.
  if (context.key === '?' && !typing) return { type: 'help' }

  if (typing) return NONE
  if (context.controlHandlesActivation && (context.key === ' ' || context.key === 'Enter')) return NONE

  switch (context.key) {
    case 'ArrowDown': return { type: 'move', step: 1 }
    case 'ArrowUp': return { type: 'move', step: -1 }
    case 'Home': return { type: 'move', step: -JUMP }
    case 'End': return { type: 'move', step: JUMP }
    default: break
  }

  if (!context.hasFocus) return NONE

  switch (context.key) {
    case ' ': return { type: 'toggle' }
    case 'd':
    case 'D': return { type: 'download' }
    case 'c':
    case 'C': return { type: 'copy' }
    case 'Enter': return { type: 'preview' }
    default: return NONE
  }
}
