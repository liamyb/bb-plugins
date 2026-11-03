// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampTtlSeconds,
  heartbeatMs,
  holdDisplaced,
  liveReports,
  openThreadIds,
  paneOwner,
  parseHeld,
  parseOpenRequest,
  parsePaneRefs,
  parseStoredReport,
  parseSummary,
  sameSummary,
  summarize,
  type PaneRef,
  type StoredReport,
} from "./panes.ts";

function pane(threadId: string | null, isFocused = false): PaneRef {
  return { paneId: `pane_${threadId ?? "blank"}`, threadId, isFocused };
}

function report(
  windowId: string,
  panes: PaneRef[] | null,
  extra: Partial<StoredReport> = {},
): StoredReport {
  return {
    windowId,
    panes,
    extraThreadIds: [],
    compact: false,
    focusedAt: null,
    finishedThreadIds: [],
    reportedAt: 1_000,
    expiresAt: 2_000,
    ...extra,
  };
}

test("the lifetime setting stays inside its bounds and defaults when unset", () => {
  assert.equal(clampTtlSeconds(undefined), 120);
  assert.equal(clampTtlSeconds("90"), 120);
  assert.equal(clampTtlSeconds(Number.NaN), 120);
  assert.equal(clampTtlSeconds(3), 10);
  assert.equal(clampTtlSeconds(1_000), 600);
  assert.equal(clampTtlSeconds(45.4), 45);
});

test("the heartbeat is a quarter of the lifetime, between 5 and 60 seconds", () => {
  assert.equal(heartbeatMs(120), 30_000);
  assert.equal(heartbeatMs(10), 5_000);
  assert.equal(heartbeatMs(600), 60_000);
});

test("a stored report parses, and a malformed one doesn't", () => {
  const good = report("win_a", [pane("thr_1", true), pane(null)]);
  assert.deepEqual(parseStoredReport(good), good);
  const single = report("win_b", null, { extraThreadIds: ["thr_9"], compact: true });
  assert.deepEqual(parseStoredReport(single), single);
  assert.equal(parseStoredReport(null), null);
  assert.equal(parseStoredReport("win_a"), null);
  assert.equal(parseStoredReport({ ...good, windowId: "" }), null);
  assert.equal(parseStoredReport({ ...good, panes: "three" }), null);
  assert.equal(parseStoredReport({ ...good, panes: [{ paneId: "p", threadId: null }] }), null);
  assert.equal(parseStoredReport({ ...good, compact: "yes" }), null);
  assert.equal(parseStoredReport({ ...good, extraThreadIds: "thr_9" }), null);
  assert.equal(parseStoredReport({ ...good, extraThreadIds: [4] }), null);
  assert.equal(parseStoredReport({ ...good, focusedAt: "now" }), null);
  assert.deepEqual(parseStoredReport({ ...good, focusedAt: 5 }), { ...good, focusedAt: 5 });
  assert.equal(parseStoredReport({ ...good, expiresAt: Number.NaN }), null);
  assert.equal(parseStoredReport({ ...good, finishedThreadIds: [""] }), null);
  // A report stored before the Waiting view existed has no finished list.
  const { finishedThreadIds: _, ...older } = good;
  assert.deepEqual(parseStoredReport(older), good);
});

test("saved panes parse back, and anything else is null", () => {
  const panes = [pane("thr_1"), pane(null, true)];
  assert.deepEqual(parsePaneRefs(panes), panes);
  assert.equal(parsePaneRefs(null), null);
  assert.equal(parsePaneRefs([{ paneId: "p" }]), null);
  assert.equal(parsePaneRefs("[]"), null);
});

test("live reports drop the expired and the malformed, most recent first", () => {
  const live = liveReports(
    [
      report("win_old", null, { reportedAt: 100, expiresAt: 1_500 }),
      report("win_gone", null, { reportedAt: 50, expiresAt: 999 }),
      { not: "a report" },
      undefined,
      report("win_new", null, { reportedAt: 900, expiresAt: 1_500 }),
    ],
    1_000,
  );
  assert.deepEqual(
    live.map((item) => item.windowId),
    ["win_new", "win_old"],
  );
});

test("open threads are the panes' threads and each window's extras, each once", () => {
  const ids = openThreadIds([
    report("win_a", [pane("thr_b"), pane(null), pane("thr_a")], { extraThreadIds: ["thr_a"] }),
    report("win_b", null, { extraThreadIds: ["thr_c"] }),
    report("win_c", null, { extraThreadIds: ["thr_a"] }),
    report("win_d", null),
    // A plugin page took thr_x's pane: the window still reports it.
    report("win_e", [pane(null), pane("thr_d")], { extraThreadIds: ["thr_x"] }),
  ]);
  assert.deepEqual(ids, ["thr_a", "thr_b", "thr_c", "thr_d", "thr_x"]);
});

test("a pane a plugin page takes over is held until it shows a thread again or closes", () => {
  const empty = new Map<string, string>();
  const before = [pane("thr_q"), pane("thr_a"), pane("thr_c", true)];
  // The rail icon replaces the focused pane's thread with the page: hold it.
  const taken = [pane("thr_q"), pane("thr_a"), { ...pane(null, true), paneId: "pane_thr_c" }];
  const held = holdDisplaced(empty, before, taken, true);
  assert.deepEqual([...held], [["pane_thr_c", "thr_c"]]);
  // Nothing changes on the next snapshot: the same map comes back.
  assert.equal(holdDisplaced(held, taken, taken, true), held);
  // New thread in that pane instead (not a plugin page): nothing is held.
  assert.equal(holdDisplaced(empty, before, taken, false).size, 0);
  // Back to the thread: released.
  assert.equal(holdDisplaced(held, taken, before, false).size, 0);
  // The pane closes: released. Another pane closing leaves the hold alone.
  assert.equal(holdDisplaced(held, taken, [pane("thr_q"), pane("thr_a")], true).size, 0);
  assert.deepEqual(
    [...holdDisplaced(held, taken, [pane("thr_a"), taken[2]!], true)],
    [["pane_thr_c", "thr_c"]],
  );
  // A null layout (no split, or not loaded yet after a reload) leaves the map alone.
  assert.equal(holdDisplaced(held, taken, null, true), held);
  assert.equal(holdDisplaced(empty, null, null, true), empty);
  // ...and the next real layout still releases as usual.
  assert.equal(holdDisplaced(held, null, before, false).size, 0);
});

test("a saved held map parses and junk is dropped", () => {
  assert.deepEqual(
    [...parseHeld({ pane_1: "thr_a", pane_2: 4, "": "thr_b", pane_3: "" })],
    [["pane_1", "thr_a"]],
  );
  assert.equal(parseHeld(null).size, 0);
  assert.equal(parseHeld(["thr_a"]).size, 0);
});

test("the pane owner is never compact, prefers a split, then the window used last, then the most recent report", () => {
  // Two split windows: the one used most recently wins, however recent the other's heartbeat.
  assert.equal(
    paneOwner([
      report("win_background", [pane("thr_1")], { reportedAt: 9_000, focusedAt: 100 }),
      report("win_used", [pane("thr_2")], { reportedAt: 1_000, focusedAt: 500 }),
      report("win_never_focused", [pane("thr_3")], { reportedAt: 9_500 }),
    ]),
    "win_used",
  );
  assert.equal(paneOwner([]), null);
  assert.equal(paneOwner([report("win_small", null, { compact: true })]), null);
  assert.equal(
    paneOwner([
      report("win_small", null, { compact: true, reportedAt: 5_000 }),
      report("win_single", null, { reportedAt: 3_000 }),
      report("win_split", [pane("thr_1")], { reportedAt: 1_000 }),
    ]),
    "win_split",
  );
  assert.equal(
    paneOwner([
      report("win_split_old", [pane("thr_1")], { reportedAt: 1_000 }),
      report("win_split_new", [pane("thr_2")], { reportedAt: 2_000 }),
    ]),
    "win_split_new",
  );
  assert.equal(
    paneOwner([
      report("win_one", null, { reportedAt: 1_000 }),
      report("win_two", null, { reportedAt: 2_000 }),
    ]),
    "win_two",
  );
});

test("a summary round-trips the wire and junk is refused", () => {
  const summary = summarize([
    report("win_a", [pane("thr_2"), pane("thr_1")], { finishedThreadIds: ["thr_2"] }),
    report("win_b", null, { compact: true, extraThreadIds: ["thr_3"], finishedThreadIds: ["thr_2"] }),
  ]);
  assert.deepEqual(summary, {
    openThreadIds: ["thr_1", "thr_2", "thr_3"],
    ownerWindowId: "win_a",
    windows: 2,
    finishedThreadIds: ["thr_2"],
  });
  assert.deepEqual(parseSummary(JSON.parse(JSON.stringify(summary))), summary);
  assert.equal(sameSummary(summary, { ...summary, openThreadIds: [...summary.openThreadIds] }), true);
  assert.equal(sameSummary(summary, { ...summary, windows: 3 }), false);
  assert.equal(sameSummary(summary, { ...summary, openThreadIds: ["thr_1"] }), false);
  assert.equal(sameSummary(summary, { ...summary, finishedThreadIds: [] }), false);
  // A summary from a server that predates the Waiting view.
  assert.deepEqual(parseSummary({ openThreadIds: [], ownerWindowId: null, windows: 0 }), {
    openThreadIds: [],
    ownerWindowId: null,
    windows: 0,
    finishedThreadIds: [],
  });
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary({ openThreadIds: "thr_1", ownerWindowId: null, windows: 1 }), null);
  assert.equal(parseSummary({ openThreadIds: [], ownerWindowId: 7, windows: 1 }), null);
  assert.equal(parseSummary({ openThreadIds: [], ownerWindowId: null }), null);
});

test("an open request needs a window and a thread", () => {
  assert.deepEqual(parseOpenRequest({ windowId: "win_a", threadId: "thr_1" }), {
    windowId: "win_a",
    threadId: "thr_1",
  });
  assert.equal(parseOpenRequest({ windowId: "win_a" }), null);
  assert.equal(parseOpenRequest({ windowId: "", threadId: "thr_1" }), null);
  assert.equal(parseOpenRequest("open"), null);
});
