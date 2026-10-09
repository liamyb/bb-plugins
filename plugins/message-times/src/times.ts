// Pure logic for Message Times: turning a thread's request events into send
// times, and formatting them. No DOM, no bb imports, so it runs under
// `node --test`.

// The two event types the plugin reads. bb's own timeline builds each user
// row from a client/turn/requested event, and moves a steer's time to the
// matching turn/input/accepted event.
export const EVENT_TYPES = [
  "client/turn/requested",
  "turn/input/accepted",
] as const;

export interface RawEvent {
  seq: number;
  createdAt: number;
  type: string;
  scope?: { kind?: string; turnId?: string } | null;
  data?: Record<string, unknown> | null;
}

export interface MessageTime {
  seq: number;
  requestId: string | null;
  // When bb recorded the request: the moment the message was sent, or for a
  // queued message, the moment bb sent it on from the queue.
  sentAt: number;
  // When the agent took the message in (turn/input/accepted), once known.
  acceptedAt: number | null;
  // A steer is sent while the agent is mid-turn.
  steerTurnId: string | null;
  acceptedTurnId: string | null;
  // Liam's own message, as opposed to a bb system notice or a relayed
  // "message from thread" (bb draws those differently).
  mine: boolean;
}

export interface ThreadTimes {
  bySeq: Map<number, MessageTime>;
  byRequestId: Map<string, number>;
  maxSeq: number;
}

export function emptyThreadTimes(): ThreadTimes {
  return { bySeq: new Map(), byRequestId: new Map(), maxSeq: 0 };
}

// bb's own pattern for an agent-to-agent relay (packages/thread-view
// agent-message-envelope.ts). bb shows those as "Message from <thread>".
const AGENT_ENVELOPE = /^\[bb message from thread:([^;\]\s]+)(?:;[^\]]*)?\]\s*/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inputText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  let text = "";
  for (const part of input) {
    const record = asRecord(part);
    if (record?.type === "text" && typeof record.text === "string") {
      text += record.text;
    }
  }
  return text;
}

function isMine(data: Record<string, unknown>): boolean {
  if (data.initiator !== "user") return false;
  if (typeof data.senderThreadId === "string" && data.senderThreadId) return false;
  const kind = data.systemMessageKind;
  if (kind !== undefined && kind !== null && kind !== "unlabeled") return false;
  return !AGENT_ENVELOPE.test(inputText(data.input));
}

// Folds a page of events (ascending seq) into the thread's times. Returns
// whether anything changed. Events already seen are skipped, so overlapping
// pages are harmless.
export function ingest(times: ThreadTimes, events: readonly RawEvent[]): boolean {
  let changed = false;
  for (const event of events) {
    if (!Number.isFinite(event.seq) || !Number.isFinite(event.createdAt)) continue;
    const data = asRecord(event.data) ?? {};
    if (event.type === "client/turn/requested") {
      if (!times.bySeq.has(event.seq)) {
        const target = asRecord(data.target);
        const steerTurnId =
          target && typeof target.expectedTurnId === "string"
            ? target.expectedTurnId
            : null;
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        times.bySeq.set(event.seq, {
          seq: event.seq,
          requestId,
          sentAt: event.createdAt,
          acceptedAt: null,
          steerTurnId,
          acceptedTurnId: null,
          mine: isMine(data),
        });
        if (requestId) times.byRequestId.set(requestId, event.seq);
        changed = true;
      }
    } else if (event.type === "turn/input/accepted") {
      const requestId =
        typeof data.clientRequestId === "string" ? data.clientRequestId : null;
      const seq = requestId ? times.byRequestId.get(requestId) : undefined;
      const entry = seq === undefined ? undefined : times.bySeq.get(seq);
      if (entry && entry.acceptedAt === null) {
        entry.acceptedAt = event.createdAt;
        entry.acceptedTurnId = event.scope?.turnId ?? null;
        changed = true;
      }
    }
    if (event.seq > times.maxSeq) times.maxSeq = event.seq;
  }
  return changed;
}

// The same rule bb uses for the row's own time (buildClientUserMessage): a
// steer that landed in the turn it aimed at takes the acceptance time;
// everything else keeps the request time.
export function isSteer(entry: MessageTime): boolean {
  if (entry.steerTurnId === null) return false;
  if (entry.acceptedAt === null) return true;
  return entry.acceptedTurnId === null || entry.acceptedTurnId === entry.steerTurnId;
}

export function shownAt(entry: MessageTime): number {
  return isSteer(entry) && entry.acceptedAt !== null ? entry.acceptedAt : entry.sentAt;
}

// A pending steer can still move, so keep asking until it's accepted.
export function isSettled(entry: MessageTime): boolean {
  return !isSteer(entry) || entry.acceptedAt !== null;
}

// Row ids are `${threadId}:user-seed:${seq}`, or `${seq}-${n}` when several
// queued messages went out as one grouped turn.
const ROW_ID = /^(thr_[A-Za-z0-9]+):user-seed:(\d+)(?:-[^:]*)?$/;

export function parseUserRowId(rowId: string): { threadId: string; seq: number } | null {
  const match = ROW_ID.exec(rowId);
  if (!match) return null;
  return { threadId: match[1]!, seq: Number(match[2]) };
}

// Formatting. Names are spelled out rather than taken from Intl, because
// en-GB's short September is "Sept" in current ICU data and "Sep" in older.
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Calendar days between two local dates. Rounding absorbs the 23 and 25 hour
// days at the clock changes.
function daysBetween(earlier: Date, later: Date): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86_400_000);
}

// Today "14:32", yesterday "Yesterday 14:32", two to six days back "Mon 14:32",
// otherwise "Mon 6 Oct, 14:32" (with the year if it isn't this year). Six days,
// not seven, so a bare weekday never means both today and a week ago.
export function formatShort(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const days = daysBetween(date, today);
  if (days === 0) return hhmm(date);
  if (days === 1) return `Yesterday ${hhmm(date)}`;
  const day = DAYS[date.getDay()]!.slice(0, 3);
  if (days > 1 && days < 7) return `${day} ${hhmm(date)}`;
  const year = date.getFullYear() === today.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${day} ${date.getDate()} ${MONTHS[date.getMonth()]!.slice(0, 3)}${year}, ${hhmm(date)}`;
}

// "Monday 6 October 2026, 14:32:05"
export function formatFull(at: number): string {
  const d = new Date(at);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hhmm(d)}:${pad(d.getSeconds())}`;
}

function hhmmss(at: number): string {
  const d = new Date(at);
  return `${hhmm(d)}:${pad(d.getSeconds())}`;
}

// A normal message is usually taken in within a few seconds. Past this, the
// hover says when the agent actually started on it.
export const SLOW_START_MS = 30_000;

// The hover text: the full date and time, plus one line when the agent took
// the message in noticeably later, or when it was a steer.
export function formatDetail(entry: MessageTime): string {
  const lines = [formatFull(shownAt(entry))];
  if (isSteer(entry)) {
    if (entry.acceptedAt === null) {
      lines.push("Sent mid-turn, waiting for the agent to take it in");
    } else if (entry.acceptedAt - entry.sentAt >= 5_000) {
      lines.push(`Sent mid-turn at ${hhmmss(entry.sentAt)}, taken in at ${hhmmss(entry.acceptedAt)}`);
    } else {
      lines.push("Sent mid-turn");
    }
  } else if (entry.acceptedAt !== null && entry.acceptedAt - entry.sentAt >= SLOW_START_MS) {
    lines.push(`The agent started on it at ${hhmmss(entry.acceptedAt)}`);
  }
  return lines.join("\n");
}
