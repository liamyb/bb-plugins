import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLayout, LOOSE_ID, type LayoutInput, type LayoutThread } from "./layout.ts";

let clock = 0;
function thread(id: string, sectionId: string | null, extra: Partial<LayoutThread> = {}): LayoutThread {
  clock += 1;
  return { id, parentId: null, sectionId, pinnedAt: null, createdAt: clock, ...extra };
}

const sections = [
  { id: "sec_desk", name: "Front desk" },
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: "Beta" },
  { id: "sec_c", name: "Gamma" },
];

function sample(): LayoutThread[] {
  return [
    thread("desk", "sec_desk", { pinnedAt: 5 }),
    thread("desk-old", "sec_desk"),
    thread("a-hub", "sec_a", { pinnedAt: 9 }),
    thread("a-old-pin", "sec_a", { pinnedAt: 2 }),
    thread("a-1", "sec_a"),
    thread("a-2", "sec_a"),
    thread("a-1-kid", "sec_b", { parentId: "a-1" }),
    thread("a-1-grandkid", null, { parentId: "a-1-kid" }),
    thread("a-hub-kid", "sec_a", { parentId: "a-hub" }),
    thread("b-1", "sec_b"),
    thread("b-2", "sec_b"),
    thread("b-3", "sec_b"),
    thread("c-only", "sec_c"),
    thread("loose-1", null),
    thread("orphan", "sec_gone", { parentId: "thr_archived" }),
  ];
}

function input(width: number, height: number, threads = sample()): LayoutInput {
  return { threads, sections, deskId: "desk", width, height };
}

test("the desk sits in the middle and every section is a system round it", () => {
  const layout = buildLayout(input(1000, 700));
  const desk = layout.nodes.find((node) => node.id === "desk")!;
  assert.equal(desk.role, "desk");
  assert.equal(Math.round(desk.x), 500);
  assert.equal(Math.round(desk.y), 350);
  assert.deepEqual(layout.systems.map((system) => system.id).sort(), ["sec_a", "sec_b", "sec_c", "sec_desk", LOOSE_ID].sort());
  assert.equal(layout.systems.find((system) => system.isDesk)!.id, "sec_desk");
  assert.equal(layout.nodes.length, 15);
});

test("the newest pin is the hub, at its system's centre", () => {
  const layout = buildLayout(input(1000, 700));
  const system = layout.systems.find((entry) => entry.id === "sec_a")!;
  assert.equal(system.hubId, "a-hub");
  const hub = layout.nodes.find((node) => node.id === "a-hub")!;
  assert.equal(hub.role, "hub");
  assert.equal(hub.x, system.x);
  assert.equal(layout.nodes.find((node) => node.id === "a-old-pin")!.role, "thread");
  assert.equal(layout.systems.find((entry) => entry.id === "sec_b")!.hubId, null);
});

test("a child sits beside its parent, in its parent's system, whatever its own section", () => {
  const layout = buildLayout(input(1000, 700));
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const kid = byId.get("a-1-kid")!;
  const parent = byId.get("a-1")!;
  assert.equal(kid.role, "child");
  assert.equal(kid.systemId, "sec_a");
  assert.equal(kid.anchorId, "a-1");
  const distance = Math.hypot(kid.x - parent.x, kid.y - parent.y);
  assert.ok(Math.abs(distance - kid.orbit!.radius) < 0.001);
  assert.ok(distance < 40);
  const grandkid = byId.get("a-1-grandkid")!;
  assert.equal(grandkid.anchorId, "a-1-kid");
  assert.equal(grandkid.systemId, "sec_a");
  assert.equal(byId.get("a-hub-kid")!.anchorId, "a-hub");
});

test("a thread whose parent isn't on the map is top-level, and an unknown section is no section", () => {
  const layout = buildLayout(input(1000, 700));
  const orphan = layout.nodes.find((node) => node.id === "orphan")!;
  assert.equal(orphan.role, "thread");
  assert.equal(orphan.systemId, LOOSE_ID);
});

for (const [width, height] of [
  [1100, 760],
  [480, 480],
  [420, 700],
  [1400, 420],
] as const) {
  test(`at ${width}x${height} everything is inside the map and no two systems touch`, () => {
    const layout = buildLayout(input(width, height));
    for (const node of layout.nodes) {
      assert.ok(node.x - node.r >= 0 && node.x + node.r <= width, `${node.id} x ${node.x}`);
      assert.ok(node.y - node.r >= 0 && node.y + node.r <= height, `${node.id} y ${node.y}`);
    }
    for (const system of layout.systems) {
      assert.ok(system.x - system.radius >= 0 && system.x + system.radius <= width, `${system.id} x`);
      assert.ok(system.y - system.radius >= 0 && system.y + system.radius <= height, `${system.id} y`);
      const inside = layout.nodes.filter((node) => node.systemId === system.id);
      for (const node of inside) {
        const reach = Math.hypot(node.x - system.x, node.y - system.y) + node.r;
        assert.ok(reach <= system.radius + 0.5, `${node.id} reaches ${reach} of ${system.radius}`);
      }
    }
    for (let a = 0; a < layout.systems.length; a += 1) {
      for (let b = a + 1; b < layout.systems.length; b += 1) {
        const one = layout.systems[a]!;
        const other = layout.systems[b]!;
        const gap = Math.hypot(one.x - other.x, one.y - other.y) - one.radius - other.radius;
        assert.ok(gap >= 9.5, `${one.id} and ${other.id} are ${gap} apart`);
      }
    }
  });
}

test("no two threads overlap", () => {
  const layout = buildLayout(input(1100, 760));
  for (let a = 0; a < layout.nodes.length; a += 1) {
    for (let b = a + 1; b < layout.nodes.length; b += 1) {
      const one = layout.nodes[a]!;
      const other = layout.nodes[b]!;
      const gap = Math.hypot(one.x - other.x, one.y - other.y) - one.r - other.r;
      assert.ok(gap > 0, `${one.id} and ${other.id} overlap by ${-gap}`);
    }
  }
});

test("the same threads give the same map, in any order", () => {
  const threads = sample();
  const first = buildLayout(input(900, 600, threads));
  const second = buildLayout(input(900, 600, [...threads].reverse()));
  const place = (layout: typeof first) =>
    Object.fromEntries(layout.nodes.map((node) => [node.id, [Math.round(node.x * 100), Math.round(node.y * 100)]]));
  assert.deepEqual(place(first), place(second));
});

test("with no desk, the systems still go round, and one system alone takes the middle", () => {
  const threads = sample().filter((entry) => entry.sectionId !== "sec_desk");
  const round = buildLayout({ ...input(900, 600, threads), deskId: null });
  assert.equal(round.systems.some((system) => system.isDesk), false);
  assert.equal(round.nodes.length, threads.length);
  const alone = buildLayout({ ...input(900, 600, [thread("solo", "sec_c"), thread("solo-2", "sec_c")]), deskId: null });
  assert.equal(alone.systems.length, 1);
  assert.equal(Math.round(alone.systems[0]!.x), 450);
});

test("a full section spills onto a second ring", () => {
  const many: LayoutThread[] = [thread("desk", "sec_desk", { pinnedAt: 1 }), thread("hub", "sec_a", { pinnedAt: 1 })];
  for (let index = 0; index < 14; index += 1) many.push(thread(`t-${index}`, "sec_a"));
  const layout = buildLayout(input(1000, 800, many));
  const system = layout.systems.find((entry) => entry.id === "sec_a")!;
  assert.equal(system.rings.length, 2);
  assert.equal(layout.nodes.filter((node) => node.systemId === "sec_a").length, 15);
});

test("nothing to draw is an empty map, and a loop of parents still shows", () => {
  assert.deepEqual(buildLayout({ threads: [], sections, deskId: null, width: 0, height: 0 }).nodes, []);
  const loop = [thread("x", "sec_a", { parentId: "y" }), thread("y", "sec_a", { parentId: "x" })];
  const layout = buildLayout({ ...input(600, 400, loop), deskId: null });
  assert.equal(layout.nodes.length, 2);
});
