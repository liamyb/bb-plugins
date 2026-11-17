import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBeats,
  clip,
  commandGist,
  contextFill,
  describeItem,
  emptyState,
  formatElapsed,
  formatTokens,
  histTotals,
  mergeStates,
  nodeState,
  parseBeats,
  parseWireBeats,
  shortModel,
  threadHist,
  toolsPerMinute,
  withContext,
  withoutThreads,
  type Beat,
} from "./model.ts";

const T0 = 1_794_933_600_000; // on a minute boundary
const MIN = 60_000;

function requested(seq: number, at: number, data: Record<string, unknown>, threadId = "thr_a") {
  return { threadId, seq, createdAt: at, type: "client/turn/requested", data };
}

function item(seq: number, at: number, body: Record<string, unknown>, threadId = "thr_a") {
  return { threadId, seq, createdAt: at, type: "item/started", data: { item: body } };
}

test("a hand-off from another thread is an ask with its sender, model and a preview", () => {
  const [beat] = parseBeats([
    requested(46, T0, {
      initiator: "agent",
      senderThreadId: "thr_hub",
      source: "tell",
      input: [{ type: "text", text: "[bb message from thread:thr_hub]\n\nPlease pick this up:\n the build" }],
      execution: { model: "claude-fable-5-2", reasoningLevel: "xhigh" },
    }),
  ]);
  assert.deepEqual(beat, {
    threadId: "thr_a",
    seq: 46,
    at: T0,
    kind: "ask",
    origin: "thread",
    from: "thr_hub",
    model: "claude-fable-5-2",
    reasoning: "xhigh",
    text: "Please pick this up: the build",
    retry: false,
  });
});

test("your own message, a child's report, an automation and a compact are told apart", () => {
  const beats = parseBeats([
    requested(1, T0, { initiator: "user", input: [{ type: "text", text: "Hello" }] }),
    requested(2, T0, { initiator: "system", systemMessageSubject: { threadId: "thr_kid" }, input: [{ type: "text", text: "done" }] }),
    requested(3, T0, { initiator: "user", input: [{ type: "text", text: "[bb automation due:auto_1] run" }] }),
    requested(4, T0, { initiator: "user", input: [{ type: "text", text: "/compact" }] }),
  ]);
  assert.deepEqual(
    beats.map((beat) => (beat.kind === "ask" ? [beat.origin, beat.from, beat.text] : null)),
    [
      ["you", null, "Hello"],
      ["child", "thr_kid", ""],
      ["automation", null, ""],
      ["maintenance", null, ""],
    ],
  );
});

test("the things an agent starts get a short name and a detail", () => {
  assert.deepEqual(describeItem({ type: "commandExecution", command: "ls -la\nsecond", description: "List the files" }), {
    tool: "Bash",
    detail: "List the files",
    quiet: false,
  });
  assert.deepEqual(describeItem({ type: "commandExecution", command: "ls -la\nsecond line" }), {
    tool: "Bash",
    detail: "ls -la",
    quiet: false,
  });
  assert.deepEqual(
    describeItem({ type: "toolCall", tool: "Skill", presentation: { title: "task-observer", label: { pending: "Loading skill" } } }),
    { tool: "Skill", detail: "task-observer", quiet: false },
  );
  assert.deepEqual(describeItem({ type: "toolCall", tool: "mcp__claude_ai_ClickUp__clickup_create_task" }), {
    tool: "ClickUp",
    detail: "create task",
    quiet: false,
  });
  assert.deepEqual(
    describeItem({ type: "toolCall", server: "claude_ai_ClickUp", tool: "clickup_create_comment", presentation: { title: "claude_ai_ClickUp" } }),
    { tool: "ClickUp", detail: "create comment", quiet: false },
  );
  assert.deepEqual(describeItem({ type: "toolCall", server: "n8n", tool: "search_nodes" }), {
    tool: "n8n",
    detail: "search nodes",
    quiet: false,
  });
  assert.deepEqual(describeItem({ type: "toolCall", tool: "mcp__claude-in-chrome__navigate" }), {
    tool: "Chrome",
    detail: "navigate",
    quiet: false,
  });
  assert.deepEqual(describeItem({ type: "fileRead", path: "/a/b/notes.md" }), { tool: "Read", detail: "notes.md", quiet: false });
  assert.deepEqual(describeItem({ type: "webFetch", url: "https://getbb.app/plugin-guide" }), {
    tool: "Fetch",
    detail: "getbb.app",
    quiet: false,
  });
  assert.deepEqual(describeItem({ type: "reasoning" }), { tool: "Thinking", detail: "", quiet: true });
  assert.equal(describeItem({ type: "userMessage" }), null);
  assert.equal(describeItem(null), null);
  assert.deepEqual(describeItem({ type: "somethingNew" }), { tool: "somethingNew", detail: "", quiet: false });
});

test("rows come back oldest first, and rows that aren't events are dropped", () => {
  const beats = parseBeats([
    { threadId: "thr_a", seq: "9", createdAt: T0 + 5, type: "turn/completed", data: { status: "interrupted" } },
    item(7, T0 + 2, { type: "toolCall", tool: "Read", parentToolCallId: "call_1" }),
    { threadId: "thr_a", seq: 5, createdAt: T0, type: "turn/started", data: {} },
    { threadId: "thr_a", seq: 8, createdAt: T0 + 3, type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens: 1200, modelContextWindow: 1000000 } } },
    { threadId: "thr_a", seq: 6, createdAt: T0 + 1, type: "thread/contextWindowUsage/updated", data: { contextWindowUsage: { usedTokens: null, modelContextWindow: null } } },
    { seq: 10, createdAt: T0, type: "turn/started" },
    "nonsense",
    { threadId: "thr_a", seq: 11, createdAt: T0, type: "item/agentMessage/delta", data: {} },
  ]);
  assert.deepEqual(
    beats.map((beat) => [beat.seq, beat.kind]),
    [
      [5, "start"],
      [7, "tool"],
      [8, "context"],
      [9, "end"],
    ],
  );
  assert.equal(beats[1]!.kind === "tool" && beats[1]!.sub, true);
  assert.equal(beats[3]!.kind === "end" && beats[3]!.status, "interrupted");
  assert.deepEqual(parseBeats(null), []);
});

function tool(seq: number, at: number, threadId = "thr_a", quiet = false): Beat {
  return { kind: "tool", threadId, seq, at, tool: quiet ? "Thinking" : "Bash", detail: "", sub: false, quiet };
}

function ask(seq: number, at: number, origin: "you" | "thread" | "child" | "maintenance", from: string | null, threadId = "thr_a"): Beat {
  return { kind: "ask", threadId, seq, at, origin, from, model: "claude-opus-5-5", reasoning: "high", text: "", retry: false };
}

test("a turn is tracked from its request to its end, with what the agent is doing", () => {
  let state = applyBeats(emptyState(), [ask(1, T0, "thread", "thr_hub"), { kind: "start", threadId: "thr_a", seq: 2, at: T0 + 10 }], T0);
  assert.deepEqual(state.vitals.thr_a!.turn, { at: T0, origin: "thread", from: "thr_hub" });
  assert.equal(state.vitals.thr_a!.model, "claude-opus-5-5");
  assert.deepEqual(state.edges, [{ key: "thr_a:1", at: T0, from: "thr_hub", to: "thr_a", kind: "tell" }]);

  state = applyBeats(state, [tool(3, T0 + 20, "thr_a", true), tool(4, T0 + 30)], T0 + 30);
  assert.equal(state.vitals.thr_a!.doing!.tool, "Bash");
  assert.deepEqual(state.feed.map((beat) => beat.kind), ["ask", "tool"]);

  state = applyBeats(state, [{ kind: "end", threadId: "thr_a", seq: 5, at: T0 + 40, status: "completed" }], T0 + 40);
  assert.equal(state.vitals.thr_a!.turn, null);
  assert.equal(state.vitals.thr_a!.doing, null);
  assert.equal(state.vitals.thr_a!.lastAt, T0 + 40);
  assert.deepEqual(state.feed.map((beat) => beat.kind), ["ask", "tool", "end"]);
});

test("a message queued behind a running turn starts the next one", () => {
  let state = applyBeats(emptyState(), [ask(1, T0, "you", null), { kind: "start", threadId: "thr_a", seq: 2, at: T0 }], T0);
  state = applyBeats(state, [ask(3, T0 + 5, "child", "thr_kid")], T0 + 5);
  // Still the first turn while it runs.
  assert.equal(state.vitals.thr_a!.turn!.origin, "you");
  state = applyBeats(
    state,
    [
      { kind: "end", threadId: "thr_a", seq: 4, at: T0 + 9, status: "completed" },
      { kind: "start", threadId: "thr_a", seq: 5, at: T0 + 10 },
    ],
    T0 + 10,
  );
  assert.deepEqual(state.vitals.thr_a!.turn, { at: T0 + 10, origin: "child", from: "thr_kid" });
  assert.equal(state.edges[0]!.kind, "report");
});

test("a beat seen twice counts once, and an untouched state is returned as it was", () => {
  const first = applyBeats(emptyState(), [tool(4, T0)], T0);
  const again = applyBeats(first, [tool(3, T0), tool(4, T0)], T0);
  assert.equal(again, first);
  assert.equal(histTotals(again, T0, 3)[2], 1);
});

test("a compact stays out of the feed, both when asked for and when it ends", () => {
  const state = applyBeats(
    emptyState(),
    [ask(1, T0, "maintenance", null), { kind: "end", threadId: "thr_a", seq: 2, at: T0 + 1, status: "completed" }],
    T0 + 1,
  );
  assert.deepEqual(state.feed, []);
  assert.equal(state.vitals.thr_a!.turn, null);
});

test("tool calls are counted by the minute and old minutes fall away", () => {
  let state = applyBeats(emptyState(), [tool(1, T0), tool(2, T0 + 10_000), tool(3, T0 + MIN)], T0 + MIN);
  state = applyBeats(state, [tool(1, T0 + MIN, "thr_b")], T0 + MIN);
  assert.deepEqual(histTotals(state, T0 + MIN, 3), [0, 2, 2]);
  assert.deepEqual(threadHist(state.vitals.thr_a, T0 + MIN, 3), [0, 2, 1]);
  assert.deepEqual(threadHist(undefined, T0 + MIN, 2), [0, 0]);
  assert.equal(toolsPerMinute(state, T0 + MIN, 2), 2);
  // Two hours on, a new call drops the old minutes from that thread.
  const later = T0 + 120 * MIN;
  state = applyBeats(state, [tool(9, later)], later);
  assert.deepEqual(Object.keys(state.vitals.thr_a!.hist), [String(Math.floor(later / MIN))]);
});

test("the feed and the hand-offs are capped", () => {
  const beats: Beat[] = [];
  for (let seq = 1; seq <= 200; seq += 1) beats.push(tool(seq, T0 + seq));
  for (let seq = 201; seq <= 320; seq += 1) beats.push(ask(seq, T0 + seq, "thread", "thr_hub"));
  const state = applyBeats(emptyState(), beats, T0 + 400);
  assert.equal(state.feed.length, 120);
  assert.equal(state.edges.length, 80);
  assert.equal(state.edges[79]!.key, "thr_a:320");
});

test("a hand-off older than a day is forgotten", () => {
  const day = 24 * 60 * MIN;
  let state = applyBeats(emptyState(), [ask(1, T0, "thread", "thr_hub")], T0);
  state = applyBeats(state, [ask(2, T0 + day + 1, "thread", "thr_hub")], T0 + day + 1);
  assert.deepEqual(state.edges.map((edge) => edge.key), ["thr_a:2"]);
});

test("a context reading keeps what it doesn't replace", () => {
  let state = applyBeats(emptyState(), [{ kind: "context", threadId: "thr_a", seq: 1, at: T0, used: 500, window: 1000 }], T0);
  state = applyBeats(state, [{ kind: "context", threadId: "thr_a", seq: 2, at: T0, used: null, window: 2000 }], T0);
  assert.equal(contextFill(state.vitals.thr_a), 0.25);
  state = withContext(state, "thr_b", 100, 400);
  assert.equal(contextFill(state.vitals.thr_b), 0.25);
  assert.equal(withContext(state, "thr_b", null, null), state);
  assert.equal(contextFill(undefined), null);
  assert.deepEqual(Object.keys(withoutThreads(state, ["thr_a"]).vitals), ["thr_b"]);
  assert.equal(withoutThreads(state, ["thr_zzz"]), state);
});

test("a realtime payload is checked field by field", () => {
  const beats = parseWireBeats({
    beats: [
      { kind: "tool", threadId: "thr_a", seq: 3, at: T0, tool: "Bash", detail: "x".repeat(300), sub: true },
      { kind: "ask", threadId: "thr_a", seq: 4, at: T0, origin: "thread", from: "thr_b", model: null, text: "hi" },
      { kind: "ask", threadId: "thr_a", seq: 5, at: T0, origin: "somebody" },
      { kind: "tool", threadId: 7, seq: 6, at: T0 },
      { kind: "end", threadId: "thr_a", seq: 7, at: T0 },
      { kind: "context", threadId: "thr_a", seq: 8, at: T0, used: "12", window: "x" },
      { kind: "mystery", threadId: "thr_a", seq: 9, at: T0 },
      null,
    ],
  });
  assert.deepEqual(beats.map((beat) => [beat.seq, beat.kind]), [
    [3, "tool"],
    [4, "ask"],
    [7, "end"],
    [8, "context"],
  ]);
  assert.equal(beats[0]!.kind === "tool" && beats[0]!.detail.length, 96);
  assert.deepEqual(beats[3], { threadId: "thr_a", seq: 8, at: T0, kind: "context", used: 12, window: null });
  assert.deepEqual(parseWireBeats("no"), []);
  assert.deepEqual(parseWireBeats({ beats: "no" }), []);
});

const facts = {
  id: "thr_a",
  parentThreadId: null,
  status: "idle",
  runtimeStatus: "idle",
  hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 },
  indicator: "none",
  isUnread: false,
  isHidden: false,
  isArchived: false,
  latestAttentionAt: null,
  updatedAt: 0,
};

test("a thread's state: asking beats failed beats working beats unread", () => {
  assert.equal(nodeState(facts), "idle");
  assert.equal(nodeState({ ...facts, isUnread: true }), "unread");
  assert.equal(nodeState({ ...facts, isUnread: true, status: "active" }), "working");
  assert.equal(nodeState({ ...facts, activity: { workflows: 0, backgroundAgents: 1, backgroundCommands: 0 } }), "working");
  assert.equal(nodeState({ ...facts, status: "error" }), "error");
  assert.equal(nodeState({ ...facts, indicator: "unread-error" }), "error");
  assert.equal(nodeState({ ...facts, status: "active", hasPendingInteraction: true }), "asking");
  assert.equal(nodeState({ ...facts, status: "error", indicator: "queued-failed" }), "asking");
});

test("labels", () => {
  assert.equal(shortModel("claude-fable-5-2"), "Fable 5.2");
  assert.equal(shortModel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(shortModel("claude-haiku-5-5-20261001"), "Haiku 5.5");
  assert.equal(shortModel("claude-opus-4"), "Opus 4");
  assert.equal(shortModel("gpt-5.1-codex"), "gpt-5.1-codex");
  assert.equal(shortModel(null), "");
  assert.equal(formatTokens(228_721), "229k");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_240_000), "1.2M");
  assert.equal(formatTokens(12_400_000), "12M");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatElapsed(12_400), "12s");
  assert.equal(formatElapsed(245_000), "4m 05s");
  assert.equal(formatElapsed(4_320_000), "1h 12m");
  assert.equal(clip("  a   b\n c ", 20), "a b c");
  assert.equal(clip("abcdefghij", 6), "abcde…");
});

test("a snapshot joins what a window already has: the fuller reading of each thread, nothing twice", () => {
  const shared: Beat[] = [ask(1, T0, "thread", "thr_hub"), tool(2, T0 + 1)];
  const snapshot = withContext(applyBeats(emptyState(), shared, T0 + 1), "thr_a", 100, 1000);
  // The window got one more beat live before the snapshot landed, and knows another thread.
  let local = applyBeats(emptyState(), [...shared, tool(3, T0 + 2)], T0 + 2);
  local = applyBeats(local, [tool(1, T0 + 3, "thr_b")], T0 + 3);
  const merged = mergeStates(local, snapshot, T0 + 3);
  assert.equal(merged.vitals.thr_a!.lastSeq, 3);
  assert.equal(merged.vitals.thr_a!.used, 100);
  assert.equal(merged.vitals.thr_b!.lastSeq, 1);
  assert.deepEqual(merged.feed.map((beat) => `${beat.threadId}:${beat.seq}`), ["thr_a:1", "thr_a:2", "thr_a:3", "thr_b:1"]);
  assert.equal(merged.edges.length, 1);
  // The other way round gives the same picture.
  const other = mergeStates(snapshot, local, T0 + 3);
  assert.deepEqual(other.vitals.thr_a, merged.vitals.thr_a);
  assert.deepEqual(other.feed, merged.feed);
});

test("a retry carries on the turn before it: still for whoever asked, and out of the feed", () => {
  const [retry] = parseBeats([
    requested(9, T0 + 50, {
      initiator: "system",
      source: "tell",
      retryOfRequestId: "creq_1",
      retryAttempt: 2,
      systemMessageSubject: null,
      input: [{ type: "text", text: "Please continue." }],
      execution: { model: "claude-fable-5-2" },
    }),
  ]);
  assert.equal(retry!.kind === "ask" && retry!.retry, true);
  let state = applyBeats(emptyState(), [ask(1, T0, "thread", "thr_hub"), { kind: "end", threadId: "thr_a", seq: 2, at: T0 + 9, status: "failed" }], T0 + 9);
  state = applyBeats(state, [retry!], T0 + 50);
  assert.deepEqual(state.vitals.thr_a!.turn, { at: T0 + 50, origin: "thread", from: "thr_hub" });
  assert.equal(state.vitals.thr_a!.model, "claude-fable-5-2");
  assert.deepEqual(state.feed.map((beat) => beat.kind), ["ask", "end"]);
  assert.equal(state.edges.length, 1);
  // With nothing known before it, it's upkeep and nobody's.
  const alone = applyBeats(emptyState(), [retry!], T0 + 50);
  assert.equal(alone.vitals.thr_a!.turn!.origin, "maintenance");
});

test("a command is told by what it does, not by its set-up", () => {
  assert.equal(commandGist('cd "/Users/me/My Drive/work" && bb thread list --json'), "bb thread list --json");
  assert.equal(commandGist("SCR=/private/tmp/x; cd $SCR/repo && npm test"), "npm test");
  assert.equal(commandGist("export FOO='a b' && BAR=$(pwd); ls -la\nsecond line"), "ls -la");
  assert.equal(commandGist("git status --short"), "git status --short");
  assert.equal(commandGist("FOO=bar"), "FOO=bar");
  assert.deepEqual(describeItem({ type: "commandExecution", command: 'cd "$TMPDIR" && curl -s http://x' }), {
    tool: "Bash",
    detail: "curl -s http://x",
    quiet: false,
  });
});
