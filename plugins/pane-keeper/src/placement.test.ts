// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_MEMORY,
  PANE_LIMIT,
  parseMemory,
  pickPaneToReplace,
  planOpen,
  recordFocus,
  type FocusMemory,
  type Pane,
  type PaneFacts,
} from "./placement.ts";

function panes(count: number, focused: number): Pane[] {
  return Array.from({ length: count }, (_, index) => ({
    paneId: `pane-${index + 1}`,
    threadId: `thr_${index + 1}`,
    isFocused: index + 1 === focused,
  }));
}

const calm: PaneFacts = { marked: false, busy: false };
const noPick = () => {
  throw new Error("pick should only run at the limit");
};

test("compact layout and a single pane are left to bb", () => {
  const input = { alreadyOpen: false, mode: "replace-oldest", pick: noPick } as const;
  assert.deepEqual(planOpen({ ...input, compact: true, panes: panes(3, 1) }), {
    kind: "default",
  });
  assert.deepEqual(planOpen({ ...input, compact: false, panes: null }), {
    kind: "default",
  });
  assert.deepEqual(planOpen({ ...input, compact: false, panes: panes(1, 1) }), {
    kind: "default",
  });
});

test("below the limit it uses bb's split-open", () => {
  const plan = planOpen({
    compact: false,
    panes: panes(PANE_LIMIT - 1, 2),
    alreadyOpen: false,
    mode: "replace-oldest",
    pick: noPick,
  });
  assert.deepEqual(plan, { kind: "split" });
});

test("at the limit, something already open is just focused", () => {
  const plan = planOpen({
    compact: false,
    panes: panes(PANE_LIMIT, 2),
    alreadyOpen: true,
    mode: "notice",
    pick: noPick,
  });
  assert.deepEqual(plan, { kind: "split" });
});

test("at the limit it swaps out the chosen pane, or blocks", () => {
  const layout = panes(PANE_LIMIT, 2);
  const victim = { ...layout[4]!, threadId: "thr_5" };
  assert.deepEqual(
    planOpen({
      compact: false,
      panes: layout,
      alreadyOpen: false,
      mode: "replace-oldest",
      pick: () => victim,
    }),
    { kind: "replace", pane: victim },
  );
  assert.deepEqual(
    planOpen({
      compact: false,
      panes: layout,
      alreadyOpen: false,
      mode: "replace-oldest",
      pick: () => null,
    }),
    { kind: "blocked" },
  );
  assert.deepEqual(
    planOpen({
      compact: false,
      panes: layout,
      alreadyOpen: false,
      mode: "notice",
      pick: noPick,
    }),
    { kind: "blocked" },
  );
});

test("recordFocus stamps a pane when it gains focus, not on every update", () => {
  let memory = recordFocus(EMPTY_MEMORY, panes(3, 1), 100);
  assert.deepEqual(memory, { at: { "pane-1": 100 }, focused: "pane-1" });
  const same = recordFocus(memory, panes(3, 1), 200);
  assert.equal(same, memory, "no change, same object");
  memory = recordFocus(memory, panes(3, 3), 300);
  assert.deepEqual(memory, {
    at: { "pane-1": 100, "pane-3": 300 },
    focused: "pane-3",
  });
});

test("recordFocus forgets closed panes and waits while nothing is split", () => {
  const memory: FocusMemory = {
    at: { "pane-1": 100, "pane-4": 200 },
    focused: "pane-4",
  };
  assert.equal(recordFocus(memory, null, 300), memory);
  assert.deepEqual(recordFocus(memory, panes(3, 1), 300), {
    at: { "pane-1": 300 },
    focused: "pane-1",
  });
});

test("the least recently focused pane goes first, never the focused one", () => {
  const layout = panes(PANE_LIMIT, 8);
  const memory: FocusMemory = {
    at: {
      "pane-1": 500,
      "pane-2": 100,
      "pane-3": 900,
      "pane-8": 1000,
    },
    focused: "pane-8",
  };
  // Panes 4 to 7 were never focused this session, so they count as oldest,
  // and the leftmost of them wins.
  assert.equal(pickPaneToReplace(layout, memory, () => calm)?.paneId, "pane-4");
  const allStamped: FocusMemory = {
    at: Object.fromEntries(layout.map((pane, index) => [pane.paneId, 1000 - index])),
    focused: "pane-8",
  };
  // pane-8 has the oldest stamp here, but it's the focused pane.
  assert.equal(pickPaneToReplace(layout, allStamped, () => calm)?.paneId, "pane-7");
});

test("flagged panes are skipped, busy ones only go last", () => {
  const layout = panes(4, 1);
  const memory: FocusMemory = {
    at: { "pane-1": 400, "pane-2": 100, "pane-3": 200, "pane-4": 300 },
    focused: "pane-1",
  };
  const facts = (pane: Pane): PaneFacts => ({
    marked: pane.paneId === "pane-2",
    busy: pane.paneId === "pane-3",
  });
  assert.equal(pickPaneToReplace(layout, memory, facts)?.paneId, "pane-4");
  const allBusy = (pane: Pane): PaneFacts => ({
    marked: pane.paneId === "pane-2",
    busy: true,
  });
  assert.equal(pickPaneToReplace(layout, memory, allBusy)?.paneId, "pane-3");
});

test("panes without a thread are never chosen, and nothing left means null", () => {
  const layout: Pane[] = [
    { paneId: "pane-1", threadId: "thr_1", isFocused: true },
    { paneId: "pane-2", threadId: null, isFocused: false },
    { paneId: "pane-3", threadId: "thr_3", isFocused: false },
  ];
  const marked = (pane: Pane): PaneFacts => ({
    marked: pane.paneId === "pane-3",
    busy: false,
  });
  assert.equal(pickPaneToReplace(layout, EMPTY_MEMORY, () => calm)?.paneId, "pane-3");
  assert.equal(pickPaneToReplace(layout, EMPTY_MEMORY, marked), null);
});

test("parseMemory survives junk", () => {
  assert.deepEqual(parseMemory(null), EMPTY_MEMORY);
  assert.deepEqual(parseMemory("not json"), EMPTY_MEMORY);
  assert.deepEqual(parseMemory("[1,2]"), { at: {}, focused: null });
  assert.deepEqual(
    parseMemory(JSON.stringify({ at: { "pane-1": 5, "pane-2": "x" }, focused: 3 })),
    { at: { "pane-1": 5 }, focused: null },
  );
  assert.deepEqual(
    parseMemory(JSON.stringify({ at: { "pane-1": 5 }, focused: "pane-1" })),
    { at: { "pane-1": 5 }, focused: "pane-1" },
  );
});
