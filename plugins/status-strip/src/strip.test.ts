import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextLevel,
  contextPercent,
  isWorking,
  litLeds,
  runningLabel,
  sameWorking,
  themeWantsStrip,
  tokensLabel,
  workingThreads,
  type ThreadLike,
} from "./strip.ts";

const idle = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 };
const thread = (over: Partial<ThreadLike>): ThreadLike => ({
  id: "t",
  displayTitle: "T",
  status: "idle",
  runtimeStatus: "idle",
  activity: idle,
  ...over,
});

test("a running turn counts as working", () => {
  assert.equal(isWorking(thread({ status: "active" })), true);
  assert.equal(isWorking(thread({ status: "starting" })), true);
  assert.equal(isWorking(thread({ runtimeStatus: "provisioning" })), true);
});

test("background work after the turn still counts", () => {
  assert.equal(isWorking(thread({ activity: { ...idle, workflows: 1 } })), true);
  assert.equal(isWorking(thread({ activity: { ...idle, backgroundAgents: 2 } })), true);
  assert.equal(isWorking(thread({ activity: { ...idle, backgroundCommands: 1 } })), true);
});

test("idle, errored and pending threads don't count", () => {
  assert.equal(isWorking(thread({})), false);
  assert.equal(isWorking(thread({ status: "error" })), false);
  assert.equal(isWorking(thread({ status: "pending" })), false);
  assert.equal(isWorking(thread({ activity: undefined })), false);
});

test("workingThreads keeps order and titles", () => {
  const list = workingThreads([
    thread({ id: "a", displayTitle: "A", status: "active" }),
    thread({ id: "b", displayTitle: "B" }),
    thread({ id: "c", displayTitle: "C", activity: { ...idle, workflows: 1 } }),
  ]);
  assert.deepEqual(list, [
    { id: "a", title: "A" },
    { id: "c", title: "C" },
  ]);
});

test("sameWorking compares ids and titles in order", () => {
  assert.equal(sameWorking([{ id: "a", title: "A" }], [{ id: "a", title: "A" }]), true);
  assert.equal(sameWorking([{ id: "a", title: "A" }], [{ id: "a", title: "A2" }]), false);
  assert.equal(sameWorking([], [{ id: "a", title: "A" }]), false);
});

test("contextPercent rounds and clamps, and knows when it doesn't know", () => {
  assert.equal(contextPercent({ usedTokens: 546014, modelContextWindow: 1000000 }), 55);
  assert.equal(contextPercent({ usedTokens: 2000, modelContextWindow: 1000 }), 100);
  assert.equal(contextPercent({ usedTokens: null, modelContextWindow: 1000 }), null);
  assert.equal(contextPercent({ usedTokens: 10, modelContextWindow: 0 }), null);
  assert.equal(contextPercent(null), null);
});

test("litLeds lights at least one once anything is used", () => {
  assert.equal(litLeds(0), 0);
  assert.equal(litLeds(1), 1);
  assert.equal(litLeds(55), 6);
  assert.equal(litLeds(100), 10);
});

test("contextLevel turns amber at 70 and red at 90", () => {
  assert.equal(contextLevel(69), "ok");
  assert.equal(contextLevel(70), "high");
  assert.equal(contextLevel(90), "full");
});

test("labels", () => {
  assert.equal(runningLabel(0), "Idle");
  assert.equal(runningLabel(1), "1 running");
  assert.equal(runningLabel(4), "4 running");
  assert.equal(tokensLabel({ usedTokens: 546014, modelContextWindow: 1000000, estimated: true }), "About 546,014 of 1,000,000 tokens");
  assert.equal(tokensLabel({ usedTokens: 12, modelContextWindow: 200000 }), "12 of 200,000 tokens");
});

test("a theme opts in with --status-strip: on", () => {
  assert.equal(themeWantsStrip(" on"), true);
  assert.equal(themeWantsStrip("ON"), true);
  assert.equal(themeWantsStrip(""), false);
  assert.equal(themeWantsStrip("off"), false);
});
