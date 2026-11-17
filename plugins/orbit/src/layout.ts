/**
 * Where everything sits on the map.
 *
 * Today's front desk is in the middle. Every other section is a system on an
 * ellipse round it: its hub (the section's pinned thread) at the centre, its
 * other top-level threads on rings round the hub, and child threads beside
 * their parents. Threads in no section share one system.
 *
 * The layout is worked out from the threads alone, never from chance, so a
 * thread stays where it was between redraws and only moves when the set of
 * threads changes. Sizes are in abstract units, then one scale is found that
 * fits the whole map into the space with no two systems touching.
 *
 * Pure, so it can be tested without bb.
 */

export type Role = "desk" | "hub" | "thread" | "child";

export interface LayoutThread {
  id: string;
  parentId: string | null;
  sectionId: string | null;
  pinnedAt: number | null;
  createdAt: number;
}

export interface LayoutSection {
  id: string;
  name: string;
}

export interface LayoutInput {
  threads: readonly LayoutThread[];
  /** In the order they should go round the map. */
  sections: readonly LayoutSection[];
  /** Today's front desk, which sits in the middle. */
  deskId: string | null;
  width: number;
  height: number;
}

export interface LayoutNode {
  id: string;
  role: Role;
  systemId: string;
  x: number;
  y: number;
  r: number;
  /** A child's parent. */
  anchorId: string | null;
  /** A child's distance and angle from its parent. */
  orbit: { radius: number; angle: number } | null;
  /** The angle pointing away from what it sits round, for its label. */
  out: number;
}

export interface LayoutSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  /** Everything in the system fits inside this. */
  radius: number;
  /** The radii of the rings its threads sit on. */
  rings: number[];
  hubId: string | null;
  isDesk: boolean;
  /** The angle from the middle of the map to the system. */
  out: number;
  /** Its name goes above it rather than below: the systems in the top half, so names keep clear of the middle. */
  captionAbove: boolean;
}

export interface Layout {
  width: number;
  height: number;
  scale: number;
  /** How big threads are drawn against their full size: the scale, kept within what's readable. */
  nodeScale: number;
  nodes: LayoutNode[];
  systems: LayoutSystem[];
}

/** The system for threads in no section. */
export const LOOSE_ID = "__loose__";
export const LOOSE_NAME = "No section";

// Abstract units, before the fit.
const R_DESK = 15;
const R_HUB = 11;
const R_THREAD = 7.5;
const R_CHILD = 4.5;
const R_GRANDCHILD = 3.4;
const RING_FIRST = 44;
const RING_STEP = 30;
const SLOT = 32;
const CHILD_GAP = 10;
const SYSTEM_PAD = 7;

// Pixels.
const EDGE_X = 12;
const EDGE_Y = 24;
const SYSTEM_GAP = 10;
/** Room under each system for its name. */
export const CAPTION_ROOM = 14;
const SCALE_MAX = 1.7;
const SCALE_MIN = 0.3;

interface Slot {
  thread: LayoutThread;
  ring: number;
  angle: number;
}

interface Draft {
  id: string;
  name: string;
  hub: LayoutThread | null;
  isDesk: boolean;
  slots: Slot[];
  rings: number[];
  /** How many generations sit below the hub, and below the deepest ring thread. */
  hubDepth: number;
  memberDepth: number;
}

/** Threads are drawn no smaller than this share of their size, however small the map. */
function nodeScaleFor(scale: number): number {
  return clamp(scale, 0.75, 1.3);
}

/** How far a thread's descendants reach beyond its own edge, in pixels. */
function familyReach(depth: number, nodeScale: number): number {
  let reach = 0;
  for (let level = 1; level <= depth; level += 1) {
    const r = level === 1 ? R_CHILD : R_GRANDCHILD;
    reach += ((level === 1 ? CHILD_GAP : CHILD_GAP * 0.6) + 2 * r) * nodeScale;
  }
  return reach;
}

/** The radius everything in a system fits inside at a scale, in pixels. */
function systemRadius(draft: Draft, scale: number): number {
  const nodeScale = nodeScaleFor(scale);
  const outer = draft.rings.length > 0 ? draft.rings[draft.rings.length - 1]! : 0;
  const members = draft.slots.length > 0 ? outer * scale + R_THREAD * nodeScale + familyReach(draft.memberDepth, nodeScale) : 0;
  const centre = draft.hub === null ? 0 : (draft.isDesk ? R_DESK : R_HUB) * nodeScale + familyReach(draft.hubDepth, nodeScale);
  return Math.max(members, centre, R_HUB * nodeScale) + SYSTEM_PAD + CAPTION_ROOM;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function byAge(a: LayoutThread, b: LayoutThread): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The newest pinned thread, or null. */
function newestPin(threads: readonly LayoutThread[]): LayoutThread | null {
  let best: LayoutThread | null = null;
  for (const thread of threads) {
    if (thread.pinnedAt === null) continue;
    if (best === null || thread.pinnedAt > best.pinnedAt! || (thread.pinnedAt === best.pinnedAt && thread.id > best.id)) {
      best = thread;
    }
  }
  return best;
}

/** A system's threads put on rings, in units. */
function draftSystem(
  id: string,
  name: string,
  tops: readonly LayoutThread[],
  desk: LayoutThread | null,
  depthBelow: (id: string) => number,
): Draft {
  const hub = desk ?? newestPin(tops);
  const members = tops.filter((thread) => thread.id !== hub?.id).sort(byAge);
  const slots: Slot[] = [];
  const rings: number[] = [];
  // With no hub a lone thread takes the middle, and a few share a tight ring.
  const first = hub !== null ? RING_FIRST : members.length <= 1 ? 0 : Math.max(18, (SLOT * members.length) / (2 * Math.PI));
  let placed = 0;
  for (let ring = 0; placed < members.length; ring += 1) {
    const radius = first + ring * RING_STEP;
    const capacity = radius === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * radius) / SLOT));
    const count = Math.min(capacity, members.length - placed);
    rings.push(radius);
    for (let index = 0; index < count; index += 1) {
      // Each ring starts a little further round, so threads don't line up in spokes.
      const angle = -Math.PI / 2 + ring * 0.55 + (index * 2 * Math.PI) / count;
      slots.push({ thread: members[placed + index]!, ring: radius, angle });
    }
    placed += count;
  }
  return {
    id,
    name,
    hub,
    isDesk: desk !== null,
    slots,
    rings,
    hubDepth: hub === null ? 0 : depthBelow(hub.id),
    memberDepth: members.reduce((deepest, thread) => Math.max(deepest, depthBelow(thread.id)), 0),
  };
}

// The path the systems sit on: an ellipse squared off a little, so the map
// uses the corners of a wide or tall space instead of crowding the middle.
const SQUARENESS = 2.7;

/** Points round the path at equal steps of its edge, so systems are spaced by distance, not angle. */
function pathWalker(ax: number, ay: number): (fraction: number) => { x: number; y: number } {
  const steps = 720;
  const at = (step: number) => {
    const theta = -Math.PI / 2 + (step / steps) * 2 * Math.PI;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    return {
      x: ax * Math.sign(cos) * Math.abs(cos) ** (2 / SQUARENESS),
      y: ay * Math.sign(sin) * Math.abs(sin) ** (2 / SQUARENESS),
    };
  };
  const lengths = new Array<number>(steps + 1).fill(0);
  let previous = at(0);
  for (let step = 1; step <= steps; step += 1) {
    const point = at(step);
    lengths[step] = lengths[step - 1]! + Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  const total = lengths[steps]!;
  return (fraction) => {
    const wrapped = ((fraction % 1) + 1) % 1;
    const target = wrapped * total;
    let low = 0;
    let high = steps;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lengths[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return at(low);
  };
}

interface Placed {
  draft: Draft;
  /** Pixels. */
  radius: number;
  x: number;
  y: number;
  out: number;
}

/** The systems placed at one scale, or null when they don't fit at it. */
function place(
  desk: Draft | null,
  outer: readonly Draft[],
  scale: number,
  halfWidth: number,
  halfHeight: number,
): Placed[] | null {
  const placed: Placed[] = [];
  if (desk !== null) {
    const radius = systemRadius(desk, scale);
    if (radius > Math.min(halfWidth, halfHeight)) return null;
    placed.push({ draft: desk, radius, x: 0, y: 0, out: Math.PI / 2 });
  }
  if (outer.length === 0) return placed;
  // One system and no desk: it takes the middle.
  if (desk === null && outer.length === 1) {
    const only = outer[0]!;
    const radius = systemRadius(only, scale);
    if (radius > Math.min(halfWidth, halfHeight)) return null;
    return [{ draft: only, radius, x: 0, y: 0, out: Math.PI / 2 }];
  }
  const radii = outer.map((draft) => systemRadius(draft, scale));
  const largest = Math.max(...radii);
  const ax = halfWidth - largest;
  const ay = halfHeight - largest;
  if (ax < 8 || ay < 8) return null;
  const walk = pathWalker(ax, ay);
  const weights = radii.map((radius) => radius + SYSTEM_GAP / 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let before = -weights[0]! / 2;
  for (let index = 0; index < outer.length; index += 1) {
    const point = walk((before + weights[index]! / 2) / total);
    before += weights[index]!;
    placed.push({ draft: outer[index]!, radius: radii[index]!, x: point.x, y: point.y, out: Math.atan2(point.y, point.x) });
  }
  for (let a = 0; a < placed.length; a += 1) {
    const one = placed[a]!;
    if (Math.abs(one.x) + one.radius > halfWidth + 0.5) return null;
    if (Math.abs(one.y) + one.radius > halfHeight + 0.5) return null;
    for (let b = a + 1; b < placed.length; b += 1) {
      const other = placed[b]!;
      const distance = Math.hypot(one.x - other.x, one.y - other.y);
      if (distance < one.radius + other.radius + SYSTEM_GAP) return null;
    }
  }
  return placed;
}

export function buildLayout(input: LayoutInput): Layout {
  const width = Math.max(1, input.width);
  const height = Math.max(1, input.height);
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  const childrenOf = new Map<string, LayoutThread[]>();
  const tops: LayoutThread[] = [];
  for (const thread of input.threads) {
    const parent = thread.parentId !== null && thread.parentId !== thread.id ? byId.get(thread.parentId) : undefined;
    if (parent === undefined) {
      tops.push(thread);
    } else {
      const list = childrenOf.get(parent.id) ?? [];
      list.push(thread);
      childrenOf.set(parent.id, list);
    }
  }
  // A loop of parents (never seen, but nothing rules it out) would hide its
  // threads: anything no top-level thread leads to is treated as top-level.
  const reached = new Set<string>();
  const visit = (thread: LayoutThread) => {
    if (reached.has(thread.id)) return;
    reached.add(thread.id);
    for (const child of childrenOf.get(thread.id) ?? []) visit(child);
  };
  for (const thread of tops) visit(thread);
  for (const thread of input.threads) {
    if (reached.has(thread.id)) continue;
    const siblings = childrenOf.get(thread.parentId ?? "") ?? [];
    childrenOf.set(thread.parentId ?? "", siblings.filter((other) => other.id !== thread.id));
    tops.push(thread);
    visit(thread);
  }
  for (const list of childrenOf.values()) list.sort(byAge);
  // Children are drawn three generations down; anything deeper isn't.
  const depthBelow = (id: string, level: number = 1): number => {
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0 || level > 3) return 0;
    return 1 + Math.max(...children.map((child) => depthBelow(child.id, level + 1)));
  };

  const deskThread = input.deskId === null ? null : (tops.find((thread) => thread.id === input.deskId) ?? null);
  const names = new Map(input.sections.map((section) => [section.id, section.name]));
  const groups = new Map<string, LayoutThread[]>();
  for (const thread of tops) {
    const key = thread.sectionId !== null && names.has(thread.sectionId) ? thread.sectionId : LOOSE_ID;
    const list = groups.get(key) ?? [];
    list.push(thread);
    groups.set(key, list);
  }
  const order = [...input.sections.map((section) => section.id), LOOSE_ID].filter((id) => groups.has(id));
  const deskSystemId =
    deskThread === null ? null : deskThread.sectionId !== null && names.has(deskThread.sectionId) ? deskThread.sectionId : LOOSE_ID;

  let desk: Draft | null = null;
  const outer: Draft[] = [];
  for (const id of order) {
    const name = id === LOOSE_ID ? LOOSE_NAME : (names.get(id) ?? id);
    const isDesk = id === deskSystemId;
    const draft = draftSystem(id, name, groups.get(id)!, isDesk ? deskThread : null, depthBelow);
    if (isDesk) desk = draft;
    else outer.push(draft);
  }

  const halfWidth = Math.max(8, width / 2 - EDGE_X);
  const halfHeight = Math.max(8, height / 2 - EDGE_Y);
  let scale = SCALE_MAX;
  let placed: Placed[] | null = null;
  for (; scale >= SCALE_MIN; scale *= 0.95) {
    placed = place(desk, outer, scale, halfWidth, halfHeight);
    if (placed !== null) break;
  }
  if (placed === null) {
    // Too much for the space: draw it at the smallest scale anyway, on a ring that fits.
    scale = SCALE_MIN;
    placed = [];
    if (desk !== null) placed.push({ draft: desk, radius: systemRadius(desk, scale), x: 0, y: 0, out: Math.PI / 2 });
    const walk = pathWalker(halfWidth * 0.8, halfHeight * 0.8);
    outer.forEach((draft, index) => {
      const point = walk(index / Math.max(1, outer.length));
      placed!.push({ draft, radius: systemRadius(draft, scale), x: point.x, y: point.y, out: Math.atan2(point.y, point.x) });
    });
  }

  const nodeScale = nodeScaleFor(scale);
  const cx = width / 2;
  const cy = height / 2;
  const nodes: LayoutNode[] = [];
  const systems: LayoutSystem[] = [];

  const addChildren = (parent: LayoutNode, systemId: string, around: boolean, depth: number) => {
    const children = childrenOf.get(parent.id) ?? [];
    if (children.length === 0) return;
    const r = (depth === 1 ? R_CHILD : R_GRANDCHILD) * nodeScale;
    const reach = parent.r + (depth === 1 ? CHILD_GAP : CHILD_GAP * 0.6) * nodeScale + r;
    // Round a hub: all the way round. Beside a thread on a ring: a fan on its outer side.
    const step = around ? (2 * Math.PI) / children.length : Math.min(0.9, 2.4 / children.length);
    children.forEach((child, index) => {
      const angle = around
        ? parent.out + Math.PI / children.length + index * step
        : parent.out + (index - (children.length - 1) / 2) * step;
      const node: LayoutNode = {
        id: child.id,
        role: "child",
        systemId,
        x: parent.x + reach * Math.cos(angle),
        y: parent.y + reach * Math.sin(angle),
        r,
        anchorId: parent.id,
        orbit: { radius: reach, angle },
        out: angle,
      };
      nodes.push(node);
      if (depth < 3) addChildren(node, systemId, false, depth + 1);
    });
  };

  for (const { draft, radius, x, y, out } of placed) {
    const sx = cx + x;
    const sy = cy + y;
    systems.push({
      id: draft.id,
      name: draft.name,
      x: sx,
      y: sy,
      radius,
      rings: draft.rings.filter((ring) => ring > 0).map((ring) => ring * scale),
      hubId: draft.hub?.id ?? null,
      isDesk: draft.isDesk,
      out,
      captionAbove: !draft.isDesk && y < -radius * 0.5,
    });
    if (draft.hub !== null) {
      const hub: LayoutNode = {
        id: draft.hub.id,
        role: draft.isDesk ? "desk" : "hub",
        systemId: draft.id,
        x: sx,
        y: sy,
        r: (draft.isDesk ? R_DESK : R_HUB) * nodeScale,
        anchorId: null,
        orbit: null,
        out: draft.isDesk ? Math.PI / 2 : out,
      };
      nodes.push(hub);
      addChildren(hub, draft.id, true, 1);
    }
    for (const slot of draft.slots) {
      const node: LayoutNode = {
        id: slot.thread.id,
        role: "thread",
        systemId: draft.id,
        x: sx + slot.ring * scale * Math.cos(slot.angle),
        y: sy + slot.ring * scale * Math.sin(slot.angle),
        r: R_THREAD * nodeScale,
        anchorId: null,
        orbit: null,
        out: slot.ring === 0 ? out : slot.angle,
      };
      nodes.push(node);
      addChildren(node, draft.id, false, 1);
    }
  }
  return { width, height, scale, nodeScale, nodes, systems };
}
