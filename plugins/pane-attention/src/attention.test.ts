// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseMemory,
  serializeMemory,
  step,
  type MemoryMap,
  type Pane,
  type ThreadState,
} from "./attention.ts";

const idle: ThreadState = {
  status: "idle",
  runtimeStatus: "idle",
  hasPendingInteraction: false,
  indicator: "none",
  latestAttentionAt: 100,
};
const running: ThreadState = {
  ...idle,
  status: "active",
  runtimeStatus: "active",
  indicator: "runtime",
};

function panes(focusedThread: string, ...threadIds: string[]): Pane[] {
  return threadIds.map((threadId, index) => ({
    paneId: `pane-${index + 1}`,
    threadId,
    isFocused: threadId === focusedThread,
  }));
}

function run(
  memory: MemoryMap,
  layout: Pane[],
  threads: Record<string, ThreadState>,
) {
  return step(memory, layout, new Map(Object.entries(threads)));
}

test("a thread seen for the first time is never flagged", () => {
  const { attention } = run({}, panes("a", "a", "b"), { a: idle, b: idle });
  assert.equal(attention.size, 0);
});

test("finishing while unfocused flags done, focusing clears it", () => {
  let memory = run({}, panes("a", "a", "b"), { a: idle, b: running }).memory;
  const finished = run(memory, panes("a", "a", "b"), { a: idle, b: idle });
  assert.equal(finished.attention.get("pane-2"), "done");
  memory = finished.memory;

  // Still flagged on later snapshots until the pane is focused.
  const later = run(memory, panes("a", "a", "b"), { a: idle, b: idle });
  assert.equal(later.attention.get("pane-2"), "done");

  const focused = run(later.memory, panes("b", "a", "b"), { a: idle, b: idle });
  assert.equal(focused.attention.size, 0);
  const away = run(focused.memory, panes("a", "a", "b"), { a: idle, b: idle });
  assert.equal(away.attention.size, 0);
});

test("the focused pane is never marked, even when its thread finishes", () => {
  const memory = run({}, panes("b", "a", "b"), { a: idle, b: running }).memory;
  const { attention } = run(memory, panes("b", "a", "b"), {
    a: idle,
    b: idle,
  });
  assert.equal(attention.size, 0);
});

test("an attention bump while unfocused flags done with no busy state seen", () => {
  const memory = run({}, panes("a", "a", "b"), { a: idle, b: idle }).memory;
  const { attention } = run(memory, panes("a", "a", "b"), {
    a: idle,
    b: { ...idle, latestAttentionAt: 200 },
  });
  assert.equal(attention.get("pane-2"), "done");
});

test("a failed turn is needs-you, and clears on focus", () => {
  const memory = run({}, panes("a", "a", "b"), { a: idle, b: running }).memory;
  const failed = run(memory, panes("a", "a", "b"), {
    a: idle,
    b: { ...idle, status: "error", indicator: "unread-error" },
  });
  assert.equal(failed.attention.get("pane-2"), "needs-you");
  const focused = run(failed.memory, panes("b", "a", "b"), {
    a: idle,
    b: { ...idle, status: "error" },
  });
  assert.equal(focused.attention.size, 0);
});

test("a pending question is needs-you whenever its pane is unfocused", () => {
  const asking = { ...idle, hasPendingInteraction: true };
  const first = run({}, panes("a", "a", "b"), { a: idle, b: asking });
  assert.equal(first.attention.get("pane-2"), "needs-you");
  const focused = run(first.memory, panes("b", "a", "b"), { a: idle, b: asking });
  assert.equal(focused.attention.size, 0);
  const away = run(focused.memory, panes("a", "a", "b"), { a: idle, b: asking });
  assert.equal(away.attention.get("pane-2"), "needs-you");
  const answered = run(away.memory, panes("a", "a", "b"), {
    a: idle,
    b: running,
  });
  assert.equal(answered.attention.size, 0);
});

test("starting work again clears a done flag", () => {
  let memory = run({}, panes("a", "a", "b"), { a: idle, b: running }).memory;
  memory = run(memory, panes("a", "a", "b"), { a: idle, b: idle }).memory;
  const again = run(memory, panes("a", "a", "b"), { a: idle, b: running });
  assert.equal(again.attention.size, 0);
});

test("a thread open in the focused pane and another pane is not marked", () => {
  const memory = run({}, panes("a", "a", "b"), { a: idle, b: running }).memory;
  const layout: Pane[] = [
    { paneId: "pane-1", threadId: "b", isFocused: true },
    { paneId: "pane-2", threadId: "b", isFocused: false },
  ];
  const { attention } = run(memory, layout, { b: idle });
  assert.equal(attention.size, 0);
});

test("threads closed from every pane are forgotten", () => {
  const memory = run({}, panes("a", "a", "b"), { a: idle, b: running }).memory;
  const closed = run(memory, panes("a", "a", "c"), {
    a: idle,
    b: idle,
    c: idle,
  });
  assert.deepEqual(Object.keys(closed.memory).sort(), ["a", "c"]);
});

test("a thread missing from the list keeps its memory", () => {
  let memory = run({}, panes("a", "a", "b"), { a: idle, b: running }).memory;
  memory = run(memory, panes("a", "a", "b"), { a: idle, b: idle }).memory;
  const gap = run(memory, panes("a", "a", "b"), { a: idle });
  assert.equal(gap.memory.b?.flag, "done");
});

test("memory survives a round trip and rejects junk", () => {
  const memory: MemoryMap = {
    b: { busy: false, attentionAt: 5, flag: "done" },
    c: { busy: true, attentionAt: null, flag: null },
  };
  assert.deepEqual(parseMemory(serializeMemory(memory)), memory);
  assert.deepEqual(parseMemory("not json"), {});
  assert.deepEqual(parseMemory(null), {});
  assert.deepEqual(
    parseMemory('{"x":{"busy":"yes"},"y":{"busy":false,"attentionAt":1,"flag":"maybe"}}'),
    {},
  );
});
