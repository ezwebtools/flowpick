/**
 * Keyboard shortcuts.
 *
 * The command ids here are the single source of truth: `wxt.config.ts` builds
 * the manifest `commands` block from them, background.ts resolves them, and
 * the settings UI lists whatever the browser actually bound.
 *
 * Before this module existed the settings screen linked to
 * chrome://extensions/shortcuts while the manifest declared no commands at
 * all, so the page had nothing to configure.
 */
export const COMMAND_IDS = ['_execute_action', 'download-best-stream', 'open-download-queue'] as const

export type CommandId = (typeof COMMAND_IDS)[number]

export interface ShortcutRow {
  id: CommandId
  /** i18n key for the row label inside the extension UI. */
  labelKey: string
  /** i18n key (in _locales) for the manifest command description, if any. */
  descriptionKey?: string
  /** Default binding; also the display value when the browser reports none. */
  fallbackKey: string
}

/** Rows shown in Settings → Keyboard Shortcuts. */
export const SHORTCUT_ROWS: ShortcutRow[] = [
  { id: '_execute_action', labelKey: 'shortcutOpenPanel', fallbackKey: 'Alt+Shift+F' },
  { id: 'download-best-stream', labelKey: 'shortcutDownloadBest', descriptionKey: '__MSG_cmdDownloadBest__', fallbackKey: 'Alt+Shift+D' },
  { id: 'open-download-queue', labelKey: 'shortcutOpenQueue', descriptionKey: '__MSG_cmdOpenQueue__', fallbackKey: 'Alt+Shift+Q' },
]

/**
 * Firefox MV2 exposes the toolbar command as `_execute_browser_action`, so a
 * lookup by the Chromium id alone would report it as unbound.
 */
export function shortcutFor(
  row: ShortcutRow,
  all: Array<{ name?: string; shortcut?: string }>,
): string | undefined {
  const names = row.id === '_execute_action'
    ? ['_execute_action', '_execute_browser_action']
    : [row.id]
  for (const name of names) {
    const found = all.find(item => item.name === name)
    if (found) return found.shortcut ?? ''
  }
  return undefined
}

export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)

/**
 * Chromium reports `Alt+Shift+D`; macOS users see the same string but platform
 * conventions expect `⌥⇧D`. Keep the shape compact so it fits a settings row.
 */
export function formatShortcut(shortcut: string | undefined): string {
  if (!shortcut) return ''
  if (!IS_MAC) return shortcut
  return shortcut
    // MacCtrl must win over the generic Ctrl replacement.
    .replace(/MacCtrl/g, '⌃')
    .replace(/CommandOrControl|Command|Ctrl/g, '⌘')
    .replace(/Alt/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '')
}
