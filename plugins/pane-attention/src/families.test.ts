import assert from "node:assert/strict";
import { test } from "node:test";
import {
  familyMarks,
  hashHue,
  missingThreadIds,
  rootOf,
  type FamilyThread,
} from "./families.ts";

function lookupOf(threads: FamilyThread[]) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return (id: string) => byId.get(id);
}

const hub: FamilyThread = { id: "hub", parentThreadId: null, title: "Hub" };
const kid: FamilyThread = { id: "kid", parentThreadId: "hub", title: "Kid" };
const kid2: FamilyThread = { id: "kid2", parentThreadId: "hub", title: "Kid 2" };
const grandkid: FamilyThread = { id: "gk", parentThreadId: "kid", title: "Grandkid" };
const loner: FamilyThread = { id: "loner", parentThreadId: null, title: "Loner" };

test("hashHue matches Sidebar Pro's disc", () => {
  // Same arithmetic as Sidebar Pro's src/Disc.tsx.
  assert.equal(hashHue("a"), 97);
  assert.equal(hashHue("ab"), (97 * 31 + 98) % 360);
  assert.ok(hashHue("thr_fi2qc8acr7") >= 0 && hashHue("thr_fi2qc8acr7") < 360);
});

test("a parent and its child share the root's colour", () => {
  const marks = familyMarks(
    [
      { paneId: "p1", threadId: "hub" },
      { paneId: "p2", threadId: "kid" },
    ],
    lookupOf([hub, kid]),
  );
  assert.deepEqual(marks.get("p1"), {
    role: "parent",
    rootId: "hub",
    hue: hashHue("hub"),
    parentId: null,
    parentTitle: null,
  });
  assert.deepEqual(marks.get("p2"), {
    role: "child",
    rootId: "hub",
    hue: hashHue("hub"),
    parentId: "hub",
    parentTitle: "Hub",
  });
});

test("a parent with no children open stays plain, and so does a loner", () => {
  const marks = familyMarks(
    [
      { paneId: "p1", threadId: "hub" },
      { paneId: "p2", threadId: "loner" },
    ],
    lookupOf([hub, kid, loner]),
  );
  assert.equal(marks.size, 0);
});

test("a child is marked even when its parent isn't open", () => {
  const marks = familyMarks(
    [{ paneId: "p1", threadId: "kid" }],
    lookupOf([hub, kid]),
  );
  assert.equal(marks.get("p1")?.role, "child");
  assert.equal(marks.get("p1")?.parentTitle, "Hub");
});

test("a grandchild takes the root's colour and names its own parent", () => {
  const marks = familyMarks(
    [
      { paneId: "p1", threadId: "hub" },
      { paneId: "p2", threadId: "gk" },
    ],
    lookupOf([hub, kid, grandkid]),
  );
  assert.equal(marks.get("p1")?.role, "parent");
  assert.equal(marks.get("p2")?.hue, hashHue("hub"));
  assert.equal(marks.get("p2")?.parentId, "kid");
  assert.equal(marks.get("p2")?.parentTitle, "Kid");
});

test("siblings agree on a root the lookup doesn't have", () => {
  const marks = familyMarks(
    [
      { paneId: "p1", threadId: "kid" },
      { paneId: "p2", threadId: "kid2" },
    ],
    lookupOf([kid, kid2]),
  );
  assert.equal(marks.get("p1")?.rootId, "hub");
  assert.equal(marks.get("p2")?.rootId, "hub");
  assert.equal(marks.get("p1")?.parentTitle, null);
});

test("panes without a thread are skipped", () => {
  const marks = familyMarks(
    [
      { paneId: "p1", threadId: null },
      { paneId: "p2", threadId: "hub" },
    ],
    lookupOf([hub]),
  );
  assert.equal(marks.size, 0);
});

test("a parent cycle doesn't hang", () => {
  const a: FamilyThread = { id: "a", parentThreadId: "b", title: "A" };
  const b: FamilyThread = { id: "b", parentThreadId: "a", title: "B" };
  assert.equal(rootOf("a", lookupOf([a, b])), "b");
  assert.deepEqual(
    missingThreadIds([{ paneId: "p1", threadId: "a" }], lookupOf([a, b])),
    [],
  );
});

test("missingThreadIds asks for the first unknown thread up each chain", () => {
  assert.deepEqual(
    missingThreadIds(
      [
        { paneId: "p1", threadId: "gk" },
        { paneId: "p2", threadId: "archived" },
        { paneId: "p3", threadId: null },
      ],
      lookupOf([grandkid, kid]),
    ),
    ["hub", "archived"],
  );
});
