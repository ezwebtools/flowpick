/**
 * Two-layer sniffing pause state.
 *
 * A single boolean cannot express "this tab" and "everything" at once: turning
 * detection back on globally must not silently resume a tab the user paused on
 * purpose, and resuming one tab must not switch the whole extension back on.
 * So the two layers are stored separately and only combined when asked.
 *
 * Deliberately free of `browser`/`chrome`/DOM references: the background worker
 * owns persistence and toolbar calls, this module owns the truth.
 */

export interface SniffSnapshot {
  global: boolean
  tabs: number[]
}

/** Why detection is currently off for a tab, for UI that must say which. */
export type PauseScope = 'none' | 'tab' | 'global' | 'both'

export function createSniffControl(initial?: Partial<SniffSnapshot>) {
  let globalPaused = initial?.global === true
  const pausedTabs = new Set<number>(
    Array.isArray(initial?.tabs) ? initial!.tabs!.filter(id => Number.isInteger(id)) : [],
  )

  /** Global wins: a tab-level resume cannot override a global pause. */
  const isPaused = (tabId: number) => globalPaused || pausedTabs.has(tabId)

  const scopeFor = (tabId: number): PauseScope => {
    const tab = pausedTabs.has(tabId)
    if (globalPaused && tab) return 'both'
    if (globalPaused) return 'global'
    if (tab) return 'tab'
    return 'none'
  }

  return {
    isGlobalPaused: () => globalPaused,
    isTabPaused: (tabId: number) => pausedTabs.has(tabId),
    isPaused,
    scopeFor,
    pausedTabIds: () => [...pausedTabs],

    /** Returns true when the value actually changed. */
    setGlobal(paused: boolean): boolean {
      const next = paused === true
      if (next === globalPaused) return false
      globalPaused = next
      return true
    },

    /** Returns true when the value actually changed. */
    setTab(tabId: number, paused: boolean): boolean {
      if (!Number.isInteger(tabId)) return false
      const has = pausedTabs.has(tabId)
      const want = paused === true
      if (has === want) return false
      if (want) pausedTabs.add(tabId)
      else pausedTabs.delete(tabId)
      return true
    },

    /**
     * Drop every per-tab record for a tab that no longer exists.
     *
     * Note this is *only* for a closed tab. A navigation keeps the pause: the
     * user paused "this tab", and they would not expect a click on a link to
     * re-arm detection behind their back.
     */
    forgetTab(tabId: number): boolean {
      return pausedTabs.delete(tabId)
    },

    clearTabs(): void {
      pausedTabs.clear()
    },

    snapshot(): SniffSnapshot {
      return { global: globalPaused, tabs: [...pausedTabs] }
    },
  }
}

export type SniffControl = ReturnType<typeof createSniffControl>

/** Toolbar icon for the paused state; the normal icon is the manifest default. */
export const PAUSED_ICON_SIZES = [16, 32, 48, 96, 128] as const

/**
 * Paths are relative to the extension root, without a leading slash: both
 * Chromium's `action.setIcon` and Firefox's `browserAction.setIcon` resolve them
 * from there, and Firefox rejects the leading-slash form on some versions.
 */
export function pausedIconPath(): Record<string, string> {
  const path: Record<string, string> = {}
  for (const size of PAUSED_ICON_SIZES) path[String(size)] = `icon/paused-${size}.png`
  return path
}

export function normalIconPath(): Record<string, string> {
  const path: Record<string, string> = {}
  for (const size of PAUSED_ICON_SIZES) path[String(size)] = `icon/${size}.png`
  return path
}

/**
 * What the toolbar should show for one tab.
 *
 * A paused tab clears its badge: a red "12" next to a "blocked" icon reads as
 * "12 things blocked" when it actually means "12 things that were detected
 * before you paused". The two must not be shown together.
 */
export function toolbarVisualFor(paused: boolean, count: number): { paused: boolean; badgeText: string } {
  return { paused, badgeText: paused || count <= 0 ? '' : String(count) }
}

/** Which label the page context menu should carry right now. */
export function pageMenuLabelKey(paused: boolean): 'pauseThisTab' | 'resumeThisTab' {
  return paused ? 'resumeThisTab' : 'pauseThisTab'
}

/** Which label the toolbar-icon menu should carry right now. */
export function globalMenuLabelKey(paused: boolean): 'pauseAllSites' | 'resumeAllSites' {
  return paused ? 'resumeAllSites' : 'pauseAllSites'
}

export type PageMenuAction = 'pauseTab' | 'resumeTab' | 'resumeGlobal'

/**
 * The page context menu carries one item, so its label and its action have to be
 * chosen together.
 *
 * While a global pause is on, "resume this tab" would be a lie: the tab flag
 * would clear and detection would stay off. That is why the item switches to
 * resuming the global layer and says so — a context menu has no tooltip and a
 * greyed-out entry with no explanation is a worse dead end than one that does
 * what it reads.
 */
export function pageMenuActionFor(scope: PauseScope): PageMenuAction {
  if (scope === 'global' || scope === 'both') return 'resumeGlobal'
  if (scope === 'tab') return 'resumeTab'
  return 'pauseTab'
}

export function pageMenuLabelFor(scope: PauseScope): 'pauseThisTab' | 'resumeThisTab' | 'resumeAllSites' {
  const action = pageMenuActionFor(scope)
  if (action === 'resumeGlobal') return 'resumeAllSites'
  return action === 'resumeTab' ? 'resumeThisTab' : 'pauseThisTab'
}
