// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildList,
  flatten,
  parseMemory,
  serializeMemory,
  stateOf,
  stepMemory,
  type ListOptions,
  type MemoryMap,
  type Row,
  type ThreadFacts,
} from "./current.ts";

function thread(id: string, extra: Partial<ThreadFacts> = {}): ThreadFacts {
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
    ...extra,
  };
}

const panes: ListOptions = { showChildren: true, showAll: false, selectedId: null };

function ids(rows: readonly Row[]): string[] {
  return rows.map((row) => row.id);
}

function shape(rows: readonly Row[]): string[] {
  return flatten(rows).map(({ row, depth }) => `${"  ".repeat(depth)}${row.id}:${row.state}`);
}

test("the state word follows Pane Attention's rules", () => {
  assert.equal(stateOf(thread("a", { hasPendingInteraction: true }), null), "needs-you");
  assert.equal(stateOf(thread("a", { indicator: "waiting-for-input" }), null), "needs-you");
  assert.equal(stateOf(thread("a", { indicator: "queued-failed" }), null), "needs-you");
  assert.equal(stateOf(thread("a", { status: "error" }), null), "needs-you");
  assert.equal(
    stateOf(thread("a", { status: "active", hasPendingInteraction: true }), null),
    "needs-you",
  );
  assert.equal(stateOf(thread("a", { status: "active" }), null), "working");
  assert.equal(stateOf(thread("a", { status: "starting" }), null), "working");
  assert.equal(stateOf(thread("a", { runtimeStatus: "provisioning" }), null), "working");
  assert.equal(stateOf(thread("a", { isUnread: true }), null), "done");
  assert.equal(stateOf(thread("a"), "done"), "done");
  assert.equal(stateOf(thread("a", { status: "active" }), "done"), "working");
  assert.equal(stateOf(thread("a"), null), "idle");
});

test("only threads open in a pane are listed, never hidden or archived ones", () => {
  const threads = [
    thread("a"),
    thread("b"),
    thread("c"),
    thread("hidden", { isHidden: true }),
    thread("gone", { isArchived: true }),
  ];
  const { rows } = buildList(threads, new Set(["a", "c", "hidden", "gone", "missing"]), panes, {});
  assert.deepEqual(ids(rows), ["a", "c"]);
});

test("children of an open thread nest under it, and grandchildren under them", () => {
  const threads = [
    thread("parent"),
    thread("child", { parentThreadId: "parent", status: "active" }),
    thread("grandchild", { parentThreadId: "child" }),
    thread("orphan", { parentThreadId: "closed" }),
    thread("closed"),
  ];
  const { rows } = buildList(threads, new Set(["parent"]), panes, {});
  assert.deepEqual(shape(rows), [
    "parent:idle",
    "  child:working",
    "    grandchild:idle",
  ]);
});

test("with children off, only open threads show, and a child open in its own pane is top level", () => {
  const threads = [thread("parent"), thread("child", { parentThreadId: "parent" })];
  const off = buildList(threads, new Set(["parent"]), { ...panes, showChildren: false }, {});
  assert.deepEqual(ids(off.rows), ["parent"]);
  const own = buildList(threads, new Set(["child"]), { ...panes, showChildren: false }, {});
  assert.deepEqual(ids(own.rows), ["child"]);
});

test("a child that's open in a pane as well as its parent shows once, nested", () => {
  const threads = [thread("parent"), thread("child", { parentThreadId: "parent" })];
  const { rows } = buildList(threads, new Set(["parent", "child"]), panes, {});
  assert.deepEqual(shape(rows), ["parent:idle", "  child:idle"]);
});

test("show all lists every active thread, nested where the parent is present", () => {
  const threads = [
    thread("a"),
    thread("b", { parentThreadId: "a" }),
    thread("c"),
    thread("hidden", { isHidden: true }),
  ];
  const { rows } = buildList(threads, new Set(), { ...panes, showAll: true }, {});
  assert.deepEqual(shape(rows), ["a:idle", "  b:idle", "c:idle"]);
});

test("order is needs you, working, done, idle, then most recent attention first", () => {
  const threads = [
    thread("idle_old", { latestAttentionAt: 100 }),
    thread("done", { isUnread: true, latestAttentionAt: 50 }),
    thread("working", { status: "active", latestAttentionAt: 10 }),
    thread("idle_new", { latestAttentionAt: 900 }),
    thread("needs", { hasPendingInteraction: true, latestAttentionAt: 1 }),
    thread("idle_no_attention", { latestAttentionAt: null, updatedAt: 500 }),
  ];
  const open = new Set(threads.map((item) => item.id));
  const { rows } = buildList(threads, open, panes, {});
  assert.deepEqual(ids(rows), [
    "needs",
    "working",
    "done",
    "idle_new",
    "idle_no_attention",
    "idle_old",
  ]);
});

test("children sort by the same rule under their parent", () => {
  const threads = [
    thread("parent"),
    thread("quiet", { parentThreadId: "parent", latestAttentionAt: 900 }),
    thread("busy", { parentThreadId: "parent", status: "active", latestAttentionAt: 1 }),
  ];
  const { rows } = buildList(threads, new Set(["parent"]), panes, {});
  assert.deepEqual(ids(rows[0]!.children), ["busy", "quiet"]);
});

test("a thread that stops working while not in the slide is Done until opened or busy again", () => {
  const open = new Set(["a"]);
  let memory: MemoryMap = {};
  // First sight, working: never flagged.
  let result = buildList([thread("a", { status: "active" })], open, panes, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "working");
  // Goes idle: Done.
  result = buildList([thread("a")], open, panes, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "done");
  // Still idle on the next snapshot: still Done.
  result = buildList([thread("a")], open, panes, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "done");
  // Opened in the slide: cleared.
  result = buildList([thread("a")], open, { ...panes, selectedId: "a" }, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "idle");
  // Closed again, still idle: stays clear.
  result = buildList([thread("a")], open, panes, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "idle");
  // Works and finishes again: Done again.
  result = buildList([thread("a", { status: "active" })], open, panes, memory);
  memory = result.memory;
  result = buildList([thread("a")], open, panes, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "done");
  // Starts work: cleared.
  result = buildList([thread("a", { status: "active" })], open, panes, memory);
  assert.equal(result.rows[0]!.state, "working");
  assert.equal(result.memory.a!.flag, null);
});

test("a first sighting is never Done, an attention bump is, and gone threads are forgotten", () => {
  const first = stepMemory({}, [thread("a")], null);
  assert.deepEqual(first, { a: { busy: false, attentionAt: 1_000, flag: null } });
  const bumped = stepMemory(first, [thread("a", { latestAttentionAt: 2_000 })], null);
  assert.equal(bumped.a!.flag, "done");
  const forgotten = stepMemory(bumped, [thread("b")], null);
  assert.deepEqual(Object.keys(forgotten), ["b"]);
  // The one in the slide never flags, even on a bump.
  const selected = stepMemory(first, [thread("a", { latestAttentionAt: 2_000 })], "a");
  assert.equal(selected.a!.flag, null);
});

test("saved memory round-trips and malformed entries are dropped", () => {
  const memory: MemoryMap = {
    a: { busy: true, attentionAt: 5, flag: null },
    b: { busy: false, attentionAt: null, flag: "done" },
  };
  assert.deepEqual(parseMemory(serializeMemory(memory)), memory);
  assert.deepEqual(parseMemory(null), {});
  assert.deepEqual(parseMemory("not json"), {});
  assert.deepEqual(parseMemory("[1,2]"), {});
  assert.deepEqual(
    parseMemory(
      JSON.stringify({
        ok: { busy: false, attentionAt: 1, flag: "done" },
        badBusy: { busy: "yes", attentionAt: 1, flag: null },
        badFlag: { busy: false, attentionAt: 1, flag: "error" },
        badAttention: { busy: false, attentionAt: "1", flag: null },
        notObject: 4,
      }),
    ),
    { ok: { busy: false, attentionAt: 1, flag: "done" } },
  );
});

test("flatten walks the tree in reading order with depths", () => {
  const rows: Row[] = [
    { id: "a", state: "idle", children: [{ id: "b", state: "working", children: [] }] },
    { id: "c", state: "done", children: [] },
  ];
  assert.deepEqual(
    flatten(rows).map(({ row, depth }) => [row.id, depth]),
    [
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ],
  );
});
