/**
 * The Waiting view: every thread that's waiting on you, across all sections,
 * not just the ones open in panes. bb routes work to the thread that owns it,
 * so replies land all over the sidebar; this gathers them in one list, from
 * bb's own state, with no agent turns.
 *
 * Four groups:
 * - Asking you: a pending question or approval, a failed queued message or a
 *   failed turn. A child thread shows here and nowhere else, and only while
 *   it's waiting for an answer, since its parent relays everything else.
 * - Replies: a top-level thread with a finished turn you haven't read, where
 *   at least one of those turns was yours: you sent it, a child reported back
 *   (the thread passes that on to you), or a thread in a relay section (the
 *   front desk) passed on something you asked.
 * - FYI: the same, but every one of those turns came from another thread or
 *   an automation, like a "noted" reply to a hand-off. Shown, never hidden: a
 *   hand-off can still turn up something you need.
 * - Working: a top-level thread that's busy.
 *
 * "Haven't read" is bb's unread state, plus a thread open in a pane that
 * finished a turn while you weren't looking at that pane, since bb marks any
 * thread in a pane read as soon as it finishes. Opening a thread from here
 * marks it read.
 *
 * Who started a turn comes from the thread's `client/turn/requested` events,
 * and which turns finished after you last read it from its `turn/completed`
 * events, both read with `threads.events.list`.
 *
 * Pure, so it can be tested without bb.
 */

import { isBusy, isWaitingOnUser, stepMemory, type MemoryMap, type ThreadFacts } from "./current.ts";

export type WaitingGroup = "asking" | "reply" | "fyi" | "working";

export const GROUP_ORDER: readonly WaitingGroup[] = ["asking", "reply", "fyi", "working"];

export const GROUP_LABEL: Record<WaitingGroup, string> = {
  asking: "Asking you",
  reply: "Replies",
  fyi: "FYI",
  working: "Working",
};

/** The fields of bb's `PluginSidebarThread` the Waiting view reads. */
export interface WaitingFacts extends ThreadFacts {
  lastReadAt: number | null;
  sectionId: string | null;
}

/** Who started a turn. */
export type TurnOrigin =
  | { kind: "you" }
  | { kind: "child"; threadId: string | null }
  | { kind: "thread"; threadId: string }
  | { kind: "automation" };

/** A turn request or a turn ending, from the thread's event log. */
export type TurnEvent =
  | { kind: "requested"; seq: number; createdAt: number; origin: TurnOrigin }
  | { kind: "completed"; seq: number; createdAt: number };

/** The event types to ask `threads.events.list` for. */
export const TURN_EVENT_TYPES = ["client/turn/requested", "turn/completed"] as const;

/** How many events to read per thread, newest first. */
export const TURN_EVENT_LIMIT = 24;

// An automation's prompt starts with this envelope, whoever bb says sent it.
const AUTOMATION_PREFIX = /^\s*\[bb automation\b/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function firstText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  for (const part of input) {
    const text = record(part)?.text;
    if (typeof text === "string") return text;
  }
  return null;
}

/**
 * Who started a turn, from a `client/turn/requested` event's data. bb marks
 * a message from another thread `initiator: "agent"` with its
 * `senderThreadId`, a child's "completed" notice `initiator: "system"`, and
 * yours `initiator: "user"`. An automation's run also reads as yours, so its
 * prompt envelope is checked first.
 */
export function originOf(data: unknown): TurnOrigin {
  const fields = record(data) ?? {};
  const text = firstText(fields.input);
  if (text !== null && AUTOMATION_PREFIX.test(text)) return { kind: "automation" };
  if (fields.initiator === "agent" && typeof fields.senderThreadId === "string") {
    return { kind: "thread", threadId: fields.senderThreadId };
  }
  if (fields.initiator === "system") {
    const subject = record(fields.systemMessageSubject);
    return { kind: "child", threadId: typeof subject?.threadId === "string" ? subject.threadId : null };
  }
  return { kind: "you" };
}

/** The turn events in a `threads.events.list` response, newest first, dropping anything else. */
export function parseTurnEvents(rows: unknown): TurnEvent[] {
  if (!Array.isArray(rows)) return [];
  const events: TurnEvent[] = [];
  for (const item of rows) {
    const row = record(item);
    if (row === null) continue;
    const { seq, createdAt, type } = row;
    const at = typeof seq === "string" ? Number(seq) : seq;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
    if (type === "turn/completed") {
      events.push({ kind: "completed", seq: at, createdAt });
    } else if (type === "client/turn/requested") {
      events.push({ kind: "requested", seq: at, createdAt, origin: originOf(row.data) });
    }
  }
  return events.sort((a, b) => b.seq - a.seq);
}

/**
 * One turn: who asked for it (a turn can take several messages, a steer or a
 * queued one), and when it finished, or null for the turn still running.
 */
export interface TurnSegment {
  completedAt: number | null;
  origins: TurnOrigin[];
}

/**
 * The events cut into turns, newest first. The first segment is the turn in
 * progress (often empty). When the read stopped at the limit, the oldest
 * segment may be missing its requests, so it's dropped.
 */
export function segmentTurns(events: readonly TurnEvent[], exhausted: boolean): TurnSegment[] {
  const segments: TurnSegment[] = [{ completedAt: null, origins: [] }];
  for (const event of events) {
    if (event.kind === "completed") segments.push({ completedAt: event.createdAt, origins: [] });
    else segments[segments.length - 1]!.origins.push(event.origin);
  }
  if (!exhausted && segments.length > 1) segments.pop();
  return segments;
}

/** Whether a turn another thread started counts as yours: true, false, or null while unknown. */
export type RelayCheck = (threadId: string) => boolean | null;

export type Verdict =
  | { kind: "reply" }
  | { kind: "fyi"; from: TurnOrigin }
  /** Nothing to go on yet; shown as a reply until it's known. */
  | { kind: "unknown" };

/**
 * Yours if any of the turns was: you sent it, a child reported back, or a
 * relay thread passed on your ask. Otherwise FYI, from whoever started the
 * newest one.
 */
export function judge(origins: readonly TurnOrigin[], isRelay: RelayCheck): Verdict {
  if (origins.length === 0) return { kind: "unknown" };
  let unknown = false;
  for (const origin of origins) {
    if (origin.kind === "you" || origin.kind === "child") return { kind: "reply" };
    if (origin.kind === "thread") {
      const relay = isRelay(origin.threadId);
      if (relay === true) return { kind: "reply" };
      if (relay === null) unknown = true;
    }
  }
  if (unknown) return { kind: "unknown" };
  return { kind: "fyi", from: origins[0]! };
}

/**
 * The verdict on what you haven't read: the turns that finished after you
 * last read the thread. With none (bb marked a thread in a pane read as it
 * finished), the newest finished turn.
 */
export function unreadVerdict(
  segments: readonly TurnSegment[],
  lastReadAt: number | null,
  isRelay: RelayCheck,
): Verdict {
  const finished = segments.filter((segment) => segment.completedAt !== null);
  const unread = finished.filter(
    (segment) => lastReadAt === null || segment.completedAt! > lastReadAt,
  );
  const turns = unread.length > 0 ? unread : finished.slice(0, 1);
  return judge(
    turns.flatMap((segment) => segment.origins),
    isRelay,
  );
}

/** The verdict on the turn running now. */
export function runningVerdict(segments: readonly TurnSegment[], isRelay: RelayCheck): Verdict {
  return judge(segments[0]?.origins ?? [], isRelay);
}

/**
 * A relay check from section names or ids (the setting, comma-separated,
 * matched without case) and a way to find a thread's section, which may not be
 * known yet (undefined) for an archived sender.
 */
export function relayCheck(
  setting: string,
  sections: readonly { id: string; name: string }[],
  sectionOf: (threadId: string) => string | null | undefined,
): RelayCheck {
  const relayIds = sectionIdsFor(setting, sections);
  return (threadId) => {
    if (relayIds.size === 0) return false;
    const sectionId = sectionOf(threadId);
    if (sectionId === undefined) return null;
    return sectionId !== null && relayIds.has(sectionId);
  };
}

/**
 * The section ids a setting picks out: section names or ids, comma-separated,
 * case-insensitive. An id that isn't among `sections` still counts.
 */
export function sectionIdsFor(
  setting: string,
  sections: readonly { id: string; name: string }[],
): Set<string> {
  const wanted = setting
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const ids = new Set(
    sections
      .filter(
        (section) =>
          wanted.includes(section.id.toLowerCase()) ||
          wanted.includes(section.name.trim().toLowerCase()),
      )
      .map((section) => section.id),
  );
  for (const part of wanted) if (part.startsWith("sec_")) ids.add(part);
  return ids;
}

/** The fields of bb's `PluginSidebarThread` that finding the front desk reads. */
export interface DeskFacts {
  id: string;
  parentThreadId: string | null;
  sectionId: string | null;
  isHidden: boolean;
  isArchived: boolean;
  isPinned: boolean;
  pinnedAt: number | null;
  createdAt: number;
}

/**
 * Today's front desk: the pinned top-level thread in the desk section, the
 * newest pin if there's more than one, or with none pinned the section's
 * newest thread. Null when the setting names no section or the section has no
 * active thread. The morning run pins each day's desk and archives the old
 * one, so this follows it without a fixed id.
 */
export function findDesk(
  threads: readonly DeskFacts[],
  sections: readonly { id: string; name: string }[],
  setting: string,
): string | null {
  const ids = sectionIdsFor(setting, sections);
  if (ids.size === 0) return null;
  const candidates = threads.filter(
    (thread) =>
      thread.parentThreadId === null &&
      !thread.isHidden &&
      !thread.isArchived &&
      thread.sectionId !== null &&
      ids.has(thread.sectionId),
  );
  const pinned = candidates.filter((thread) => thread.isPinned);
  const pool = pinned.length > 0 ? pinned : candidates;
  const when = (thread: DeskFacts) =>
    pinned.length > 0 ? (thread.pinnedAt ?? 0) : thread.createdAt;
  let best: DeskFacts | null = null;
  for (const thread of pool) {
    if (best === null || when(thread) > when(best) || (when(thread) === when(best) && thread.id > best.id)) {
      best = thread;
    }
  }
  return best?.id ?? null;
}

export interface WaitingRow {
  id: string;
  group: WaitingGroup;
  /** Replies and FYI: on the unread turns. Working: on the running turn. Asking: unknown. */
  verdict: Verdict;
  /** A child asking you: the thread it sits under. */
  parentId: string | null;
  /** Why it's asking, for the Asking you group. */
  asking: "question" | "queued-failed" | "failed" | null;
  attentionAt: number;
}

export interface WaitingInput {
  threads: readonly WaitingFacts[];
  /** Threads open in a pane that finished a turn while you weren't looking at the pane. */
  finishedInPanes: ReadonlySet<string>;
  /** The attention time each thread had when you last opened it here. */
  seen: Readonly<Record<string, number>>;
  /** Each thread's turns, newest first, where they've been read. */
  turns: ReadonlyMap<string, readonly TurnSegment[]>;
  isRelay: RelayCheck;
  /** The thread open in the slide keeps its row, in the group it was in, while it's open. */
  keep: { id: string; group: WaitingGroup } | null;
}

function attentionOf(thread: WaitingFacts): number {
  return thread.latestAttentionAt ?? thread.updatedAt;
}

/** Whether there's a finished turn you haven't read. */
export function hasUnread(
  thread: WaitingFacts,
  finishedInPanes: ReadonlySet<string>,
  seen: Readonly<Record<string, number>>,
): boolean {
  const attention = attentionOf(thread);
  const seenAt = seen[thread.id];
  if (seenAt !== undefined && seenAt >= attention) return false;
  if (thread.isUnread) return true;
  if (thread.lastReadAt === null || attention > thread.lastReadAt) return true;
  return finishedInPanes.has(thread.id);
}

function askingReason(thread: WaitingFacts, child: boolean): WaitingRow["asking"] {
  if (isWaitingOnUser(thread)) {
    return thread.indicator === "queued-failed" && !thread.hasPendingInteraction ? "queued-failed" : "question";
  }
  if (child) return null;
  if (thread.status === "error" || thread.indicator === "unread-error") return "failed";
  return null;
}

/** The threads needing a look, each in its group, newest first within a group. */
export function buildWaiting(input: WaitingInput): WaitingRow[] {
  const { threads, finishedInPanes, seen, turns, isRelay, keep } = input;
  const visible = threads.filter((thread) => !thread.isHidden && !thread.isArchived);
  const ids = new Set(visible.map((thread) => thread.id));
  const rows: WaitingRow[] = [];
  for (const thread of visible) {
    const child = thread.parentThreadId !== null && ids.has(thread.parentThreadId);
    const base = { id: thread.id, attentionAt: attentionOf(thread) };
    const asking = askingReason(thread, child);
    if (asking !== null) {
      rows.push({
        ...base,
        group: "asking",
        verdict: { kind: "unknown" },
        parentId: child ? thread.parentThreadId : null,
        asking,
      });
      continue;
    }
    if (child) continue;
    const segments = turns.get(thread.id) ?? [];
    if (isBusy(thread)) {
      rows.push({
        ...base,
        group: "working",
        verdict: runningVerdict(segments, isRelay),
        parentId: null,
        asking: null,
      });
      continue;
    }
    const unread = hasUnread(thread, finishedInPanes, seen);
    const kept = keep !== null && keep.id === thread.id;
    if (unread || kept) {
      const verdict = unreadVerdict(segments, thread.lastReadAt, isRelay);
      let group: WaitingGroup = verdict.kind === "fyi" ? "fyi" : "reply";
      // Read now, because it's open: it stays where it was until it's closed.
      if (!unread && (keep?.group === "reply" || keep?.group === "fyi")) group = keep.group;
      rows.push({ ...base, group, verdict, parentId: null, asking: null });
    }
  }
  const rank = new Map(GROUP_ORDER.map((group, index) => [group, index]));
  return rows.sort(
    (a, b) => rank.get(a.group)! - rank.get(b.group)! || b.attentionAt - a.attentionAt,
  );
}

/**
 * The threads whose turns the view needs: unread ones to tell a reply from
 * FYI, and busy ones to say who they're working for. The key changes when
 * there's something new to read.
 */
export function turnsWanted(
  threads: readonly WaitingFacts[],
  finishedInPanes: ReadonlySet<string>,
  seen: Readonly<Record<string, number>>,
): { id: string; key: string }[] {
  const ids = new Set(threads.map((thread) => thread.id));
  const out: { id: string; key: string }[] = [];
  for (const thread of threads) {
    if (thread.isHidden || thread.isArchived) continue;
    if (thread.parentThreadId !== null && ids.has(thread.parentThreadId)) continue;
    const busy = isBusy(thread);
    if (!busy && !hasUnread(thread, finishedInPanes, seen)) continue;
    out.push({ id: thread.id, key: `${attentionOf(thread)}:${busy ? "busy" : "idle"}` });
  }
  return out;
}

/** What the rail badge says: a count of Asking you plus Replies, or nothing. */
export interface WaitingTally {
  asking: number;
  replies: number;
  fyi: number;
  working: number;
}

export function tally(rows: readonly WaitingRow[]): WaitingTally {
  const out: WaitingTally = { asking: 0, replies: 0, fyi: 0, working: 0 };
  for (const row of rows) {
    if (row.group === "asking") out.asking += 1;
    else if (row.group === "reply") out.replies += 1;
    else if (row.group === "fyi") out.fyi += 1;
    else out.working += 1;
  }
  return out;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The rail badge: Asking you plus Replies; amber while anything's asking. */
export function badgeFor(
  counts: WaitingTally,
): { count: number; tone: "warning" | "neutral"; label: string } | null {
  const count = counts.asking + counts.replies;
  if (count === 0) return null;
  const parts: string[] = [];
  if (counts.asking > 0) parts.push(plural(counts.asking, "thread asking you", "threads asking you"));
  if (counts.replies > 0) parts.push(plural(counts.replies, "reply", "replies"));
  return {
    count,
    tone: counts.asking > 0 ? "warning" : "neutral",
    label: `Switchboard: ${parts.join(", ")}`,
  };
}

/** "now", "5m", "2h", "3d". */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The threads in panes that finished a turn while you weren't looking at
 * them, for one window. Pane Attention's rule with one change: when the
 * window itself isn't focused, no pane is in view, so a thread finishing in
 * the focused pane of a window you've left counts too.
 */
export function stepPanes(
  memory: MemoryMap,
  panes: readonly { threadId: string | null; isFocused: boolean }[],
  threads: ReadonlyMap<string, ThreadFacts>,
  windowFocused: boolean,
): { memory: MemoryMap; finished: string[] } {
  const shown: ThreadFacts[] = [];
  const inView = new Set<string>();
  for (const pane of panes) {
    if (pane.threadId === null) continue;
    const thread = threads.get(pane.threadId);
    if (thread === undefined) continue;
    if (!shown.includes(thread)) shown.push(thread);
    if (pane.isFocused && windowFocused) inView.add(pane.threadId);
  }
  const next = stepMemory(memory, shown, inView);
  const finished = Object.entries(next)
    .filter(([, entry]) => entry.flag === "done")
    .map(([id]) => id)
    .sort();
  return { memory: next, finished };
}

/** One line of the front desk's ledger. */
export interface LedgerAsk {
  time: string;
  ask: string;
  threadId: string | null;
}

/** The ledger's lines, oldest first, dropping malformed ones. */
export function parseLedger(text: string): LedgerAsk[] {
  const asks: LedgerAsk[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = record(value);
    if (entry === null || typeof entry.ask !== "string" || entry.ask.trim().length === 0) continue;
    const thread = typeof entry.thread === "string" && /^thr_[a-z0-9]+$/.test(entry.thread) ? entry.thread : null;
    asks.push({
      time: typeof entry.time === "string" ? entry.time.trim() : "",
      ask: entry.ask.trim(),
      threadId: thread,
    });
  }
  return asks;
}

/** Today's ledger file name in local time: `2026-11-03.jsonl`. */
export function ledgerFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`;
}

/** The ledger folder as an absolute path, or null when there isn't one to read. */
export function ledgerFolder(setting: string, checkoutPath: string | null): string | null {
  const folder = setting.trim().replace(/\/+$/, "");
  if (folder.length === 0) return null;
  if (folder.startsWith("/")) return folder;
  if (checkoutPath === null) return null;
  return `${checkoutPath.replace(/\/+$/, "")}/${folder.replace(/^\.\//, "")}`;
}

export type AskStatus = WaitingGroup | "read" | "archived" | "none";

export const ASK_STATUS_LABEL: Record<AskStatus, string> = {
  asking: "Asking you",
  reply: "Reply",
  fyi: "FYI",
  working: "Working",
  read: "Read",
  archived: "Archived",
  none: "",
};

/** Where a ledger ask's thread is now. */
export function askStatus(
  threadId: string | null,
  rows: ReadonlyMap<string, WaitingRow>,
  activeIds: ReadonlySet<string>,
): AskStatus {
  if (threadId === null) return "none";
  const row = rows.get(threadId);
  if (row !== undefined) return row.group;
  return activeIds.has(threadId) ? "read" : "archived";
}

/** The seen map as saved, dropping anything malformed. */
export function parseSeen(raw: string | null): Record<string, number> {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: Record<string, number> = {};
  const entries = record(value);
  if (entries === null || Array.isArray(value)) return out;
  for (const [id, at] of Object.entries(entries)) {
    if (/^thr_[a-z0-9]+$/.test(id) && typeof at === "number" && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

/** The seen map with one thread marked, dropping threads no longer active. */
export function markSeen(
  seen: Readonly<Record<string, number>>,
  threadId: string,
  attentionAt: number,
  activeIds: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(seen)) if (activeIds.has(id)) out[id] = at;
  out[threadId] = attentionAt;
  return out;
}
