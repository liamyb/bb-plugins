/**
 * Pane reports: which threads each bb window has open, so the Switchboard
 * page in one window can list the panes of another. Every window's overlay
 * reports its own split layout (or, with no split, the thread its route
 * shows) to the plugin server. The server keeps the union of the live
 * reports and tells every page when it changes.
 *
 * Pure, and shared by server.ts and app.tsx, so it can be tested without bb.
 */

/** Realtime channel for "the open threads changed"; the payload is a `PanesSummary`. */
export const PANES_CHANNEL = "panes";

/** Realtime channel for "open this thread in your split"; the payload is an `OpenRequest`. */
export const OPEN_CHANNEL = "open-thread";

/** Where window reports live in the plugin's kv store. */
export const REPORT_KEY_PREFIX = "window:";

export const DEFAULT_TTL_SECONDS = 120;
export const MIN_TTL_SECONDS = 10;
export const MAX_TTL_SECONDS = 600;

/** bb's own breakpoint for its compact layout, which has no split panes. */
export const COMPACT_QUERY = "(max-width: 767px)";

export interface PaneRef {
  paneId: string;
  /** The thread the pane shows, or null for New thread or a plugin page. */
  threadId: string | null;
  isFocused: boolean;
}

/** What one bb window says about itself. */
export interface PaneReport {
  windowId: string;
  /** The split panes, or null when bb reports no split (one pane, compact, splits off). */
  panes: PaneRef[] | null;
  /**
   * Threads the window shows or holds outside its panes: with no split, the
   * thread its route shows (or showed before a plugin page took its place);
   * with a split, the threads whose pane a plugin page has taken, until that
   * pane shows a thread again or closes.
   */
  extraThreadIds: string[];
  /** The window is in bb's compact layout, so it can't take a split. */
  compact: boolean;
  /** When the window last had focus (epoch ms), or null if it hasn't had it yet. */
  focusedAt: number | null;
  /**
   * Threads in this window's panes that finished a turn while you weren't
   * looking at the pane (see `stepPanes` in waiting.ts). bb marks a thread in
   * a pane read as soon as it finishes, so the Waiting view needs this.
   */
  finishedThreadIds: string[];
}

/** A report as the server stores it. */
export interface StoredReport extends PaneReport {
  reportedAt: number;
  expiresAt: number;
}

/** What the server tells the pages. */
export interface PanesSummary {
  /** Every thread open in a live window, sorted, each once. */
  openThreadIds: string[];
  /** The window "Open in a pane" should use, or null when no window can take a split. */
  ownerWindowId: string | null;
  /** How many windows are reporting. */
  windows: number;
  /** Threads that finished in a pane while you weren't looking, in any window, sorted. */
  finishedThreadIds: string[];
}

export interface OpenRequest {
  windowId: string;
  threadId: string;
}

export const EMPTY_SUMMARY: PanesSummary = {
  openThreadIds: [],
  ownerWindowId: null,
  windows: 0,
  finishedThreadIds: [],
};

/** The pane-report lifetime setting, held inside its bounds. */
export function clampTtlSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(value)));
}

/** How often a window re-reports: a quarter of the lifetime, between 5 and 60 seconds. */
export function heartbeatMs(ttlSeconds: number): number {
  return Math.min(60_000, Math.max(5_000, Math.round((ttlSeconds * 1000) / 4)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPaneRef(value: unknown): value is PaneRef {
  if (!isRecord(value)) return false;
  const { paneId, threadId, isFocused } = value;
  return (
    typeof paneId === "string" &&
    paneId.length > 0 &&
    (threadId === null || typeof threadId === "string") &&
    typeof isFocused === "boolean"
  );
}

/** A list of panes as saved by the overlay, or null when it isn't one. */
export function parsePaneRefs(value: unknown): PaneRef[] | null {
  if (!Array.isArray(value) || !value.every(isPaneRef)) return null;
  return value.map(({ paneId, threadId, isFocused }) => ({ paneId, threadId, isFocused }));
}

export function parseStoredReport(value: unknown): StoredReport | null {
  if (!isRecord(value)) return null;
  const { windowId, panes, extraThreadIds, compact, focusedAt, reportedAt, expiresAt } = value;
  // Reports stored before the Waiting view have no finished list.
  const finished = value.finishedThreadIds ?? [];
  if (typeof windowId !== "string" || windowId.length === 0) return null;
  if (focusedAt !== null && (typeof focusedAt !== "number" || !Number.isFinite(focusedAt))) {
    return null;
  }
  const parsedPanes = panes === null ? null : parsePaneRefs(panes);
  if (panes !== null && parsedPanes === null) return null;
  if (
    !Array.isArray(extraThreadIds) ||
    !extraThreadIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return null;
  }
  if (typeof compact !== "boolean") return null;
  if (!Array.isArray(finished) || !finished.every((id) => typeof id === "string" && id.length > 0)) {
    return null;
  }
  if (typeof reportedAt !== "number" || !Number.isFinite(reportedAt)) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return {
    windowId,
    panes: parsedPanes,
    extraThreadIds: [...(extraThreadIds as string[])],
    compact,
    focusedAt,
    finishedThreadIds: [...(finished as string[])],
    reportedAt,
    expiresAt,
  };
}

/** The reports still in date, most recent first. Malformed and expired ones are dropped. */
export function liveReports(values: readonly unknown[], now: number): StoredReport[] {
  return values
    .map(parseStoredReport)
    .filter((report): report is StoredReport => report !== null && report.expiresAt > now)
    .sort((a, b) => b.reportedAt - a.reportedAt);
}

/** Every thread open in the given windows: the panes' threads and each window's extras. */
export function openThreadIds(reports: readonly PaneReport[]): string[] {
  const ids = new Set<string>();
  for (const report of reports) {
    for (const pane of report.panes ?? []) {
      if (pane.threadId !== null) ids.add(pane.threadId);
    }
    for (const id of report.extraThreadIds) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The panes a plugin page has taken over, with the thread each showed before.
 *
 * `held` is the map so far (pane id to thread id). A pane whose thread turned
 * to null since the previous snapshot, while the window is on a plugin page,
 * is held; a held pane that shows a thread again, or is gone, is released.
 * A null layout (no split, or bb's layout not loaded yet) changes nothing:
 * what's held is still what going back would restore. Returns the same map
 * when nothing changed, so callers can cheaply tell.
 */
export function holdDisplaced(
  held: ReadonlyMap<string, string>,
  previous: readonly PaneRef[] | null,
  current: readonly PaneRef[] | null,
  onPluginPage: boolean,
): ReadonlyMap<string, string> {
  if (current === null) return held;
  const now = new Map(current.map((pane) => [pane.paneId, pane.threadId]));
  const next = new Map(held);
  for (const [paneId] of held) {
    const shown = now.get(paneId);
    if (shown === undefined || shown !== null) next.delete(paneId);
  }
  if (onPluginPage) {
    for (const pane of previous ?? []) {
      if (pane.threadId !== null && now.get(pane.paneId) === null) {
        next.set(pane.paneId, pane.threadId);
      }
    }
  }
  if (next.size === held.size && [...next].every(([id, thread]) => held.get(id) === thread)) {
    return held;
  }
  return next;
}

/** A held map as saved to storage, or empty when it isn't one. */
export function parseHeld(value: unknown): Map<string, string> {
  const held = new Map<string, string>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return held;
  for (const [paneId, threadId] of Object.entries(value)) {
    if (paneId.length > 0 && typeof threadId === "string" && threadId.length > 0) {
      held.set(paneId, threadId);
    }
  }
  return held;
}

/**
 * The window that owns the panes: never a compact one, a window with a split
 * showing before one without, then the one used most recently, then the most
 * recent report.
 */
export function paneOwner(reports: readonly StoredReport[]): string | null {
  let best: StoredReport | null = null;
  for (const report of reports) {
    if (report.compact) continue;
    if (best === null) {
      best = report;
      continue;
    }
    const split = report.panes !== null;
    const bestSplit = best.panes !== null;
    if (split !== bestSplit) {
      if (split) best = report;
      continue;
    }
    const focused = report.focusedAt ?? Number.NEGATIVE_INFINITY;
    const bestFocused = best.focusedAt ?? Number.NEGATIVE_INFINITY;
    if (focused !== bestFocused) {
      if (focused > bestFocused) best = report;
      continue;
    }
    if (report.reportedAt > best.reportedAt) best = report;
  }
  return best?.windowId ?? null;
}

export function summarize(reports: readonly StoredReport[]): PanesSummary {
  const finished = new Set<string>();
  for (const report of reports) for (const id of report.finishedThreadIds) finished.add(id);
  return {
    openThreadIds: openThreadIds(reports),
    ownerWindowId: paneOwner(reports),
    windows: reports.length,
    finishedThreadIds: [...finished].sort(),
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function sameSummary(a: PanesSummary, b: PanesSummary): boolean {
  return (
    a.ownerWindowId === b.ownerWindowId &&
    a.windows === b.windows &&
    sameIds(a.openThreadIds, b.openThreadIds) &&
    sameIds(a.finishedThreadIds, b.finishedThreadIds)
  );
}

/** A summary off the wire, or null when it isn't one. */
export function parseSummary(value: unknown): PanesSummary | null {
  if (!isRecord(value)) return null;
  const { openThreadIds: ids, ownerWindowId, windows } = value;
  const finished = value.finishedThreadIds ?? [];
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((id) => typeof id === "string");
  if (!strings(ids) || !strings(finished)) return null;
  if (ownerWindowId !== null && typeof ownerWindowId !== "string") return null;
  if (typeof windows !== "number" || !Number.isFinite(windows)) return null;
  return {
    openThreadIds: [...new Set(ids)].sort(),
    ownerWindowId,
    windows,
    finishedThreadIds: [...new Set(finished)].sort(),
  };
}

/** An open request off the wire, or null when it isn't one. */
export function parseOpenRequest(value: unknown): OpenRequest | null {
  if (!isRecord(value)) return null;
  const { windowId, threadId } = value;
  if (typeof windowId !== "string" || windowId.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  return { windowId, threadId };
}

/**
 * How long after your own click, key press or bringing the window into focus
 * a move to a thread still counts as yours.
 */
export const STAY_INPUT_GRACE_MS = 1500;

/** How recently the Switchboard page must have been showing for a move to count as leaving it. */
export const STAY_LEFT_WITHIN_MS = 1000;

/**
 * Whether a narrow window should go straight back to Switchboard. bb sends
 * `bb thread open` (how an agent puts a file in its side panel) to every
 * window, and each one goes to that thread, so without this the small window
 * would swap Switchboard for the thread. It goes back when the window is in
 * bb's compact layout (or is only wide because Switchboard widened it for the
 * side panel), it was showing Switchboard a moment ago, it's now on a thread,
 * and nothing in this window started the move.
 */
export function shouldStayOnSwitchboard(input: {
  enabled: boolean;
  compact: boolean;
  /** Switchboard widened this narrow window for its side panel (see slideout.ts). */
  widened: boolean;
  /** Milliseconds since the Switchboard page was last showing; 0 while it still is. */
  msSinceSwitchboard: number | null;
  threadId: string | null;
  /** Milliseconds since the last click, key press or focus in this window. */
  msSinceInput: number;
}): boolean {
  return (
    input.enabled &&
    (input.compact || input.widened) &&
    input.threadId !== null &&
    input.msSinceSwitchboard !== null &&
    input.msSinceSwitchboard <= STAY_LEFT_WITHIN_MS &&
    input.msSinceInput >= STAY_INPUT_GRACE_MS
  );
}
