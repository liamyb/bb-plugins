// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  askStatus,
  badgeFor,
  buildWaiting,
  findDesk,
  formatAgo,
  chainCheck,
  chainWanted,
  hasUnread,
  judge,
  judgedOrigins,
  ledgerFileName,
  ledgerFolder,
  markSeen,
  originOf,
  parseLedger,
  parseSeen,
  parseTurnEvents,
  relayCheck,
  sectionIdsFor,
  segmentTurns,
  stepPanes,
  tally,
  turnAt,
  turnsWanted,
  unreadTurns,
  unreadVerdict,
  type DeskFacts,
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
    { ...running(you), startedAt: 100 },
    // A hand-off's request carries when it arrived; a turn, when its first request came.
    { ...done(90, { ...fromThread("thr_a"), at: 80 }, you), startedAt: 70 },
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

test("a compact and a retry's \"Please continue.\" are maintenance, not yours", () => {
  const maintenance = { kind: "maintenance" } as const;
  // `bb thread tell --compact-first` sends the compact as the user's.
  assert.deepEqual(
    originOf({ initiator: "user", source: "tell", input: [{ type: "text", text: "/compact" }] }),
    maintenance,
  );
  assert.deepEqual(
    originOf({ initiator: "system", systemMessageSubject: null, input: [{ type: "text", text: "Please continue." }] }),
    maintenance,
  );
  // A child's notice with those words is still the child's.
  assert.deepEqual(
    originOf({
      initiator: "system",
      systemMessageSubject: { kind: "thread", threadId: "thr_kid" },
      input: [{ type: "text", text: "Please continue." }],
    }),
    { kind: "child", threadId: "thr_kid" },
  );
  assert.deepEqual(judge([maintenance], noRelay), { kind: "unknown" });
  assert.deepEqual(judge([maintenance, fromThread("thr_hub")], noRelay), {
    kind: "fyi",
    from: fromThread("thr_hub"),
  });
  // A compact before a hand-off no longer makes it a reply.
  const segments = [running(), done(300, fromThread("thr_hub")), done(200, maintenance), done(100, you)];
  assert.deepEqual(unreadTurns(segments, 150), [segments[1]]);
  assert.deepEqual(unreadVerdict(segments, 150, noRelay), { kind: "fyi", from: fromThread("thr_hub") });
  // A retry's output, unread on its own, is judged by the turn it continued.
  const retried = [running(), done(300, maintenance), done(200, you)];
  assert.deepEqual(unreadVerdict(retried, 250, noRelay), { kind: "reply" });
});

test("the turn a hand-off came from is the sender's newest turn started by then", () => {
  const compact = { kind: "maintenance" } as const;
  const segments: TurnSegment[] = [
    { ...running(you), startedAt: 500 },
    { ...done(450, compact), startedAt: 400 },
    { ...done(390, fromThread("thr_desk")), startedAt: 300 },
    { ...done(250, you), startedAt: 200 },
  ];
  // Sent at 320 but queued behind a compact: still the turn that started at 300.
  assert.equal(turnAt(segments, 420), segments[2]);
  assert.equal(turnAt(segments, 320), segments[2]);
  assert.equal(turnAt(segments, 260), segments[3]);
  assert.equal(turnAt(segments, 520), segments[0]);
  assert.equal(turnAt(segments, 100), null);
});

test("a hand-off is yours when the thread that sent it was working for you", () => {
  // You → desk (relay) → a thread the desk started → a thread it handed work to.
  const desk = (id: string) => (id === "thr_desk" ? true : id === "thr_gone" ? null : false);
  const turns: Record<string, TurnSegment[]> = {
    // Spawned by the desk: bb records its first turn as yours.
    thr_spawned: [running(), { ...done(200, you), startedAt: 100 }],
    // Asked by the desk, which counts too.
    thr_routed: [running(), { ...done(200, { ...fromThread("thr_desk"), at: 90 }), startedAt: 90 }],
    // A hub writing up an automation's run: not for you.
    thr_hub: [running(), { ...done(200, { kind: "automation" }), startedAt: 100 }],
    // Handed on by the desk's thread, three threads from you.
    thr_second: [running(), { ...done(300, { ...fromThread("thr_spawned"), at: 150 }), startedAt: 160 }],
    thr_third: [running(), { ...done(400, { ...fromThread("thr_second"), at: 250 }), startedAt: 260 }],
    thr_fourth: [running(), { ...done(500, { ...fromThread("thr_third"), at: 350 }), startedAt: 360 }],
    thr_loop: [running(), { ...done(200, { ...fromThread("thr_loop"), at: 120 }), startedAt: 110 }],
  };
  const check = chainCheck(desk, (id) => turns[id]);
  assert.equal(check("thr_desk"), true);
  assert.equal(check("thr_spawned", 150), true);
  assert.equal(check("thr_routed", 150), true);
  assert.equal(check("thr_hub", 150), false);
  // Up to three threads back, and no further.
  assert.equal(check("thr_second", 250), true);
  assert.equal(check("thr_third", 350), true);
  assert.equal(check("thr_fourth", 450), false);
  // Not read yet, gone, or sent before its turns reach back: unknown.
  assert.equal(check("thr_unread", 150), null);
  assert.equal(check("thr_gone", 150), null);
  assert.equal(check("thr_spawned", 50), null);
  // No time to match it on (an old test fixture): its section decides.
  assert.equal(check("thr_spawned"), false);
  assert.equal(check("thr_loop", 150), false);
  // In a row: an unread hand-off from the desk's thread is a reply.
  assert.deepEqual(unreadVerdict([running(), done(300, { ...fromThread("thr_spawned"), at: 150 })], 200, check), {
    kind: "reply",
  });
});

test("the chain asks for each sender's turns, then the next sender's", () => {
  const desk = (id: string) => id === "thr_desk";
  const handOff = { ...fromThread("thr_spawned"), at: 150 };
  assert.deepEqual([...chainWanted([handOff, you], desk, () => undefined)], [["thr_spawned", 150]]);
  // Once read, its own sender is next, at the time it reached the desk's thread.
  const turns: Record<string, TurnSegment[]> = {
    thr_spawned: [running(), { ...done(200, { ...fromThread("thr_hub"), at: 120 }), startedAt: 120 }],
  };
  assert.deepEqual([...chainWanted([handOff], desk, (id) => turns[id])], [["thr_hub", 120]]);
  // The desk itself needs nothing read.
  assert.deepEqual([...chainWanted([{ ...fromThread("thr_desk"), at: 10 }], desk, () => undefined)], []);
  // What a row is judged on: the running turn while busy, else what's unread.
  const segments = [running(handOff), done(300, you), done(100, fromThread("thr_hub"))];
  assert.deepEqual(judgedOrigins(thread("a", { status: "active" }), segments), [handOff]);
  assert.deepEqual(judgedOrigins(thread("a", { lastReadAt: 200 }), segments), [you]);
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

const SECTIONS = [
  { id: "sec_desk", name: "Front desk" },
  { id: "sec_tools", name: "bb tooling" },
];

function desk(id: string, facts: Partial<DeskFacts> = {}): DeskFacts {
  return {
    id,
    parentThreadId: null,
    sectionId: "sec_desk",
    isHidden: false,
    isArchived: false,
    isPinned: false,
    pinnedAt: null,
    createdAt: 1,
    ...facts,
  };
}

test("a section setting matches names or ids, and keeps an unknown id", () => {
  assert.deepEqual([...sectionIdsFor("front desk", SECTIONS)], ["sec_desk"]);
  assert.deepEqual([...sectionIdsFor(" SEC_TOOLS , Front desk", SECTIONS)].sort(), ["sec_desk", "sec_tools"]);
  assert.deepEqual([...sectionIdsFor("sec_gone", SECTIONS)], ["sec_gone"]);
  assert.equal(sectionIdsFor("", SECTIONS).size, 0);
});

test("today's desk is the pinned thread in the desk section", () => {
  const threads = [
    desk("thr_old", { createdAt: 50 }),
    desk("thr_today", { isPinned: true, pinnedAt: 10, createdAt: 10 }),
    desk("thr_tool", { sectionId: "sec_tools", isPinned: true, pinnedAt: 99 }),
  ];
  assert.equal(findDesk(threads, SECTIONS, "Front desk"), "thr_today");
});

test("with two pins the newest pin wins, and with none the newest thread", () => {
  assert.equal(
    findDesk(
      [desk("thr_a", { isPinned: true, pinnedAt: 5 }), desk("thr_b", { isPinned: true, pinnedAt: 9 })],
      SECTIONS,
      "Front desk",
    ),
    "thr_b",
  );
  assert.equal(
    findDesk([desk("thr_a", { createdAt: 5 }), desk("thr_b", { createdAt: 3 })], SECTIONS, "Front desk"),
    "thr_a",
  );
});

test("children, hidden and archived threads are never the desk", () => {
  const threads = [
    desk("thr_child", { parentThreadId: "thr_x", isPinned: true, pinnedAt: 9 }),
    desk("thr_hidden", { isHidden: true, isPinned: true, pinnedAt: 8 }),
    desk("thr_archived", { isArchived: true, isPinned: true, pinnedAt: 7 }),
  ];
  assert.equal(findDesk(threads, SECTIONS, "Front desk"), null);
  assert.equal(findDesk([...threads, desk("thr_ok")], SECTIONS, "Front desk"), "thr_ok");
});

test("no desk when the setting is empty or the section is empty", () => {
  assert.equal(findDesk([desk("thr_a")], SECTIONS, ""), null);
  assert.equal(findDesk([desk("thr_a")], SECTIONS, "bb tooling"), null);
});
