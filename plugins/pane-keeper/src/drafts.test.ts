// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftComposer,
  holdsPrompt,
  liveDrafts,
  parseDraft,
  parseEnvironmentRef,
  type Draft,
} from "./drafts.ts";

function draft(id: string, createdAt: number, expiresAt: number): Draft {
  return {
    id,
    projectId: "proj_1",
    environmentId: null,
    prompt: "Help me with this task.",
    createdAt,
    expiresAt,
  };
}

test("a stored draft parses, and a malformed one doesn't", () => {
  const good = draft("draft_a", 1, 2);
  assert.deepEqual(parseDraft(good), good);
  assert.deepEqual(parseDraft({ ...good, environmentId: "env_1" }), {
    ...good,
    environmentId: "env_1",
  });
  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft("draft_a"), null);
  assert.equal(parseDraft({ ...good, id: "" }), null);
  assert.equal(parseDraft({ ...good, prompt: 4 }), null);
  assert.equal(parseDraft({ ...good, environmentId: 7 }), null);
  assert.equal(parseDraft({ ...good, expiresAt: Number.NaN }), null);
});

test("claimed drafts come back oldest first, without expired or broken ones", () => {
  const now = 1_000;
  const live = liveDrafts(
    [
      draft("draft_late", 300, 2_000),
      draft("draft_gone", 100, 999),
      { not: "a draft" },
      undefined,
      draft("draft_early", 200, 1_001),
    ],
    now,
  );
  assert.deepEqual(
    live.map((item) => item.id),
    ["draft_early", "draft_late"],
  );
});

test("the same prompt isn't typed in twice, whatever the spacing", () => {
  const prompt = "Help me work through this task.\n\nTask: Board pack";
  assert.equal(holdsPrompt("", prompt), false);
  assert.equal(holdsPrompt("Some notes of my own", prompt), false);
  assert.equal(
    holdsPrompt(`My notes\n\nHelp me work through this task.\nTask:  Board pack\n`, prompt),
    true,
  );
  assert.equal(holdsPrompt("anything", "   "), false);
});

test("the draft goes into New thread for its own project only", () => {
  const thread = { scope: { kind: "thread" as const, threadId: "thr_1" } };
  const otherProject = { scope: { kind: "new-thread" as const, projectId: "proj_2" } };
  const unresolved = { scope: { kind: "new-thread" as const, projectId: null } };
  const right = { scope: { kind: "new-thread" as const, projectId: "proj_1" } };
  assert.equal(draftComposer([thread, otherProject, unresolved], "proj_1"), null);
  assert.equal(draftComposer([thread, otherProject, right], "proj_1"), right);
});

test("--environment takes an id or a checkout path", () => {
  assert.deepEqual(parseEnvironmentRef("env_82jgfihfwx"), {
    kind: "id",
    id: "env_82jgfihfwx",
  });
  assert.deepEqual(parseEnvironmentRef("/Users/me/My Drive/workspace/"), {
    kind: "path",
    path: "/Users/me/My Drive/workspace",
  });
  assert.deepEqual(parseEnvironmentRef("/"), { kind: "path", path: "/" });
});
