// Orbit's server side: it keeps a small picture of what each thread is doing
// and tells the open pages when it moves.
//
// bb announces a thread's new events at most once a second
// (`experimental_thread.events`). While a page is showing Orbit, the server
// reads just those new events, only the kinds it draws (turn requests, turn
// starts and ends, tool calls, context readings), turns them into beats
// (src/model.ts) and publishes them over realtime. While no page is showing,
// it only notes which threads moved, and catches up when one opens. It reads
// bb's own log and starts no agent turns.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BEATS_CHANNEL,
  ITEM_TYPES,
  TAIL_TYPES,
  TURN_TYPES,
  applyBeats,
  emptyState,
  parseBeats,
  withContext,
  withoutThreads,
  type Beat,
  type OrbitState,
} from "./src/model";

/** How long a page counts as watching after its last heartbeat. */
const WATCH_TTL_MS = 50_000;
/** The most rows bb gives in one read of a thread's events. */
const PAGE = 100;
/** How many pages a live tail reads before it gives up and reads the thread afresh from its end. */
const TAIL_PAGES = 4;
/** How many threads are read at once when a page first opens. */
const READ_CONCURRENCY = 5;
/** The most threads read when a page first opens, newest activity first. */
const BACKFILL_THREADS = 80;
/** Threads active this recently get their tool calls read too. */
const RECENT_MS = 90 * 60 * 1000;
/** A snapshot waits this long for the first read before answering with what there is. */
const SNAPSHOT_WAIT_MS = 8_000;
/** The most beats sent in one realtime message. */
const PUBLISH_MAX = 60;

const windowIdSchema = z.string().min(1).max(100);

const originSchema = z.enum(["you", "child", "thread", "automation", "maintenance"]);

const vitalsSchema = z.object({
  lastSeq: z.number(),
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  used: z.number().nullable(),
  window: z.number().nullable(),
  turn: z.object({ at: z.number(), origin: originSchema, from: z.string().nullable() }).nullable(),
  ask: z.object({ origin: originSchema, from: z.string().nullable() }).nullable(),
  doing: z.object({ at: z.number(), tool: z.string(), detail: z.string() }).nullable(),
  lastAt: z.number(),
  hist: z.record(z.string(), z.number()),
});

const beatBase = { threadId: z.string(), seq: z.number(), at: z.number() };

const feedBeatSchema = z.discriminatedUnion("kind", [
  z.object({ ...beatBase, kind: z.literal("tool"), tool: z.string(), detail: z.string(), sub: z.boolean(), quiet: z.boolean() }),
  z.object({
    ...beatBase,
    kind: z.literal("ask"),
    origin: originSchema,
    from: z.string().nullable(),
    model: z.string().nullable(),
    reasoning: z.string().nullable(),
    text: z.string(),
    retry: z.boolean(),
  }),
  z.object({ ...beatBase, kind: z.literal("end"), status: z.string() }),
]);

const stateSchema = z.object({
  vitals: z.record(z.string(), vitalsSchema),
  edges: z.array(
    z.object({ key: z.string(), at: z.number(), from: z.string(), to: z.string(), kind: z.enum(["tell", "report"]) }),
  ),
  feed: z.array(feedBeatSchema),
}) satisfies z.ZodType<OrbitState>;

export const rpcContract = defineRpcContract({
  /**
   * Everything Orbit knows now, for a page that has just opened or come back.
   * It also counts the page as watching, and waits for the first read.
   */
  snapshot: {
    input: z.object({ windowId: windowIdSchema }).strict(),
    output: z.object({ state: stateSchema, at: z.number() }),
  },
  /** A page saying it's still showing. Sent every 20 seconds while it is. */
  watch: {
    input: z.object({ windowId: windowIdSchema }).strict(),
    output: z.object({ expiresAt: z.number() }),
  },
  /** A page closing, so the server stops reading at once rather than after the lifetime. */
  unwatch: {
    input: z.object({ windowId: windowIdSchema }).strict(),
    output: z.null(),
  },
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const inner = record(value);
  for (const key of ["events", "threads", "items"]) {
    if (Array.isArray(inner?.[key])) return inner[key] as unknown[];
  }
  return [];
}

/** Runs `work` over `items`, a few at a time. A failure skips that item, and is passed to `failed`. */
async function pooled<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
  failed: (item: T, error: unknown) => void,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item).catch((error: unknown) => failed(item, error));
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BUSY = new Set(["active", "starting", "stopping"]);

export default function orbit(bb: BbPluginApi): void {
  bb.settings.define({
    frontDesk: {
      type: "string",
      label: "Front desk section",
      description:
        "The section (name or id) whose pinned thread is today's front desk. It sits in the middle of the map, with every other section round it. With no pin, the section's newest thread. Empty: no thread in the middle.",
      default: "Front desk",
    },
    ledgerFolder: {
      type: "string",
      label: "Front desk ledger folder",
      description:
        "Where the front desk keeps its daily ledger, one file a day named like 2026-11-03.jsonl, one ask per line. Orbit draws a line from the desk to each thread an ask went to today, and a new ask flies out along it. A relative path is read from the front desk thread's checkout. Empty: no lines.",
      default: "automation/front-desk/ledger",
    },
    motion: {
      type: "boolean",
      label: "Animate the map",
      description:
        "Ripples for tool calls, comets for hand-offs, a glow on threads that are working. Off: the map still follows bb live, but it's drawn still. Your system's Reduce motion setting turns it off too.",
      default: true,
    },
  });

  let state: OrbitState = emptyState();
  /** Pages showing Orbit, each with when its heartbeat runs out. */
  const watchers = new Map<string, number>();
  /** Threads with events not read yet. */
  const dirty = new Set<string>();
  /** The newest event read for each thread. */
  const cursor = new Map<string, number>();
  /** One read per thread at a time; a thread that moves meanwhile is read again after. */
  const reading = new Map<string, Promise<void>>();
  let backfilled = false;
  let catchingUp: Promise<void> | null = null;
  let disposed = false;

  function watched(now: number): boolean {
    for (const [windowId, expiresAt] of watchers) {
      if (expiresAt <= now) watchers.delete(windowId);
    }
    return watchers.size > 0;
  }

  function publish(beats: readonly Beat[]): void {
    if (beats.length === 0 || disposed) return;
    bb.realtime.publish(BEATS_CHANNEL, { beats: beats.slice(-PUBLISH_MAX) });
  }

  /** The newest events of one thread, read from the end: for a thread never read, or one too far behind. */
  async function readLatest(threadId: string, withItems: boolean, itemLimit: number): Promise<Beat[]> {
    const turns = rowsOf(
      await bb.sdk.threads.events.list({ threadId, types: TURN_TYPES, order: "desc", limit: "12" }),
    );
    const items = withItems
      ? rowsOf(
          await bb.sdk.threads.events.list({
            threadId,
            types: ITEM_TYPES,
            order: "desc",
            limit: String(Math.min(PAGE, itemLimit)),
          }),
        )
      : [];
    const beats = parseBeats([...turns, ...items]);
    const newest = beats.reduce((seq, beat) => Math.max(seq, beat.seq), cursor.get(threadId) ?? 0);
    cursor.set(threadId, newest);
    const context = record(await bb.sdk.threads.context({ threadId }).catch(() => null));
    const usage = record(context?.usage);
    const used = typeof usage?.usedTokens === "number" ? usage.usedTokens : null;
    const window = typeof usage?.modelContextWindow === "number" ? usage.modelContextWindow : null;
    state = withContext(state, threadId, used, window);
    return beats;
  }

  /** The events of one thread since the last read. Returns the beats that were new. */
  async function tail(threadId: string): Promise<Beat[]> {
    const from = cursor.get(threadId);
    let beats: Beat[] = [];
    if (from === undefined) {
      beats = await readLatest(threadId, true, 60);
    } else {
      let after = from;
      let caughtUp = false;
      for (let page = 0; page < TAIL_PAGES && !caughtUp; page += 1) {
        const rows = rowsOf(
          await bb.sdk.threads.events.list({
            threadId,
            afterSeq: String(after),
            types: TAIL_TYPES,
            order: "asc",
            limit: String(PAGE),
          }),
        );
        const read = parseBeats(rows);
        beats.push(...read);
        // The cursor follows the rows themselves, since a row that isn't drawn still moves it on.
        for (const row of rows) {
          const seq = Number(record(row)?.seq);
          if (Number.isFinite(seq) && seq > after) after = seq;
        }
        caughtUp = rows.length < PAGE;
      }
      cursor.set(threadId, Math.max(after, cursor.get(threadId) ?? 0));
      // Still more after that many pages: it was left a long while. Jump to its newest events.
      if (!caughtUp) beats = [...beats, ...(await readLatest(threadId, true, PAGE))].sort((a, b) => a.seq - b.seq);
    }
    const known = state.vitals[threadId]?.lastSeq ?? 0;
    const fresh = beats.filter((beat, index) => beat.seq > known && (index === 0 || beats[index - 1]!.seq !== beat.seq));
    state = applyBeats(state, beats, Date.now());
    return fresh;
  }

  /** Read a thread that moved, and publish what was new. */
  function follow(threadId: string): Promise<void> {
    const running = reading.get(threadId);
    if (running !== undefined) {
      dirty.add(threadId);
      return running;
    }
    dirty.delete(threadId);
    const run = tail(threadId)
      .then(publish, (error: unknown) => {
        bb.log.warn(`Reading ${threadId}: ${reason(error)}`);
      })
      .finally(() => {
        reading.delete(threadId);
        if (dirty.has(threadId) && !disposed && watched(Date.now())) void follow(threadId);
      });
    reading.set(threadId, run);
    return run;
  }

  /** The first read: every active thread's recent turns, and the tool calls of the ones lately at work. */
  async function backfill(): Promise<void> {
    const started = Date.now();
    const listed = rowsOf(await bb.sdk.threads.list({ archived: false, limit: 200 }));
    const threads: { id: string; busy: boolean; updatedAt: number }[] = [];
    for (const value of listed) {
      const thread = record(value);
      if (thread === null || typeof thread.id !== "string") continue;
      if (thread.visibility === "hidden" || thread.archivedAt != null) continue;
      const runtime = record(thread.runtime);
      const busy =
        BUSY.has(String(thread.status)) ||
        BUSY.has(String(runtime?.displayStatus)) ||
        (typeof thread.activeBackgroundAgentCount === "number" && thread.activeBackgroundAgentCount > 0);
      threads.push({ id: thread.id, busy, updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : 0 });
    }
    threads.sort((a, b) => Number(b.busy) - Number(a.busy) || b.updatedAt - a.updatedAt);
    const collected: Beat[] = [];
    let unread = 0;
    await pooled(
      threads.slice(0, BACKFILL_THREADS),
      READ_CONCURRENCY,
      async (thread) => {
        const recent = thread.busy || started - thread.updatedAt < RECENT_MS;
        dirty.delete(thread.id);
        collected.push(...(await readLatest(thread.id, recent, thread.busy ? PAGE : 40)));
      },
      (thread, error) => {
        unread += 1;
        bb.log.warn(`First read of ${thread.id}: ${reason(error)}`);
      },
    );
    // One pass in time order, so the feed and the hand-offs come out in order.
    collected.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const byThread = new Map<string, Beat[]>();
    for (const beat of collected) {
      const list = byThread.get(beat.threadId) ?? [];
      list.push(beat);
      byThread.set(beat.threadId, list);
    }
    // Within a thread the order must be by sequence, which time order already is bar ties.
    for (const list of byThread.values()) list.sort((a, b) => a.seq - b.seq);
    const ordered = collected
      .map((beat) => byThread.get(beat.threadId)!.shift()!)
      .filter((beat) => beat !== undefined);
    state = applyBeats(state, ordered, Date.now());
    bb.log.info(
      `First read: ${threads.length} thread(s), ${unread} unread, ${collected.length} beat(s), ${Date.now() - started}ms.`,
    );
  }

  /** Bring the picture up to date for a page that has just started watching. */
  function catchUp(): Promise<void> {
    if (catchingUp !== null) return catchingUp;
    const run = (async () => {
      if (!backfilled) {
        await backfill();
        backfilled = true;
      }
      await pooled(
        [...dirty],
        READ_CONCURRENCY,
        (threadId) => follow(threadId),
        (threadId, error) => bb.log.warn(`Catching up ${threadId}: ${reason(error)}`),
      );
    })()
      .catch((error: unknown) => {
        bb.log.warn(`Catching up: ${reason(error)}`);
      })
      .finally(() => {
        catchingUp = null;
      });
    catchingUp = run;
    return run;
  }

  function startWatching(windowId: string): { expiresAt: number; wasWatched: boolean } {
    const now = Date.now();
    const wasWatched = watched(now);
    const expiresAt = now + WATCH_TTL_MS;
    watchers.set(windowId, expiresAt);
    return { expiresAt, wasWatched };
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (disposed || thread.archivedAt != null || thread.visibility === "hidden") return;
    // Nobody looking: note it and read nothing.
    if (!watched(Date.now()) || !backfilled) {
      dirty.add(thread.id);
      return;
    }
    void follow(thread.id);
  });

  const forget = ({ thread }: { thread: { id: string } }) => {
    dirty.delete(thread.id);
    cursor.delete(thread.id);
    state = withoutThreads(state, [thread.id]);
  };
  bb.events.on("thread.archived", forget);
  bb.events.on("thread.deleted", forget);

  bb.rpc.register(rpcContract, {
    async snapshot({ windowId }) {
      startWatching(windowId);
      const wait = new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS));
      await Promise.race([catchUp(), wait]);
      return { state, at: Date.now() };
    },
    watch({ windowId }) {
      const { expiresAt, wasWatched } = startWatching(windowId);
      if (!wasWatched) void catchUp();
      return { expiresAt };
    },
    unwatch({ windowId }) {
      watchers.delete(windowId);
      return null;
    },
  });

  bb.onDispose(() => {
    disposed = true;
    watchers.clear();
    dirty.clear();
  });
}
