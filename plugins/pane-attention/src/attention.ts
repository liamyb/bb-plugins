/**
 * Which split panes should catch the eye: a thread that finished a turn while
 * its pane was not focused ("done"), or one that is waiting on the user or
 * failed ("needs-you"). The focused pane never carries either.
 *
 * bb's own unread flag can't do this. Every thread rendered in a split pane
 * marks itself read as soon as its attention time moves, focused or not, and a
 * child thread's attention time doesn't move when it goes idle at all. So the
 * plugin keeps its own memory of what each pane's thread was doing.
 *
 * Pure, so it can be tested without bb.
 */

export type Attention = "done" | "needs-you";

/** The fields of bb's `PluginSidebarThread` this logic reads. */
export interface ThreadState {
  status: string;
  runtimeStatus: string;
  hasPendingInteraction: boolean;
  indicator: string;
  latestAttentionAt: number | null;
}

/** One pane of `useSidebarSplitLayout()`. */
export interface Pane {
  paneId: string;
  threadId: string | null;
  isFocused: boolean;
}

/** What the plugin remembers about a thread that is open in a pane. */
export interface Memory {
  busy: boolean;
  attentionAt: number | null;
  flag: "done" | "error" | null;
}

export type MemoryMap = Record<string, Memory>;

// bb's own lists of execution and runtime statuses that count as working.
const BUSY_STATUS = new Set(["active", "starting", "stopping"]);
const BUSY_RUNTIME = new Set([
  "active",
  "host-reconnecting",
  "provisioning",
  "starting",
  "stopping",
]);

// Live states that wait on the user however recently the pane was focused.
const WAITING_INDICATORS = new Set(["waiting-for-input", "queued-failed"]);

export function isBusy(thread: ThreadState): boolean {
  return (
    BUSY_STATUS.has(thread.status) || BUSY_RUNTIME.has(thread.runtimeStatus)
  );
}

export function isWaitingOnUser(thread: ThreadState): boolean {
  return (
    thread.hasPendingInteraction || WAITING_INDICATORS.has(thread.indicator)
  );
}

/**
 * Advance the memory by one snapshot and say which panes to mark.
 *
 * A thread seen for the first time is never flagged. After that, an unfocused
 * pane is flagged when its thread stops working, or when bb moves its
 * attention time on. Focusing the pane, or the thread starting work again,
 * clears the flag. Threads no longer open in any pane are forgotten.
 */
export function step(
  memory: MemoryMap,
  panes: readonly Pane[],
  threads: ReadonlyMap<string, ThreadState>,
): { memory: MemoryMap; attention: Map<string, Attention> } {
  const shown = new Set<string>();
  const focused = new Set<string>();
  for (const pane of panes) {
    if (pane.threadId === null) continue;
    shown.add(pane.threadId);
    if (pane.isFocused) focused.add(pane.threadId);
  }

  const next: MemoryMap = {};
  for (const id of shown) {
    const prev = memory[id];
    const thread = threads.get(id);
    if (thread === undefined) {
      if (prev !== undefined) next[id] = prev;
      continue;
    }
    const busy = isBusy(thread);
    const attentionAt = thread.latestAttentionAt;
    let flag = prev?.flag ?? null;
    if (focused.has(id) || busy) {
      flag = null;
    } else if (prev !== undefined) {
      const bumped =
        attentionAt !== null &&
        prev.attentionAt !== null &&
        attentionAt > prev.attentionAt;
      if (prev.busy || bumped) {
        flag = thread.status === "error" ? "error" : "done";
      }
    }
    next[id] = { busy, attentionAt, flag };
  }

  const attention = new Map<string, Attention>();
  for (const pane of panes) {
    if (pane.threadId === null || focused.has(pane.threadId)) continue;
    const thread = threads.get(pane.threadId);
    const flag = next[pane.threadId]?.flag ?? null;
    if ((thread !== undefined && isWaitingOnUser(thread)) || flag === "error") {
      attention.set(pane.paneId, "needs-you");
    } else if (flag === "done") {
      attention.set(pane.paneId, "done");
    }
  }
  return { memory: next, attention };
}

/** Read memory saved by `serializeMemory`, dropping anything malformed. */
export function parseMemory(raw: string | null): MemoryMap {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const memory: MemoryMap = {};
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { busy, attentionAt, flag } = entry as Record<string, unknown>;
    if (typeof busy !== "boolean") continue;
    if (attentionAt !== null && typeof attentionAt !== "number") continue;
    if (flag !== null && flag !== "done" && flag !== "error") continue;
    memory[id] = { busy, attentionAt, flag };
  }
  return memory;
}

export function serializeMemory(memory: MemoryMap): string {
  return JSON.stringify(memory);
}
