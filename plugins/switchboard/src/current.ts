/**
 * The list: which threads Switchboard shows, nested how, in what order, and
 * with which state word. The needs-you and busy rules are Pane Attention's,
 * so a thread whose turn has ended while its background agents, commands or
 * workflows are still running is working, not done.
 *
 * "Done" needs a memory. bb marks a thread rendered in a split pane read as
 * soon as its attention time moves, focused or not, and a child thread's
 * attention time doesn't move when it goes idle at all, so bb's own unread
 * flag rarely survives for the threads this list is about. The page keeps a
 * small memory of what each listed thread was doing, and a thread that goes
 * from working to idle while it isn't the one open in the slide is Done
 * until it's opened, or starts working again.
 *
 * A thread's running workflows show as lines under it, where a child would
 * sit. bb's sidebar feed only counts them, so the page reads the detail from
 * the thread's timeline while the count is above zero (see `parseWorkflowRuns`).
 *
 * Pure, so it can be tested without bb.
 */

export type RowState = "needs-you" | "working" | "done" | "idle";

export const STATE_LABEL: Record<RowState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
};

const STATE_RANK: Record<RowState, number> = {
  "needs-you": 0,
  working: 1,
  done: 2,
  idle: 3,
};

/** The fields of bb's `PluginSidebarThread` this logic reads. */
export interface ThreadFacts {
  id: string;
  parentThreadId: string | null;
  status: string;
  runtimeStatus: string;
  hasPendingInteraction: boolean;
  /** Optional so an older host without it reads as nothing running. */
  activity?: ThreadActivity;
  indicator: string;
  isUnread: boolean;
  isHidden: boolean;
  isArchived: boolean;
  latestAttentionAt: number | null;
  updatedAt: number;
}

/** The counts of bb's `PluginSidebarThreadActivity` this logic reads. */
export interface ThreadActivity {
  workflows: number;
  backgroundAgents: number;
  backgroundCommands: number;
}

/** What the page remembers about a listed thread. */
export interface Memory {
  busy: boolean;
  attentionAt: number | null;
  flag: "done" | null;
}

export type MemoryMap = Record<string, Memory>;

export interface Row {
  id: string;
  state: RowState;
  children: Row[];
}

export interface ListOptions {
  /** Pull the children of an open thread into the list, nested under it. */
  showChildren: boolean;
  /** Every active thread, not just the open ones. */
  showAll: boolean;
  /** The thread open in the slide; it's never Done while it's in view. */
  selectedId: string | null;
}

// bb's own lists of execution and runtime statuses that count as working.
const BUSY_STATUS = new Set(["active", "starting", "stopping"]);
const BUSY_RUNTIME = new Set([
  "active",
  "host-reconnecting",
  "provisioning",
  "starting",
  "stopping",
]);

// Live states that wait on the user.
const WAITING_INDICATORS = new Set(["waiting-for-input", "queued-failed"]);

// Work still running after the turn ends. Plan mode and goals are left out:
// they're modes a thread can sit idle in, not work in flight.
function hasBackgroundWork(thread: ThreadFacts): boolean {
  const activity = thread.activity;
  if (activity === undefined) return false;
  return activity.workflows > 0 || activity.backgroundAgents > 0 || activity.backgroundCommands > 0;
}

export function isBusy(thread: ThreadFacts): boolean {
  return (
    BUSY_STATUS.has(thread.status) ||
    BUSY_RUNTIME.has(thread.runtimeStatus) ||
    hasBackgroundWork(thread)
  );
}

export function isWaitingOnUser(thread: ThreadFacts): boolean {
  return thread.hasPendingInteraction || WAITING_INDICATORS.has(thread.indicator);
}

export function stateOf(thread: ThreadFacts, flag: Memory["flag"]): RowState {
  if (isWaitingOnUser(thread) || thread.status === "error") return "needs-you";
  if (isBusy(thread)) return "working";
  if (thread.isUnread || flag === "done") return "done";
  return "idle";
}

function attentionOf(thread: ThreadFacts): number {
  return thread.latestAttentionAt ?? thread.updatedAt;
}

/**
 * Advance the memory by one snapshot for the listed threads.
 *
 * A thread seen for the first time is never flagged. After that, a thread
 * that isn't in view (open in the slide, or in a focused pane) is flagged
 * Done when it stops working, or when bb moves its attention time on. Having
 * it in view, or it starting work again, clears the flag. Threads that left
 * the list are forgotten.
 */
export function stepMemory(
  memory: MemoryMap,
  threads: readonly ThreadFacts[],
  inView: string | null | ReadonlySet<string>,
): MemoryMap {
  const viewed = (id: string) =>
    typeof inView === "string" || inView === null ? id === inView : inView.has(id);
  const next: MemoryMap = {};
  for (const thread of threads) {
    const prev = memory[thread.id];
    const busy = isBusy(thread);
    const attentionAt = thread.latestAttentionAt;
    let flag = prev?.flag ?? null;
    if (viewed(thread.id) || busy) {
      flag = null;
    } else if (prev !== undefined) {
      const bumped =
        attentionAt !== null && prev.attentionAt !== null && attentionAt > prev.attentionAt;
      if (prev.busy || bumped) flag = "done";
    }
    next[thread.id] = { busy, attentionAt, flag };
  }
  return next;
}

/**
 * Build the list. `open` is every thread open in a pane of any window, plus
 * any the page has opened itself. The result's `memory` is the advanced
 * memory, to pass back next time.
 */
export function buildList(
  threads: readonly ThreadFacts[],
  open: ReadonlySet<string>,
  options: ListOptions,
  memory: MemoryMap,
): { rows: Row[]; memory: MemoryMap } {
  const visible = threads.filter((thread) => !thread.isHidden && !thread.isArchived);
  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const childrenOf = new Map<string, ThreadFacts[]>();
  for (const thread of visible) {
    if (thread.parentThreadId === null || !byId.has(thread.parentThreadId)) continue;
    const siblings = childrenOf.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    childrenOf.set(thread.parentThreadId, siblings);
  }

  const included = new Set<string>();
  if (options.showAll) {
    for (const thread of visible) included.add(thread.id);
  } else {
    const queue: string[] = [];
    for (const thread of visible) {
      if (open.has(thread.id)) {
        included.add(thread.id);
        queue.push(thread.id);
      }
    }
    if (options.showChildren) {
      while (queue.length > 0) {
        const id = queue.shift()!;
        for (const child of childrenOf.get(id) ?? []) {
          if (included.has(child.id)) continue;
          included.add(child.id);
          queue.push(child.id);
        }
      }
    }
  }

  const listed = visible.filter((thread) => included.has(thread.id));
  const nextMemory = stepMemory(memory, listed, options.selectedId);

  const compare = (a: ThreadFacts, b: ThreadFacts) => {
    const rank =
      STATE_RANK[stateOf(a, nextMemory[a.id]?.flag ?? null)] -
      STATE_RANK[stateOf(b, nextMemory[b.id]?.flag ?? null)];
    if (rank !== 0) return rank;
    return attentionOf(b) - attentionOf(a);
  };

  const build = (thread: ThreadFacts, seen: Set<string>): Row => {
    seen.add(thread.id);
    const children = (childrenOf.get(thread.id) ?? [])
      .filter((child) => included.has(child.id) && !seen.has(child.id))
      .sort(compare)
      .map((child) => build(child, seen));
    return {
      id: thread.id,
      state: stateOf(thread, nextMemory[thread.id]?.flag ?? null),
      children,
    };
  };

  const seen = new Set<string>();
  const roots = listed
    .filter(
      (thread) => thread.parentThreadId === null || !included.has(thread.parentThreadId),
    )
    .sort(compare);
  const rows = roots.map((thread) => build(thread, seen));
  return { rows, memory: nextMemory };
}

/** Every row in reading order, with its depth, for a flat render. */
export function flatten(rows: readonly Row[], depth = 0): { row: Row; depth: number }[] {
  const out: { row: Row; depth: number }[] = [];
  for (const row of rows) {
    out.push({ row, depth });
    out.push(...flatten(row.children, depth + 1));
  }
  return out;
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
    if (flag !== null && flag !== "done") continue;
    memory[id] = { busy, attentionAt, flag };
  }
  return memory;
}

export function serializeMemory(memory: MemoryMap): string {
  return JSON.stringify(memory);
}

/** One running workflow, from an entry in the timeline's `activeWorkflows`. */
export interface WorkflowRun {
  id: string;
  name: string;
  /** Agents that have finished, failed or been skipped, out of `total`. */
  settled: number;
  failed: number;
  total: number;
  startedAt: number;
  /** Where it is, when the workflow declares phases and its agents carry them. */
  phase: RunPhase | null;
}

/** A declared phase, with its place in the declared list: "Refute", 3 of 5. */
export interface RunPhase {
  title: string | null;
  position: number;
  of: number;
}

/** Each thread's running workflows, by thread id. */
export type RunMap = ReadonlyMap<string, readonly WorkflowRun[]>;

// Skipped in case a snapshot still carries a run that has ended.
const ENDED_TASK = new Set(["completed", "failed", "killed", "stopped"]);
const SETTLED_AGENT = new Set(["done", "failed", "skipped"]);
const ACTIVE_AGENT = new Set(["queued", "running"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The running workflows in a thread timeline response, oldest first, dropping
 * anything malformed. The shape is bb's `threads.timeline` response; it's
 * read field by field because the page takes it as it comes.
 */
export function parseWorkflowRuns(timeline: unknown): WorkflowRun[] {
  const list = record(timeline)?.activeWorkflows;
  if (!Array.isArray(list)) return [];
  const runs: WorkflowRun[] = [];
  for (const item of list) {
    const entry = record(item);
    if (entry === null) continue;
    const { id, startedAt, taskStatus } = entry;
    if (typeof id !== "string" || typeof startedAt !== "number") continue;
    if (typeof taskStatus === "string" && ENDED_TASK.has(taskStatus)) continue;
    const name =
      nonEmpty(entry.workflowName) ?? nonEmpty(record(entry.presentation)?.title) ?? "Workflow";
    const workflow = record(entry.workflow);
    const agents = Array.isArray(workflow?.agents) ? workflow.agents : [];
    let settled = 0;
    let failed = 0;
    let total = 0;
    for (const agent of agents) {
      const state = record(agent)?.state;
      if (typeof state !== "string") continue;
      total += 1;
      if (SETTLED_AGENT.has(state)) settled += 1;
      if (state === "failed") failed += 1;
    }
    const phase = currentPhase(workflow?.phases, agents);
    runs.push({ id, name, settled, failed, total, startedAt, phase });
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * The phase a run is in: the earliest declared phase with an agent queued or
 * running, so a pipeline whose phases overlap never reads further along than
 * it is. Between phases, with nothing queued or running, the latest phase an
 * agent has reached. Null with no declared phases, or no agent in one.
 */
function currentPhase(declared: unknown, agents: readonly unknown[]): RunPhase | null {
  const phases: { index: number; title: string | null }[] = [];
  for (const item of Array.isArray(declared) ? declared : []) {
    const phase = record(item);
    if (typeof phase?.index !== "number") continue;
    phases.push({ index: phase.index, title: nonEmpty(phase.title) });
  }
  phases.sort((a, b) => a.index - b.index);
  const positionOf = new Map(phases.map((phase, i) => [phase.index, i]));
  let earliestActive: number | null = null;
  let latestReached: number | null = null;
  for (const item of agents) {
    const agent = record(item);
    const at = agent?.phaseIndex;
    if (typeof at !== "number" || !positionOf.has(at)) continue;
    const position = positionOf.get(at)!;
    if (latestReached === null || position > latestReached) latestReached = position;
    if (typeof agent?.state === "string" && ACTIVE_AGENT.has(agent.state)) {
      if (earliestActive === null || position < earliestActive) earliestActive = position;
    }
  }
  const position = earliestActive ?? latestReached;
  if (position === null) return null;
  return { title: phases[position]!.title, position: position + 1, of: phases.length };
}

/** "40s", "6m", "1h 5m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The right-hand side of a run line: "Refute · 3 of 5 · 6m" when it's in a
 * declared phase, otherwise "11/13 agents · 6m". Failures are added to either.
 */
export function runProgress(run: WorkflowRun, now: number): string {
  const elapsed = formatElapsed(now - run.startedAt);
  const failed = run.failed > 0 ? `, ${run.failed} failed` : "";
  if (run.phase !== null) {
    const { title, position, of } = run.phase;
    const where = title === null ? `phase ${position} of ${of}` : `${title} · ${position} of ${of}`;
    return `${where}${failed} · ${elapsed}`;
  }
  if (run.total === 0) return elapsed;
  const agents = `${run.settled}/${run.total} ${run.total === 1 ? "agent" : "agents"}`;
  return `${agents}${failed} · ${elapsed}`;
}

/**
 * The listed threads whose workflow count is above zero, in reading order,
 * with the count. These are the ones the page polls.
 */
export function threadsWithWorkflows(
  rows: readonly Row[],
  threads: ReadonlyMap<string, ThreadFacts>,
): { id: string; workflows: number }[] {
  const out: { id: string; workflows: number }[] = [];
  for (const { row } of flatten(rows)) {
    const workflows = threads.get(row.id)?.activity?.workflows ?? 0;
    if (workflows > 0) out.push({ id: row.id, workflows });
  }
  return out;
}

/**
 * The runs after a poll of `polled`. A thread whose fetch failed (null) keeps
 * what it had; a thread no longer polled is dropped.
 */
export function nextRuns(
  previous: RunMap,
  polled: readonly string[],
  fetched: ReadonlyMap<string, readonly WorkflowRun[] | null>,
): RunMap {
  const next = new Map<string, readonly WorkflowRun[]>();
  for (const id of polled) {
    const runs = fetched.get(id) ?? previous.get(id);
    if (runs !== undefined && runs.length > 0) next.set(id, runs);
  }
  return next;
}
