// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isStill, planSwitch, visibleBox, type Box } from "./blade-geometry.ts";

// Four slots on a 1,512px laptop with the sidebar hidden: 44px strips, 1px
// seams, and the open pane takes the rest (1,377px).
const S = 44;
const W = 1377;
function row(open: number, count = 4): Box[] {
  const boxes: Box[] = [];
  let x = 0;
  for (let index = 0; index < count; index += 1) {
    const width = index === open ? W : S;
    boxes.push({ left: x, right: x + width });
    x += width + 1;
  }
  return boxes;
}

test("opening a strip to the right moves everything between as one sheet", () => {
  const motions = planSwitch(row(0), row(2), 0, 2);
  const shift = W - S;
  assert.deepEqual(motions[0], { role: "close", edge: "right", dx: shift });
  assert.deepEqual(motions[1], { role: "band", edge: null, dx: shift });
  assert.deepEqual(motions[2], { role: "open", edge: "left", dx: shift });
  assert.deepEqual(motions[3], { role: "band", edge: null, dx: 0 });
});

test("opening a strip to the left moves the sheet the other way", () => {
  const motions = planSwitch(row(3), row(1), 3, 1);
  const shift = -(W - S);
  assert.deepEqual(motions[0], { role: "band", edge: null, dx: 0 });
  assert.deepEqual(motions[1], { role: "open", edge: "right", dx: shift });
  assert.deepEqual(motions[2], { role: "band", edge: null, dx: shift });
  assert.deepEqual(motions[3], { role: "close", edge: "left", dx: shift });
});

test("neighbours swap with no strips between them", () => {
  const motions = planSwitch(row(1), row(2), 1, 2);
  const shift = W - S;
  assert.equal(motions[1].dx, shift);
  assert.equal(motions[2].dx, shift);
  assert.equal(motions[0].dx, 0);
  assert.equal(motions[3].dx, 0);
});

test("a still slot is where its box is, a moving one is offset by its translate", () => {
  const box = { left: 100, right: 144 };
  assert.deepEqual(visibleBox(box, { role: "band", edge: null }, 0), box);
  assert.deepEqual(visibleBox(box, { role: "band", edge: null }, -30), {
    left: 70,
    right: 114,
  });
});

test("an opening or closing slot shows from its moving edge to its still one", () => {
  const box = { left: 0, right: 1377 };
  assert.deepEqual(visibleBox(box, { role: "open", edge: "left" }, 400), {
    left: 400,
    right: 1377,
  });
  assert.deepEqual(visibleBox(box, { role: "close", edge: "right" }, -400), {
    left: 0,
    right: 977,
  });
});

test("going back half way through starts from where things are on screen", () => {
  // Pane 1 to pane 3, interrupted with 40% of the travel left, then back.
  const first = planSwitch(row(0), row(2), 0, 2);
  const left = 0.4;
  const seen = row(2).map((box, index) =>
    visibleBox(box, first[index], first[index].dx * left),
  );
  const back = planSwitch(seen, row(0), 2, 0);
  const shift = W - S;
  // The travel still to go the original way is 40%, so 60% of it is undone.
  assert.equal(back[0].role, "open");
  assert.equal(back[0].edge, "right");
  assert.ok(Math.abs(back[0].dx - -(shift * (1 - left))) < 1e-9);
  assert.equal(back[2].role, "close");
  assert.equal(back[2].edge, "left");
  assert.ok(Math.abs(back[2].dx - -(shift * (1 - left))) < 1e-9);
  assert.ok(Math.abs(back[1].dx - -(shift * (1 - left))) < 1e-9);
});

test("a switch where nothing moved is still", () => {
  assert.equal(isStill(planSwitch(row(1), row(1), 1, 1)), true);
  assert.equal(isStill(planSwitch(row(0), row(2), 0, 2)), false);
});
