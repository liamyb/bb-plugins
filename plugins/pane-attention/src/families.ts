// Thread families in split panes: which panes belong together, and the
// colour they share. Pure, so it runs under `node --test`.

/** What the plugin needs to know about a thread to place it in a family. */
export interface FamilyThread {
  id: string;
  parentThreadId: string | null;
  title: string;
}

export interface FamilyPane {
  paneId: string;
  /** Null for a pane that isn't showing a thread (New thread, a plugin page). */
  threadId: string | null;
}

/**
 * "child": the thread has a parent. It's tinted and labelled with the
 * parent's title, whether or not the parent is open.
 * "parent": a root thread with at least one of its descendants open in
 * another pane. It's tinted, with no label.
 */
export type FamilyRole = "parent" | "child";

export interface FamilyMark {
  role: FamilyRole;
  /** The top of the family as far as the plugin can see. The colour comes from it. */
  rootId: string;
  hue: number;
  /** Children only. */
  parentId: string | null;
  /** Children only; null until the parent's title is known. */
  parentTitle: string | null;
}

/**
 * The same hash as Sidebar Pro's thread disc, so a family's colour matches
 * the disc beside its root thread in the sidebar.
 */
export function hashHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return hash;
}

/**
 * Walk up from `threadId` to the highest ancestor the lookup knows. When a
 * parent id points at a thread the lookup doesn't have, that id is the root:
 * siblings then still agree on it, so they still share a colour.
 */
export function rootOf(
  threadId: string,
  lookup: (id: string) => FamilyThread | undefined,
): string {
  let current = threadId;
  const seen = new Set<string>([current]);
  for (;;) {
    const parentId = lookup(current)?.parentThreadId ?? null;
    if (parentId === null || seen.has(parentId)) return current;
    seen.add(parentId);
    current = parentId;
  }
}

/**
 * The family mark for each pane that gets one. Panes with no thread, and
 * root threads with nothing of theirs open elsewhere, get none and stay as
 * bb draws them.
 */
export function familyMarks(
  panes: readonly FamilyPane[],
  lookup: (id: string) => FamilyThread | undefined,
): Map<string, FamilyMark> {
  const roots = new Map<string, string>();
  const openPerRoot = new Map<string, number>();
  for (const pane of panes) {
    if (pane.threadId === null) continue;
    const rootId = rootOf(pane.threadId, lookup);
    roots.set(pane.paneId, rootId);
    openPerRoot.set(rootId, (openPerRoot.get(rootId) ?? 0) + 1);
  }

  const marks = new Map<string, FamilyMark>();
  for (const pane of panes) {
    if (pane.threadId === null) continue;
    const rootId = roots.get(pane.paneId)!;
    const parentId = lookup(pane.threadId)?.parentThreadId ?? null;
    if (parentId !== null) {
      marks.set(pane.paneId, {
        role: "child",
        rootId,
        hue: hashHue(rootId),
        parentId,
        parentTitle: lookup(parentId)?.title ?? null,
      });
    } else if ((openPerRoot.get(rootId) ?? 0) > 1) {
      marks.set(pane.paneId, {
        role: "parent",
        rootId,
        hue: hashHue(rootId),
        parentId: null,
        parentTitle: null,
      });
    }
  }
  return marks;
}

/**
 * Thread ids the lookup is missing and should fetch: pane threads, and
 * every ancestor above them, so the walk to the root and the label's title
 * both resolve. Archived threads aren't in the sidebar's list, which is the
 * usual reason one is missing.
 */
export function missingThreadIds(
  panes: readonly FamilyPane[],
  lookup: (id: string) => FamilyThread | undefined,
): string[] {
  const missing = new Set<string>();
  for (const pane of panes) {
    let current = pane.threadId;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const thread = lookup(current);
      if (thread === undefined) {
        missing.add(current);
        break;
      }
      current = thread.parentThreadId;
    }
  }
  return [...missing];
}
