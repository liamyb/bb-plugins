// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askStatus,
  badgeFor,
  buildWaiting,
  formatAgo,
  hasUnread,
  judge,
  ledgerFileName,
  ledgerFolder,
  markSeen,
  originOf,
  parseLedger,
  parseSeen,
  parseTurnEvents,
  relayCheck,
  segmentTurns,
  stepPanes,
  tally,
  turnsWanted,
  unreadVerdict,
  type RelayCheck,
  type TurnSegment,
  type WaitingFacts,
  type WaitingInput,
  type WaitingRow,
} from "./waiting.ts";

function thread(id: string, extra: Partial<WaitingFacts> = {}): WaitingFacts {
  return {
    id,
    parentThreadId: null,
    status: "idle",
    runtimeStatus: "idle",
    hasPendingInteraction: false,
    indicator: "none",
    isUnread: false,
    isHidden: false,
    isArchived: false,
    latestAttentionAt: 1_000,
    updatedAt: 1_000,
    lastReadAt: 1_000,
    sectionId: null,
    ...extra,
  };
}

const noRelay: RelayCheck = () => false;

function input(threads: WaitingFacts[], extra: Partial<WaitingInput> = {}): WaitingInput {
  return {
    threads,
    finishedInPanes: new Set(),
    seen: {},
    turns: new Map(),
    isRelay: noRelay,
    keep: null,
    ...extra,
  };
}

function groups(rows: readonly WaitingRow[]): string[] {
  return rows.map((row) => `${row.group}:${row.id}`);
}

const you = { kind: "you" } as const;
const fromThread = (threadId: string) => ({ kind: "thread", threadId }) as const;
const done = (completedAt: number, ...origins: TurnSegment["origins"]): TurnSegment => ({
  completedAt,
  origins,
});
const running = (...origins: TurnSegment["origins"]): TurnSegment => ({ completedAt: null, origins });

test("bb's turn request fields say who started a turn", () => {
  assert.deepEqual(originOf({ initiator: "user", senderThreadId: null }), you);
  assert.deepEqual(
    originOf({ initiator: "agent", senderThreadId: "thr_desk" }),
    fromThread("thr_desk"),
  );
  assert.deepEqual(
    originOf({
      initiator: "system",
      systemMessageKind: "child-completed",
      systemMessageSubject: { kind: "thread", threadId: "thr_kid" },
    }),
    { kind: "child", threadId: "thr_kid" },
  );
  // An automation's run reads as the user's, so its envelope decides.
  assert.deepEqual(
    originOf({
      initiator: "user",
      source: "spawn",
      input: [{ type: "text", text: "[bb automation due:auto_x]\n\nYou are today's desk" }],
    }),
    { kind: "automation" },
  );
  assert.deepEqual(originOf(null), you);
});

test("turn events parse newest first and skip anything else", () => {
  const events = parseTurnEvents([
    { seq: 5, createdAt: 50, type: "client/turn/requested", data: { initiator: "user" } },
    { seq: 9, createdAt: 90, type: "turn/completed", data: {} },
    { seq: "7", createdAt: 70, type: "turn/completed" },
    { seq: 8, createdAt: 80, type: "item/completed" },
    { seq: 6, type: "turn/completed" },
    "junk",
  ]);
  assert.deepEqual(
    events.map((event) => `${event.kind}@${event.seq}`),
    ["completed@9", "completed@7", "requested@5"],
  );
  assert.deepEqual(parseTurnEvents({ rows: [] }), []);
});

test("events cut into turns, and a cut-off oldest turn is dropped", () => {
  const events = parseTurnEvents([
    { seq: 10, createdAt: 100, type: "client/turn/requested", data: { initiator: "user" } },
    { seq: 9, createdAt: 90, type: "turn/completed" },
    { seq: 8, createdAt: 80, type: "client/turn/requested", data: { initiator: "agent", senderThreadId: "thr_a" } },
    { seq: 7, createdAt: 70, type: "client/turn/requested", data: { initiator: "user" } },
    { seq: 6, createdAt: 60, type: "turn/completed" },
  ]);
  const all = segmentTurns(events, true);
  assert.deepEqual(all, [
    running(you),
    done(90, fromThread("thr_a"), you),
    done(60),
  ]);
  // Read to the limit: the oldest turn may be missing its requests.
  assert.deepEqual(segmentTurns(events, false), all.slice(0, 2));
});

test("a turn is yours if you, a child or a relay thread started any part of it", () => {
  const desk: RelayCheck = (id) => id === "thr_desk";
  assert.deepEqual(judge([you], noRelay), { kind: "reply" });
  assert.deepEqual(judge([{ kind: "child", threadId: "thr_kid" }], noRelay), { kind: "reply" });
  assert.deepEqual(judge([fromThread("thr_desk")], desk), { kind: "reply" });
  assert.deepEqual(judge([fromThread("thr_hub"), you], noRelay), { kind: "reply" });
  assert.deepEqual(judge([fromThread("thr_hub"), { kind: "automation" }], noRelay), {
    kind: "fyi",
    from: fromThread("thr_hub"),
  });
  assert.deepEqual(judge([], noRelay), { kind: "unknown" });
  // A sender whose section isn't known yet can't be called FYI.
  assert.deepEqual(judge([fromThread("thr_old")], () => null), { kind: "unknown" });
});

test("only turns that finished after the last read decide, else the newest one", () => {
  const segments = [
    running(),
    done(300, fromThread("thr_hub")), // a "noted" reply to a hand-off, unread
    done(200, you), // your question, answered and read
  ];
  assert.deepEqual(unreadVerdict(segments, 250, noRelay), {
    kind: "fyi",
    from: fromThread("thr_hub"),
  });
  // Both unread: your answer is in there.
  assert.deepEqual(unreadVerdict(segments, 150, noRelay), { kind: "reply" });
  // bb marked it read as it finished (a pane): the newest turn decides.
  assert.deepEqual(unreadVerdict(segments, 400, noRelay), {
    kind: "fyi",
    from: fromThread("thr_hub"),
  });
  assert.deepEqual(unreadVerdict([running(you)], 100, noRelay), { kind: "unknown" });
});

test("relay sections match by name or id, and an unknown sender stays unknown", () => {
  const sections = [
    { id: "sec_desk", name: "Front desk" },
    { id: "sec_vend", name: "Vendors" },
  ];
  const where: Record<string, string | null> = { thr_desk: "sec_desk", thr_hub: "sec_vend", thr_loose: null };
  const check = relayCheck(" front DESK ", sections, (id) => where[id]);
  assert.equal(check("thr_desk"), true);
  assert.equal(check("thr_hub"), false);
  assert.equal(check("thr_loose"), false);
  assert.equal(check("thr_archived"), null);
  assert.equal(relayCheck("sec_vend", sections, (id) => where[id])("thr_hub"), true);
  assert.equal(relayCheck("", sections, () => undefined)("thr_desk"), false);
});

test("unread is bb's flag, attention after the last read, or a pane that finished unwatched", () => {
  assert.equal(hasUnread(thread("a"), new Set(), {}), false);
  assert.equal(hasUnread(thread("a", { isUnread: true }), new Set(), {}), true);
  assert.equal(hasUnread(thread("a", { latestAttentionAt: 2_000 }), new Set(), {}), true);
  assert.equal(hasUnread(thread("a", { lastReadAt: null }), new Set(), {}), true);
  assert.equal(hasUnread(thread("a"), new Set(["a"]), {}), true);
  // Opened here since it last finished.
  assert.equal(hasUnread(thread("a", { latestAttentionAt: 2_000 }), new Set(["a"]), { a: 2_000 }), false);
  // And finished again after that.
  assert.equal(hasUnread(thread("a", { latestAttentionAt: 3_000 }), new Set(), { a: 2_000 }), true);
});

test("the 3 Nov case: replies, FYI hand-offs shown, children left out", () => {
  const unread = { latestAttentionAt: 2_000 };
  const threads = [
    thread("thr_answered", unread),
    thread("thr_finding", { ...unread, latestAttentionAt: 2_100 }),
    thread("thr_noted", unread),
    thread("thr_parent"),
    thread("thr_stale_child", { ...unread, parentThreadId: "thr_parent" }),
    thread("thr_asking_child", { parentThreadId: "thr_parent", hasPendingInteraction: true }),
    thread("thr_read"),
  ];
  const turns = new Map<string, TurnSegment[]>([
    ["thr_answered", [running(), done(1_900, you)]],
    ["thr_finding", [running(), done(2_050, fromThread("thr_review"))]],
    ["thr_noted", [running(), done(1_950, fromThread("thr_review"))]],
  ]);
  const rows = buildWaiting(input(threads, { turns }));
  assert.deepEqual(groups(rows), [
    "asking:thr_asking_child",
    "reply:thr_answered",
    "fyi:thr_finding",
    "fyi:thr_noted",
  ]);
  assert.equal(rows[0]!.parentId, "thr_parent");
  assert.equal(rows[0]!.asking, "question");
});

test("asking covers questions, failed queued messages and failed turns; working is busy", () => {
  const rows = buildWaiting(
    input([
      thread("q", { hasPendingInteraction: true, status: "active" }),
      thread("queued", { indicator: "queued-failed", latestAttentionAt: 900 }),
      thread("failed", { status: "error", latestAttentionAt: 800 }),
      thread("busy", { status: "active" }),
      thread("bg", { activity: { workflows: 1, backgroundAgents: 0, backgroundCommands: 0 } }),
      thread("child-failed", { parentThreadId: "busy", status: "error" }),
    ]),
  );
  assert.deepEqual(groups(rows), [
    "asking:q",
    "asking:queued",
    "asking:failed",
    "working:busy",
    "working:bg",
  ]);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.asking),
    ["question", "queued-failed", "failed"],
  );
});

test("a reply whose turns aren't read yet shows as a reply, and hidden or archived never show", () => {
  const rows = buildWaiting(
    input([
      thread("new", { latestAttentionAt: 2_000 }),
      thread("hidden", { latestAttentionAt: 2_000, isHidden: true }),
      thread("gone", { latestAttentionAt: 2_000, isArchived: true }),
    ]),
  );
  assert.deepEqual(groups(rows), ["reply:new"]);
  assert.deepEqual(rows[0]!.verdict, { kind: "unknown" });
});

test("the thread open in the slide keeps its row after it's read", () => {
  const turns = new Map([["a", [running(), done(900, fromThread("thr_hub"))]]]);
  const rows = buildWaiting(input([thread("a")], { turns, keep: { id: "a", group: "fyi" } }));
  assert.deepEqual(groups(rows), ["fyi:a"]);
  assert.deepEqual(groups(buildWaiting(input([thread("a")], { turns }))), []);
});

test("a working thread says who it's working for", () => {
  const turns = new Map([["a", [running(fromThread("thr_hub")), done(900, you)]]]);
  const rows = buildWaiting(input([thread("a", { status: "active" })], { turns }));
  assert.deepEqual(rows[0]!.verdict, { kind: "fyi", from: fromThread("thr_hub") });
});

test("turns are wanted for unread and busy top-level threads, keyed by attention", () => {
  const wanted = turnsWanted(
    [
      thread("read"),
      thread("unread", { latestAttentionAt: 2_000 }),
      thread("busy", { status: "active" }),
      thread("child", { parentThreadId: "busy", latestAttentionAt: 2_000 }),
    ],
    new Set(),
    {},
  );
  assert.deepEqual(wanted, [
    { id: "unread", key: "2000:idle" },
    { id: "busy", key: "1000:busy" },
  ]);
});

test("the tally and the rail badge count Asking you and Replies", () => {
  const rows = buildWaiting(
    input([
      thread("q", { hasPendingInteraction: true }),
      thread("r", { latestAttentionAt: 2_000 }),
      thread("f", { latestAttentionAt: 2_000 }),
      thread("w", { status: "active" }),
    ], {
      turns: new Map([["f", [running(), done(1_500, { kind: "automation" })]]]),
    }),
  );
  const counts = tally(rows);
  assert.deepEqual(counts, { asking: 1, replies: 1, fyi: 1, working: 1 });
  assert.deepEqual(badgeFor(counts), {
    count: 2,
    tone: "warning",
    label: "Switchboard: 1 thread asking you, 1 reply",
  });
  assert.deepEqual(badgeFor({ asking: 0, replies: 3, fyi: 2, working: 1 }), {
    count: 3,
    tone: "neutral",
    label: "Switchboard: 3 replies",
  });
  assert.equal(badgeFor({ asking: 0, replies: 0, fyi: 4, working: 2 }), null);
});

test("panes that finish while unwatched are flagged, and a window you've left watches nothing", () => {
  const busy = new Map([
    ["a", thread("a", { status: "active" })],
    ["b", thread("b", { status: "active" })],
  ]);
  const idle = new Map([
    ["a", thread("a")],
    ["b", thread("b")],
  ]);
  const panes = [
    { threadId: "a", isFocused: true },
    { threadId: "b", isFocused: false },
    { threadId: null, isFocused: false },
  ];
  let step = stepPanes({}, panes, busy, true);
  assert.deepEqual(step.finished, []);
  step = stepPanes(step.memory, panes, idle, true);
  assert.deepEqual(step.finished, ["b"]);
  // The same, with the window not focused: the focused pane counts too.
  step = stepPanes(stepPanes({}, panes, busy, false).memory, panes, idle, false);
  assert.deepEqual(step.finished, ["a", "b"]);
  // Coming back to the window clears the pane you're looking at.
  step = stepPanes(step.memory, panes, idle, true);
  assert.deepEqual(step.finished, ["b"]);
});

test("the ledger reads one ask per line and skips the rest", () => {
  const asks = parseLedger(
    [
      '{"time":"09:15","ask":"ABC-123 needs an update","thread":"thr_ledger0001","via":"","how":"hub"}',
      "",
      "not json",
      '{"time":"09:47","ask":"Catch-up","thread":"answered here"}',
      '{"ask":"  "}',
    ].join("\n"),
  );
  assert.deepEqual(asks, [
    { time: "09:15", ask: "ABC-123 needs an update", threadId: "thr_ledger0001" },
    { time: "09:47", ask: "Catch-up", threadId: null },
  ]);
});

test("the ledger path is today's file under the folder, relative to the checkout", () => {
  assert.equal(ledgerFileName(new Date(2026, 10, 3, 23, 59)), "2026-11-03.jsonl");
  assert.equal(
    ledgerFolder("automation/front-desk/ledger/", "/Users/l/My Drive/ws"),
    "/Users/l/My Drive/ws/automation/front-desk/ledger",
  );
  assert.equal(ledgerFolder("/abs/ledger", null), "/abs/ledger");
  assert.equal(ledgerFolder("rel", null), null);
  assert.equal(ledgerFolder("  ", "/x"), null);
});

test("an ask's status is its thread's group, else read or archived", () => {
  const rows = new Map<string, WaitingRow>([
    ["thr_a", { id: "thr_a", group: "reply", verdict: { kind: "reply" }, parentId: null, asking: null, attentionAt: 1 }],
  ]);
  const active = new Set(["thr_a", "thr_b"]);
  assert.equal(askStatus("thr_a", rows, active), "reply");
  assert.equal(askStatus("thr_b", rows, active), "read");
  assert.equal(askStatus("thr_c", rows, active), "archived");
  assert.equal(askStatus(null, rows, active), "none");
});

test("the seen map round-trips and forgets threads no longer active", () => {
  assert.deepEqual(parseSeen('{"thr_a":5,"bad":1,"thr_b":"x"}'), { thr_a: 5 });
  assert.deepEqual(parseSeen("[1]"), {});
  assert.deepEqual(parseSeen(null), {});
  assert.deepEqual(markSeen({ thr_a: 5, thr_gone: 3 }, "thr_b", 9, new Set(["thr_a", "thr_b"])), {
    thr_a: 5,
    thr_b: 9,
  });
});

test("times since read short", () => {
  assert.equal(formatAgo(30_000), "now");
  assert.equal(formatAgo(5 * 60_000), "5m");
  assert.equal(formatAgo(125 * 60_000), "2h");
  assert.equal(formatAgo(50 * 3_600_000), "2d");
});
