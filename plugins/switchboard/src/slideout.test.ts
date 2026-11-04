import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DOCKED_MIN_PX,
  correctedWidth,
  fileName,
  firstGrowWidth,
  fitOnScreen,
  followTrail,
  newestFileSince,
  parseSlideOutRecord,
  recentItemsKey,
  threadIdFromHref,
  untouched,
} from "./slideout.ts";

test("the first guess is the column and a panel as wide as it", () => {
  assert.equal(firstGrowWidth({ column: 500, scale: 1 }), 1000);
  // bb's zoom: screen units per CSS pixel.
  assert.equal(firstGrowWidth({ column: 500, scale: 1.1 }), 1100);
  // Never short of the docked layout, however narrow the column.
  assert.equal(firstGrowWidth({ column: 300, scale: 1 }), DOCKED_MIN_PX + 1);
});

test("the correction brings the column back to its width at the panel's share", () => {
  // bb's sidebar left open (320px), about half and half: column 364 of 729.
  assert.equal(
    correctedWidth({ outerWidth: 1049, innerWidth: 1049, scale: 1, contentLeft: 320, column: 364, wantColumn: 500 }),
    1321,
  );
  // The rail only, and you'd dragged the panel to 60%: column 400 of 1000.
  assert.equal(
    correctedWidth({ outerWidth: 1049, innerWidth: 1049, scale: 1, contentLeft: 49, column: 400, wantColumn: 500 }),
    1299,
  );
  // Already right.
  assert.equal(
    correctedWidth({ outerWidth: 1049, innerWidth: 1049, scale: 1, contentLeft: 49, column: 500, wantColumn: 500 }),
    1049,
  );
  // Zoomed: the extra CSS pixels become screen units.
  assert.equal(
    correctedWidth({ outerWidth: 1100, innerWidth: 1000, scale: 1.1, contentLeft: 49, column: 475, wantColumn: 500 }),
    1155,
  );
  // No panel beside the column.
  assert.equal(
    correctedWidth({ outerWidth: 1049, innerWidth: 1049, scale: 1, contentLeft: 49, column: 1000, wantColumn: 500 }),
    null,
  );
});

test("a window stays on the screen, moving left before it shrinks", () => {
  const screen = { availLeft: 0, availWidth: 1512 };
  assert.deepEqual(fitOnScreen(0, 1049, screen), { x: 0, width: 1049 });
  assert.deepEqual(fitOnScreen(800, 1049, screen), { x: 463, width: 1049 });
  assert.deepEqual(fitOnScreen(100, 2000, screen), { x: 0, width: 1512 });
  // A second screen to the left.
  assert.deepEqual(fitOnScreen(-1400, 1049, { availLeft: -1920, availWidth: 1920 }), { x: -1400, width: 1049 });
  assert.deepEqual(fitOnScreen(-800, 1049, { availLeft: -1920, availWidth: 1920 }), { x: -1049, width: 1049 });
});

test("a window resized by hand isn't shrunk", () => {
  assert.equal(untouched(1049, 1049), true);
  assert.equal(untouched(1055, 1049), true);
  assert.equal(untouched(1200, 1049), false);
});

test("a saved record round-trips and junk doesn't", () => {
  const record = { narrowWidth: 500, narrowX: 12, moved: false, grownWidth: 1000, column: 500 };
  assert.deepEqual(parseSlideOutRecord(JSON.parse(JSON.stringify(record))), record);
  assert.equal(parseSlideOutRecord({ ...record, column: 0 }), null);
  assert.equal(parseSlideOutRecord({ ...record, moved: "no" }), null);
  assert.equal(parseSlideOutRecord(null), null);
});

test("the newest file bb opened recently, from its recent items", () => {
  const raw = JSON.stringify([
    { source: "workspace", path: "notes/old.md", openedAt: 1_000 },
    { source: "workspace", path: "notes/new.html", openedAt: 9_000 },
    { source: "thread-storage", path: "report.md", openedAt: 8_000 },
    { source: "elsewhere", path: "x", openedAt: 9_500 },
    { path: "no-source.md", openedAt: 9_600 },
  ]);
  assert.deepEqual(newestFileSince(raw, 5_000), { source: "workspace", path: "notes/new.html", openedAt: 9_000 });
  assert.equal(newestFileSince(raw, 9_100), null);
  assert.equal(newestFileSince("not json", 0), null);
  assert.equal(newestFileSince(null, 0), null);
  assert.equal(recentItemsKey("thr_abc"), "bb.thread.recentItems-thr_abc-1");
  assert.equal(fileName("current-projects/x/report-DRAFT.md"), "report-DRAFT.md");
});

test("thread links are told apart from other links", () => {
  const origin = "http://127.0.0.1:38886";
  assert.equal(threadIdFromHref("/projects/proj_a1/threads/thr_abc123", origin), "thr_abc123");
  assert.equal(threadIdFromHref(`${origin}/projects/proj_a1/threads/thr_abc123#msg=42`, origin), "thr_abc123");
  assert.equal(threadIdFromHref("/threads/thr_abc123/", origin), "thr_abc123");
  assert.equal(threadIdFromHref("https://example.com/threads/thr_abc123", origin), null);
  assert.equal(threadIdFromHref("/projects/proj_a1/files/readme.md", origin), null);
  assert.equal(threadIdFromHref("/projects/proj_a1/threads/thr_abc123extra/../x", origin), null);
});

test("following links keeps a trail back", () => {
  assert.deepEqual(followTrail([], "thr_a", "thr_b"), ["thr_a"]);
  assert.deepEqual(followTrail(["thr_a"], "thr_b", "thr_c"), ["thr_a", "thr_b"]);
  // A link to the chat you're in, or with no chat open, adds nothing.
  assert.deepEqual(followTrail(["thr_a"], "thr_b", "thr_b"), ["thr_a"]);
  assert.deepEqual(followTrail([], null, "thr_b"), []);
});
