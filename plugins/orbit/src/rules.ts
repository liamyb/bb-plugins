/**
 * Switchboard's rules, copied.
 *
 * Orbit shows the same threads Switchboard does, so it has to agree with it
 * on who started a turn (you, a child reporting back, another thread, an
 * automation, or upkeep such as a compact), on which threads count as working
 * or waiting on you, on which thread is today's front desk, and on how the
 * desk's ledger reads. These are Switchboard's own functions, copied word for
 * word from `plugins/switchboard/src/waiting.ts` and `current.ts`.
 *
 * They're copied, not imported, because bb won't build a plugin whose server
 * imports from outside its own folder. `rules.test.ts` runs both copies over
 * the same inputs whenever Switchboard's source is beside this folder, and
 * fails when they disagree: change a rule there, and copy it here.
 *
 * Pure, so it can be tested without bb.
 */

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

/** Who started a turn. */
export type TurnOrigin =
  | { kind: "you" }
  | { kind: "child"; threadId: string | null }
  /** `at`: when the request reached this thread, to find the sender's turn that sent it. */
  | { kind: "thread"; threadId: string; at?: number }
  | { kind: "automation" }
  /** A `/compact`, or the "Please continue." of a retry after a usage limit. */
  | { kind: "maintenance" };

// An automation's prompt starts with this envelope, whoever bb says sent it.
const AUTOMATION_PREFIX = /^\s*\[bb automation\b/;
// A compact, typed or sent ahead of a message (`bb thread tell --compact-first`).
const COMPACT = /^\s*\/compact\s*$/;
// What bb sends, as a system message with no subject, when it retries a turn.
const CONTINUE = /^\s*Please continue\.?\s*$/i;

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
  if (text !== null && COMPACT.test(text)) return { kind: "maintenance" };
  if (fields.initiator === "agent" && typeof fields.senderThreadId === "string") {
    return { kind: "thread", threadId: fields.senderThreadId };
  }
  if (fields.initiator === "system") {
    const subject = record(fields.systemMessageSubject);
    const threadId = typeof subject?.threadId === "string" ? subject.threadId : null;
    if (threadId === null && text !== null && CONTINUE.test(text)) return { kind: "maintenance" };
    return { kind: "child", threadId };
  }
  return { kind: "you" };
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
