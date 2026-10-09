/**
 * Where something new should open when the split layout is in use, so it
 * never lands on top of the pane Liam is working in.
 *
 * bb's own split-open adds a pane to the right of the focused one, or focuses
 * the pane that already shows the thing. At 8 panes, its hard limit, it
 * replaces the focused pane instead. That last rule is the one this plugin
 * changes: it swaps out the pane he used least recently, or opens nothing and
 * says why.
 *
 * Pure, so it can be tested without bb.
 */

/** bb's hard limit (`atMaxPanes: count >= 8` in its split code). */
export const PANE_LIMIT = 8;

/** One pane of `useSidebarSplitLayout()`. */
export interface Pane {
  paneId: string;
  threadId: string | null;
  isFocused: boolean;
}

export type ThreadPane = Pane & { threadId: string };

/**
 * When each pane last gained focus, in ms, and which pane had it. Focus moves
 * one pane at a time, so the order panes gained focus is also the order they
 * lost it, which is what "least recently used" needs.
 */
export interface FocusMemory {
  at: Record<string, number>;
  focused: string | null;
}

/** What to do when the panes are full. */
export type LimitMode = "replace-oldest" | "notice";

export type Plan =
  /** Leave it to bb: compact layout, or a single pane. */
  | { kind: "default" }
  /** bb's split-open: a new pane on the right, or focus the open one. */
  | { kind: "split" }
  /** At the limit: swap this pane out for the new thing. */
  | { kind: "replace"; pane: ThreadPane }
  /** At the limit with nothing safe to swap out: open nothing. */
  | { kind: "blocked" };

/** Facts about a pane that only the page knows. */
export interface PaneFacts {
  /** Pane Attention has flagged it: a finished turn, or something for him. */
  marked: boolean;
  /** Its thread is mid-turn. */
  busy: boolean;
}

export const EMPTY_MEMORY: FocusMemory = { at: {}, focused: null };

/**
 * Stamp the pane that just gained focus and forget panes that have left the
 * layout. Returns the same object when nothing changed, so callers can skip a
 * write. With nothing split there's no layout to compare, so the memory waits.
 */
export function recordFocus(
  memory: FocusMemory,
  panes: readonly Pane[] | null,
  now: number,
): FocusMemory {
  if (panes === null) return memory;
  const ids = new Set(panes.map((pane) => pane.paneId));
  const focused = panes.find((pane) => pane.isFocused)?.paneId ?? null;
  let changed = focused !== memory.focused;
  const at: Record<string, number> = {};
  for (const [paneId, time] of Object.entries(memory.at)) {
    if (ids.has(paneId)) at[paneId] = time;
    else changed = true;
  }
  if (focused !== null && focused !== memory.focused) at[focused] = now;
  return changed ? { at, focused } : memory;
}

/**
 * The pane to swap out at the limit. Never the focused one, never one that
 * isn't a thread (a plugin can only reach a pane through its thread), and
 * never one Pane Attention has flagged. Idle threads go before busy ones, then
 * the least recently focused, then the leftmost.
 */
export function pickPaneToReplace(
  panes: readonly Pane[],
  memory: FocusMemory,
  facts: (pane: ThreadPane) => PaneFacts,
): ThreadPane | null {
  const candidates: { pane: ThreadPane; order: number; facts: PaneFacts }[] = [];
  panes.forEach((pane, order) => {
    if (pane.isFocused || pane.threadId === null) return;
    const threadPane: ThreadPane = { ...pane, threadId: pane.threadId };
    const paneFacts = facts(threadPane);
    if (paneFacts.marked) return;
    candidates.push({ pane: threadPane, order, facts: paneFacts });
  });
  candidates.sort(
    (a, b) =>
      Number(a.facts.busy) - Number(b.facts.busy) ||
      (memory.at[a.pane.paneId] ?? 0) - (memory.at[b.pane.paneId] ?? 0) ||
      a.order - b.order,
  );
  return candidates[0]?.pane ?? null;
}

export interface PlanInput {
  /** bb's compact layout (under 768px), where there are no splits. */
  compact: boolean;
  /** `useSidebarSplitLayout().panes`, or null when nothing is split. */
  panes: readonly Pane[] | null;
  /** What's being opened is already in a pane, so bb will just focus it. */
  alreadyOpen: boolean;
  mode: LimitMode;
  /** Called only at the limit. */
  pick: () => ThreadPane | null;
}

export function planOpen(input: PlanInput): Plan {
  const { compact, panes } = input;
  if (compact || panes === null || panes.length < 2) return { kind: "default" };
  if (input.alreadyOpen || panes.length < PANE_LIMIT) return { kind: "split" };
  if (input.mode === "notice") return { kind: "blocked" };
  const pane = input.pick();
  return pane === null ? { kind: "blocked" } : { kind: "replace", pane };
}

export function parseMemory(raw: string | null): FocusMemory {
  if (raw === null) return EMPTY_MEMORY;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_MEMORY;
    const record = value as { at?: unknown; focused?: unknown };
    const at: Record<string, number> = {};
    if (typeof record.at === "object" && record.at !== null) {
      for (const [paneId, time] of Object.entries(record.at)) {
        if (typeof time === "number" && Number.isFinite(time)) at[paneId] = time;
      }
    }
    const focused = typeof record.focused === "string" ? record.focused : null;
    return { at, focused };
  } catch {
    return EMPTY_MEMORY;
  }
}
