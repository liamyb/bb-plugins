// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildList,
  flatten,
  formatElapsed,
  nextRuns,
  parseMemory,
  parseWorkflowRuns,
  runProgress,
  serializeMemory,
  stateOf,
  stepMemory,
  threadsWithWorkflows,
  type ListOptions,
  type MemoryMap,
  type Row,
  type ThreadFacts,
  type WorkflowRun,
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

const nothing = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 };

test("background agents, commands and workflows count as working after the turn ends", () => {
  assert.equal(stateOf(thread("a", { activity: { ...nothing, workflows: 2 } }), null), "working");
  assert.equal(
    stateOf(thread("a", { activity: { ...nothing, backgroundAgents: 1 } }), null),
    "working",
  );
  assert.equal(
    stateOf(thread("a", { activity: { ...nothing, backgroundCommands: 1 } }), null),
    "working",
  );
  assert.equal(stateOf(thread("a", { activity: nothing }), null), "idle");
  // Still waiting on the user comes first.
  assert.equal(
    stateOf(thread("a", { hasPendingInteraction: true, activity: { ...nothing, workflows: 1 } }), null),
    "needs-you",
  );
});

test("a turn that ends with workflows still running stays Working, then is Done when they finish", () => {
  const open = new Set(["a"]);
  let memory: MemoryMap = {};
  let result = buildList([thread("a", { status: "active" })], open, panes, memory);
  memory = result.memory;
  // The turn ends, two workflows still running: not Done yet.
  result = buildList([thread("a", { activity: { ...nothing, workflows: 2 } })], open, panes, memory);
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "working");
  assert.equal(memory.a!.flag, null);
  // Opened and left in the slide while they run: still Working, not Idle.
  result = buildList(
    [thread("a", { activity: { ...nothing, workflows: 2 } })],
    open,
    { ...panes, selectedId: "a" },
    memory,
  );
  memory = result.memory;
  assert.equal(result.rows[0]!.state, "working");
  // Back out of the slide, and the workflows finish: Done.
  result = buildList([thread("a", { activity: nothing })], open, panes, memory);
  assert.equal(result.rows[0]!.state, "done");
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

// An `activeWorkflows` entry modelled on a live `threads.timeline` response
// (bb 0.46.1, 23 Oct 2026), with made-up times and agents.
function workflowEntry(extra: Record<string, unknown> = {}, states: string[] = []) {
  return {
    id: "da98121b67-i1743",
    kind: "work",
    workKind: "workflow",
    status: "pending",
    taskType: "local_workflow",
    workflowName: "verify-deliverable",
    description: "Extract the checkable claims from a deliverable",
    taskStatus: "running",
    startedAt: 1_000_000,
    presentation: { label: { pending: "Running workflow", completed: "Workflow finished" }, title: "verify-deliverable" },
    workflow: {
      agents: states.map((state, index) => ({ index: index + 1, label: `agent#${index + 1}`, state })),
      phases: [{ index: 1, title: "Extract" }],
    },
    ...extra,
  };
}

test("a timeline's active workflows become runs, counting settled and failed agents", () => {
  const runs = parseWorkflowRuns({
    rows: [],
    activeWorkflows: [
      workflowEntry({}, ["done", "done", "failed", "skipped", "running", "queued"]),
    ],
  });
  assert.deepEqual(runs, [
    {
      id: "da98121b67-i1743",
      name: "verify-deliverable",
      settled: 4,
      failed: 1,
      total: 6,
      startedAt: 1_000_000,
      phase: null,
    },
  ]);
});

test("runs fall back on the presentation title, skip ended and malformed entries, oldest first", () => {
  const runs = parseWorkflowRuns({
    activeWorkflows: [
      workflowEntry({ id: "late", startedAt: 9, workflowName: null }),
      workflowEntry({ id: "early", startedAt: 1, workflowName: "", presentation: undefined }),
      workflowEntry({ id: "ended", taskStatus: "completed" }),
      workflowEntry({ id: "killed", taskStatus: "killed" }),
      workflowEntry({ id: 4 }),
      workflowEntry({ id: "no-start", startedAt: "soon" }),
      workflowEntry({ id: "no-detail", startedAt: 5, workflow: null }),
      "junk",
      null,
    ],
  });
  assert.deepEqual(
    runs.map((run) => [run.id, run.name, run.total]),
    [
      ["early", "Workflow", 0],
      ["no-detail", "verify-deliverable", 0],
      ["late", "verify-deliverable", 0],
    ],
  );
  assert.deepEqual(parseWorkflowRuns(null), []);
  assert.deepEqual(parseWorkflowRuns({ activeWorkflows: "none" }), []);
  assert.deepEqual(parseWorkflowRuns({}), []);
});

const run = (extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r",
  name: "verify-deliverable",
  settled: 11,
  failed: 0,
  total: 13,
  startedAt: 0,
  phase: null,
  ...extra,
});

test("a run line reads agents settled, any failures, then time since it started", () => {
  assert.equal(runProgress(run(), 6 * 60_000 + 20_000), "11/13 agents · 6m");
  assert.equal(runProgress(run({ failed: 1 }), 40_000), "11/13 agents, 1 failed · 40s");
  assert.equal(runProgress(run({ settled: 0, total: 1 }), 0), "0/1 agent · 0s");
  assert.equal(runProgress(run({ total: 0, settled: 0 }), 90_000), "1m");
  // A clock a little behind the server's never shows a negative time.
  assert.equal(runProgress(run({ startedAt: 5_000 }), 0), "11/13 agents · 0s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60 * 60_000), "1h 0m");
  assert.equal(formatElapsed(65 * 60_000 + 59_000), "1h 5m");
});

// verify-deliverable's five declared phases, as the live payload lists them.
const declared = ["Extract", "Compute", "Refute", "Escalate", "Report"].map((title, i) => ({
  index: i + 1,
  title,
}));

function phasedRun(agents: { state: string; phaseIndex?: number }[], phases: unknown = declared) {
  const [parsed] = parseWorkflowRuns({
    activeWorkflows: [workflowEntry({ startedAt: 0, workflow: { agents, phases } })],
  });
  return parsed!;
}

test("a run's phase is the earliest declared one with an agent queued or running", () => {
  // A pipeline with Refute and Escalate overlapping: Refute is where it is.
  const overlapping = phasedRun([
    { state: "done", phaseIndex: 1 },
    { state: "running", phaseIndex: 4 },
    { state: "queued", phaseIndex: 3 },
    { state: "done", phaseIndex: 3 },
  ]);
  assert.deepEqual(overlapping.phase, { title: "Refute", position: 3, of: 5 });
  assert.equal(runProgress(overlapping, 6 * 60_000), "Refute · 3 of 5 · 6m");
});

test("between phases, with nothing queued or running, it's the latest phase any agent reached", () => {
  const between = phasedRun([
    { state: "done", phaseIndex: 1 },
    { state: "failed", phaseIndex: 3 },
    { state: "done", phaseIndex: 3 },
  ]);
  assert.deepEqual(between.phase, { title: "Refute", position: 3, of: 5 });
  assert.equal(runProgress(between, 40_000), "Refute · 3 of 5, 1 failed · 40s");
});

test("the position counts declared phases in index order, and untitled phases read as a number", () => {
  const sparse = phasedRun(
    [{ state: "running", phaseIndex: 20 }],
    [
      { index: 20, title: "" },
      { index: 10, title: "Read" },
      { index: "x", title: "Junk" },
    ],
  );
  assert.deepEqual(sparse.phase, { title: null, position: 2, of: 2 });
  assert.equal(runProgress(sparse, 0), "phase 2 of 2 · 0s");
});

test("no declared phases, or no agent in one, keeps the agent count", () => {
  const agents = [
    { state: "done", phaseIndex: 1 },
    { state: "running", phaseIndex: 2 },
  ];
  const undeclared = phasedRun(agents, []);
  assert.equal(undeclared.phase, null);
  assert.equal(runProgress(undeclared, 40_000), "1/2 agents · 40s");
  // Agents outside the declared phases, or with no phase at all.
  const outside = phasedRun([{ state: "running", phaseIndex: 9 }, { state: "done" }]);
  assert.equal(outside.phase, null);
  assert.equal(runProgress(outside, 40_000), "1/2 agents · 40s");
  // Phases declared but no agent yet.
  assert.equal(phasedRun([]).phase, null);
  assert.equal(phasedRun([], null).phase, null);
});

test("only listed threads with a workflow count above zero are polled, in reading order", () => {
  const active = (workflows: number) => ({ ...nothing, workflows });
  const threads = [
    thread("parent", { activity: active(1) }),
    thread("child", { parentThreadId: "parent", activity: active(2) }),
    thread("quiet", { activity: nothing }),
    thread("old-host"),
    thread("unlisted", { activity: active(3) }),
  ];
  const { rows } = buildList(threads, new Set(["parent", "quiet", "old-host"]), panes, {});
  const byId = new Map(threads.map((item) => [item.id, item]));
  assert.deepEqual(threadsWithWorkflows(rows, byId), [
    { id: "parent", workflows: 1 },
    { id: "child", workflows: 2 },
  ]);
});

test("a poll replaces a thread's runs, keeps them when its fetch failed, and drops unpolled threads", () => {
  const previous = new Map([
    ["a", [run({ id: "a1" })]],
    ["b", [run({ id: "b1" })]],
    ["gone", [run({ id: "g1" })]],
  ]);
  const fetched = new Map<string, WorkflowRun[] | null>([
    ["a", [run({ id: "a2" })]],
    ["b", null],
    ["c", []],
  ]);
  const next = nextRuns(previous, ["a", "b", "c"], fetched);
  assert.deepEqual(
    [...next].map(([id, runs]) => [id, runs.map((item) => item.id)]),
    [
      ["a", ["a2"]],
      ["b", ["b1"]],
    ],
  );
  assert.equal(nextRuns(previous, [], fetched).size, 0);
});
