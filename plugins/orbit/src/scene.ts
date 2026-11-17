/**
 * The map's drawing: one canvas, redrawn only while something on it moves.
 *
 * Every movement means something. A thread that's working glows and turns; a
 * tool call sends a ripple out from it with the tool's name; a hand-off flies
 * from one thread to another as a comet; a thread asking you pings. With
 * nothing working, asking or in flight, the loop stops and the canvas is
 * redrawn only when the data changes.
 *
 * Colours and type come in as a palette read from the theme (app.tsx), so
 * nothing here knows which theme is on.
 */

import { CAPTION_ROOM, type Role } from "./layout.ts";
import type { NodeState } from "./model.ts";

export type Rgb = readonly [number, number, number];

export interface Palette {
  surface: Rgb;
  /** The lit colour: working threads, rings, captions. */
  ink: Rgb;
  /** The unlit colour: idle threads, orbit lines. */
  dim: Rgb;
  /** Labels. */
  text: Rgb;
  ask: Rgb;
  error: Rgb;
  /** Hand-offs between threads. */
  accent: Rgb;
  /** A dark surface, where a glow adds light. */
  dark: boolean;
  /** An LCD skin: pixel type that glows. */
  lcd: boolean;
  font: string;
  fontSize: number;
}

export interface SceneNode {
  id: string;
  role: Role;
  systemId: string;
  x: number;
  y: number;
  r: number;
  anchorId: string | null;
  orbit: { radius: number; angle: number } | null;
  out: number;
  state: NodeState;
  label: string;
  /** Context window used, 0 to 1, or null when it isn't known. */
  fill: number | null;
  /** Background agents, commands and workflows still running. */
  satellites: number;
  /** Whether its name shows without hovering. */
  labelled: boolean;
}

export interface SceneSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  rings: number[];
  isDesk: boolean;
  captionAbove: boolean;
  working: number;
  total: number;
}

export interface SceneArc {
  key: string;
  from: string;
  to: string;
  at: number;
  kind: "tell" | "report";
}

export interface SceneData {
  width: number;
  height: number;
  /** How big threads are drawn against their full size; the rings round them keep in step. */
  unit: number;
  nodes: SceneNode[];
  systems: SceneSystem[];
  /** Recent hand-offs. */
  arcs: SceneArc[];
  /** Today's desk asks: how many went to each thread. */
  spokes: { to: string; count: number }[];
  deskId: string | null;
}

export interface SceneCallbacks {
  onHover(id: string | null, x: number, y: number): void;
  onOpen(id: string, split: boolean): void;
}

export type Tone = "ink" | "text" | "accent" | "ask" | "error";

interface Live {
  x: number;
  y: number;
  born: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The area two boxes share. */
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

interface Ripple {
  id: string;
  t0: number;
  label: string;
  tone: Tone;
  small: boolean;
  /** Which way its word drifts, chosen when it's first drawn. */
  way?: [number, number];
}

interface Comet {
  from: string;
  to: string;
  t0: number;
  duration: number;
  tone: Tone;
}

const TAU = Math.PI * 2;
const RIPPLE_MS = 1100;
const BIRTH_MS = 450;
const ARC_FADE_MS = 45 * 60 * 1000;
const FAMILY_SPIN = 0.32; // radians a second, while a child is working
const SLOW_TICK_MS = 20_000;

function rgba(colour: Rgb, alpha: number): string {
  return `rgba(${colour[0]},${colour[1]},${colour[2]},${Math.max(0, Math.min(1, alpha))})`;
}

function unit(t: number): number {
  return Math.max(0, Math.min(1, t));
}

function easeOut(t: number): number {
  return 1 - (1 - unit(t)) ** 3;
}

function easeInOut(t: number): number {
  const u = unit(t);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

export class Scene {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: SceneCallbacks;
  private data: SceneData | null = null;
  private palette: Palette | null = null;
  private dpr = 1;
  private readonly live = new Map<string, Live>();
  private readonly spin = new Map<string, number>();
  /** Which side of its thread each name was last drawn on. */
  private readonly sides = new Map<string, number>();
  /** Everything with a place last frame (names, threads, captions), so a ripple's word keeps off it. */
  private crowd: Box[] = [];
  private ripples: Ripple[] = [];
  private comets: Comet[] = [];
  private hover: string | null = null;
  private still = false;
  private frame = 0;
  private slow = 0;
  private last = 0;
  /** The map's own clock, in milliseconds of frames drawn. */
  private time = 0;
  private settled = false;
  private grid: CanvasPattern | null = null;
  private destroyed = false;
  private failed = false;

  constructor(canvas: HTMLCanvasElement, callbacks: SceneCallbacks) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Orbit: this browser has no 2D canvas.");
    this.ctx = ctx;
    this.callbacks = callbacks;
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerleave", this.onLeave);
    canvas.addEventListener("click", this.onClick);
    document.addEventListener("visibilitychange", this.onVisibility);
    // Hand-offs fade with age: a slow redraw keeps them honest while nothing else moves.
    this.slow = window.setInterval(() => this.request(), SLOW_TICK_MS);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    window.clearInterval(this.slow);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("click", this.onClick);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  setData(data: SceneData): void {
    const resized = this.data === null || this.data.width !== data.width || this.data.height !== data.height;
    this.data = data;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (resized || dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(data.width * dpr));
      this.canvas.height = Math.max(1, Math.round(data.height * dpr));
    }
    const now = this.time;
    const ids = new Set(data.nodes.map((node) => node.id));
    for (const id of this.live.keys()) if (!ids.has(id)) this.live.delete(id);
    for (const id of this.spin.keys()) if (!ids.has(id)) this.spin.delete(id);
    const first = this.live.size === 0;
    for (const node of data.nodes) {
      const at = this.live.get(node.id);
      if (at === undefined) {
        // The first draw has everything in place; after that a new thread grows in.
        this.live.set(node.id, { x: node.x, y: node.y, born: first ? -Infinity : now });
      } else if (resized) {
        // A new size is a new map, not movement: nothing swims across while the window is dragged.
        at.x = node.x;
        at.y = node.y;
      }
    }
    if (this.hover !== null && !ids.has(this.hover)) this.setHover(null, 0, 0);
    this.settled = false;
    this.request();
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    this.grid = null;
    this.request();
  }

  /** Draw still: no loop, no ripples or comets. */
  setStill(still: boolean): void {
    if (this.still === still) return;
    this.still = still;
    if (still) {
      this.ripples = [];
      this.comets = [];
    }
    this.request();
  }

  /** A ring out from a thread, with a word rising from it. */
  ripple(id: string, label: string, tone: Tone = "ink", small = false): void {
    if (this.still || document.visibilityState !== "visible" || !this.live.has(id)) return;
    const now = this.time;
    const mine = this.ripples.filter((ripple) => ripple.id === id);
    if (mine.length >= 4) return;
    // Two words on top of each other can't be read: the second goes without.
    const crowded = mine.some((ripple) => ripple.label.length > 0 && now - ripple.t0 < 320);
    this.ripples.push({ id, t0: now, label: crowded ? "" : label, tone, small });
    this.request();
  }

  /** Something flying from one thread to another. */
  comet(from: string, to: string, tone: Tone = "accent"): void {
    if (this.still || document.visibilityState !== "visible") return;
    const a = this.live.get(from);
    const b = this.live.get(to);
    if (a === undefined || b === undefined || this.comets.length >= 24) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    this.comets.push({ from, to, t0: this.time, duration: 900 + distance * 1.6, tone });
    this.request();
  }

  /** The thread under a point, or null. */
  hit(x: number, y: number): string | null {
    if (this.data === null) return null;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const node of this.data.nodes) {
      const at = this.live.get(node.id);
      if (at === undefined) continue;
      const distance = Math.hypot(at.x - x, at.y - y);
      if (distance <= Math.max(node.r + 6, 11) && distance < bestDistance) {
        best = node.id;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Where a thread is drawn now, for a tooltip. */
  position(id: string): { x: number; y: number } | null {
    const at = this.live.get(id);
    return at === undefined ? null : { x: at.x, y: at.y };
  }

  private readonly onMove = (event: PointerEvent) => {
    const box = this.canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    this.setHover(this.hit(x, y), x, y);
  };

  private readonly onLeave = () => this.setHover(null, 0, 0);

  private readonly onClick = (event: MouseEvent) => {
    const box = this.canvas.getBoundingClientRect();
    const id = this.hit(event.clientX - box.left, event.clientY - box.top);
    if (id !== null) this.callbacks.onOpen(id, event.metaKey || event.ctrlKey);
  };

  private readonly onVisibility = () => {
    if (document.visibilityState === "visible") this.request();
  };

  private setHover(id: string | null, x: number, y: number): void {
    if (id !== this.hover) {
      this.hover = id;
      this.canvas.style.cursor = id === null ? "default" : "pointer";
      this.request();
    }
    this.callbacks.onHover(id, x, y);
  }

  private request(): void {
    if (this.destroyed || this.frame !== 0) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = () => {
    this.frame = 0;
    if (this.destroyed || this.data === null || this.palette === null) return;
    if (document.visibilityState !== "visible") return;
    // The map keeps its own clock, moved on by the gap between frames: a
    // ripple is stamped with it too, so nothing depends on two clocks agreeing,
    // and nothing jumps after the loop has been stopped for a while.
    const stamp = performance.now();
    const dt = this.last === 0 ? 16 : Math.max(0, Math.min(64, stamp - this.last));
    this.last = stamp;
    this.time += dt;
    let moving = false;
    try {
      moving = this.advance(this.time, dt);
      this.draw(this.time);
    } catch (error) {
      // A frame that can't be drawn mustn't take the page down or spin: say so once and wait for new data.
      if (!this.failed) console.error("Orbit: the map couldn't be drawn.", error);
      this.failed = true;
      moving = false;
    }
    if (moving) this.request();
    else this.last = 0;
  };

  /** Move everything on by `dt`. Returns whether anything is still moving. */
  private advance(now: number, dt: number): boolean {
    const data = this.data!;
    let moving = false;
    const byId = new Map(data.nodes.map((node) => [node.id, node]));
    // A family turns round its parent while any child in it works.
    const turning = new Set<string>();
    for (const node of data.nodes) {
      if (node.anchorId !== null && node.state === "working") turning.add(node.anchorId);
    }
    if (!this.still) {
      for (const parent of turning) {
        this.spin.set(parent, (this.spin.get(parent) ?? 0) + (FAMILY_SPIN * dt) / 1000);
        moving = true;
      }
    }
    const ease = this.settled ? 1 : 1 - Math.exp(-dt / 150);
    let unsettled = false;
    // Parents come before their children in the layout, so a parent has moved first.
    for (const node of data.nodes) {
      const at = this.live.get(node.id)!;
      let tx = node.x;
      let ty = node.y;
      if (node.anchorId !== null && node.orbit !== null) {
        const parent = this.live.get(node.anchorId);
        const drawn = byId.get(node.anchorId);
        if (parent !== undefined && drawn !== undefined) {
          const angle = node.orbit.angle + (this.spin.get(node.anchorId) ?? 0);
          tx = parent.x + node.orbit.radius * Math.cos(angle);
          ty = parent.y + node.orbit.radius * Math.sin(angle);
        }
      }
      if (this.still || Math.hypot(tx - at.x, ty - at.y) < 0.4) {
        at.x = tx;
        at.y = ty;
      } else {
        at.x += (tx - at.x) * ease;
        at.y += (ty - at.y) * ease;
        unsettled = true;
      }
      if (now - at.born < BIRTH_MS) unsettled = true;
      if (!this.still && (node.state === "working" || node.state === "asking" || node.satellites > 0)) moving = true;
    }
    this.settled = !unsettled && turning.size === 0;
    this.ripples = this.ripples.filter((ripple) => now - ripple.t0 < RIPPLE_MS);
    const landed = this.comets.filter((comet) => now - comet.t0 >= comet.duration);
    this.comets = this.comets.filter((comet) => now - comet.t0 < comet.duration);
    for (const comet of landed) this.ripples.push({ id: comet.to, t0: now, label: "", tone: comet.tone, small: false });
    return moving || unsettled || this.ripples.length > 0 || this.comets.length > 0;
  }

  private tone(tone: Tone): Rgb {
    const palette = this.palette!;
    return palette[tone];
  }

  private gridPattern(): CanvasPattern | null {
    if (this.grid !== null) return this.grid;
    const palette = this.palette!;
    const tile = document.createElement("canvas");
    const size = 22;
    tile.width = size * this.dpr;
    tile.height = size * this.dpr;
    const ctx = tile.getContext("2d");
    if (ctx === null) return null;
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = rgba(palette.dim, palette.dark ? 0.2 : 0.16);
    ctx.fillRect(size / 2 - 0.5, size / 2 - 0.5, 1, 1);
    const pattern = this.ctx.createPattern(tile, "repeat");
    if (pattern !== null) pattern.setTransform(new DOMMatrix().scale(1 / this.dpr));
    this.grid = pattern;
    return pattern;
  }

  /** The curve a hand-off takes: bowed towards the middle of the map, or sideways between neighbours. */
  private curve(a: Live, b: Live): { cx: number; cy: number } {
    const data = this.data!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const towardsX = data.width / 2 - mx;
    const towardsY = data.height / 2 - my;
    const far = Math.hypot(towardsX, towardsY);
    if (far > distance * 0.35) return { cx: mx + towardsX * 0.4, cy: my + towardsY * 0.4 };
    // Close to the middle already: bow at a right angle instead.
    return { cx: mx - (b.y - a.y) * 0.22, cy: my + (b.x - a.x) * 0.22 };
  }

  private setFont(size: number, weight = 400): void {
    this.ctx.font = `${weight} ${size}px ${this.palette!.font}`;
  }

  private fit(text: string, width: number): string {
    const ctx = this.ctx;
    if (ctx.measureText(text).width <= width) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
  }

  /** Text with a rim of the surface colour behind it, so it reads over lines and rings. */
  private write(text: string, x: number, y: number, colour: string, glow: boolean): void {
    const ctx = this.ctx;
    const palette = this.palette!;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(palette.surface, 0.85);
    ctx.strokeText(text, x, y);
    if (glow && palette.lcd) {
      ctx.shadowColor = rgba(palette.ink, 0.6);
      ctx.shadowBlur = 5;
    }
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    const data = this.data!;
    const palette = this.palette!;
    const { width, height } = data;
    const wall = Date.now();
    const seconds = now / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgba(palette.surface, 1);
    ctx.fillRect(0, 0, width, height);
    const grid = this.gridPattern();
    if (grid !== null) {
      ctx.fillStyle = grid;
      ctx.fillRect(0, 0, width, height);
    }
    const nodes = new Map(data.nodes.map((node) => [node.id, node]));
    const u = data.unit;
    const caption = Math.max(9, Math.round(palette.fontSize * 0.86));
    // What a thread's name must keep clear of: the systems' names, then the threads, then names already placed.
    const taken: Box[] = [];

    // Systems: the rings threads sit on, and each one's name beneath it.
    for (const system of data.systems) {
      ctx.lineWidth = 1;
      for (const ring of system.rings) {
        ctx.strokeStyle = rgba(palette.dim, system.working > 0 ? 0.42 : 0.26);
        ctx.beginPath();
        ctx.arc(system.x, system.y, ring, 0, TAU);
        ctx.stroke();
      }
      this.setFont(caption, 600);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const spacing = palette.lcd ? 0 : 0.8;
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`;
      const count = system.working > 0 ? `${system.working}/${system.total}` : String(system.total);
      const room = Math.max(84, system.radius * 2 + 28);
      const name = this.fit(system.name.toUpperCase(), room - ctx.measureText(`  ${count}`).width);
      const line = `${name}  ${count}`;
      const half = ctx.measureText(line).width / 2;
      const x = Math.min(width - half - 6, Math.max(half + 6, system.x));
      const y = system.captionAbove
        ? Math.max(caption + 3, system.y - system.radius + CAPTION_ROOM - 3)
        : Math.min(height - 5, system.y + system.radius - CAPTION_ROOM + caption + 1);
      this.write(line, x, y, rgba(system.working > 0 ? palette.ink : palette.dim, system.working > 0 ? 1 : 0.95), system.working > 0);
      taken.push({ x: x - half - 3, y: y - caption - 1, w: half * 2 + 6, h: caption + 5 });
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
    }

    // Today's desk asks: a dotted line from the desk to each thread one went to.
    const desk = data.deskId === null ? undefined : this.live.get(data.deskId);
    if (desk !== undefined) {
      ctx.setLineDash([1.5, 5]);
      ctx.lineCap = "round";
      for (const spoke of data.spokes) {
        const to = this.live.get(spoke.to);
        if (to === undefined || spoke.to === data.deskId) continue;
        ctx.strokeStyle = rgba(palette.text, 0.14 + 0.05 * Math.min(4, spoke.count));
        ctx.lineWidth = 1 + 0.25 * Math.min(4, spoke.count - 1);
        ctx.beginPath();
        ctx.moveTo(desk.x, desk.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
    }

    // A child's tie to its parent.
    ctx.lineWidth = 1;
    for (const node of data.nodes) {
      if (node.anchorId === null) continue;
      const a = this.live.get(node.id);
      const b = this.live.get(node.anchorId);
      if (a === undefined || b === undefined) continue;
      ctx.strokeStyle = rgba(node.state === "working" ? palette.ink : palette.dim, node.state === "working" ? 0.55 : 0.4);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Recent hand-offs, fading as they age.
    for (const arc of data.arcs) {
      if (arc.kind !== "tell") continue;
      const a = this.live.get(arc.from);
      const b = this.live.get(arc.to);
      if (a === undefined || b === undefined) continue;
      const age = (wall - arc.at) / ARC_FADE_MS;
      if (age >= 1) continue;
      const { cx, cy } = this.curve(a, b);
      ctx.strokeStyle = rgba(palette.accent, 0.12 + 0.5 * (1 - age) ** 2);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
    }

    // Comets in flight.
    for (const comet of this.comets) {
      const a = this.live.get(comet.from);
      const b = this.live.get(comet.to);
      if (a === undefined || b === undefined) continue;
      const colour = this.tone(comet.tone);
      const straight = comet.from === data.deskId || nodes.get(comet.from)?.anchorId === comet.to;
      const { cx, cy } = straight ? { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 } : this.curve(a, b);
      const head = easeInOut((now - comet.t0) / comet.duration);
      const point = (u: number) => {
        const v = 1 - u;
        return { x: v * v * a.x + 2 * v * u * cx + u * u * b.x, y: v * v * a.y + 2 * v * u * cy + u * u * b.y };
      };
      if (palette.dark) ctx.globalCompositeOperation = "lighter";
      for (let step = 14; step >= 0; step -= 1) {
        const u = head - step * 0.014;
        if (u < 0) continue;
        const at = point(u);
        const share = 1 - step / 15;
        ctx.fillStyle = rgba(colour, 0.08 + 0.75 * share * share);
        ctx.beginPath();
        ctx.arc(at.x, at.y, 0.8 + 2.4 * share, 0, TAU);
        ctx.fill();
      }
      const at = point(head);
      const glow = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 13);
      glow.addColorStop(0, rgba(colour, palette.dark ? 0.55 : 0.4));
      glow.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(at.x, at.y, 13, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }

    // Threads.
    for (const node of data.nodes) {
      const at = this.live.get(node.id);
      if (at === undefined) continue;
      const age = now - at.born;
      const grow = age >= BIRTH_MS ? 1 : easeOut(age / BIRTH_MS);
      const r = node.r * grow;
      if (r <= 0.2) continue;
      const colour =
        node.state === "asking" ? palette.ask : node.state === "error" ? palette.error : node.state === "idle" ? palette.dim : palette.ink;
      const hovered = this.hover === node.id;

      if (node.state === "working") {
        const breath = this.still ? 0.5 : 0.5 + 0.5 * Math.sin(seconds * 2.2 + node.x * 0.05);
        const reach = r * (2.5 + 0.5 * breath) + 5 * u;
        const halo = ctx.createRadialGradient(at.x, at.y, r * 0.6, at.x, at.y, reach);
        halo.addColorStop(0, rgba(palette.ink, (palette.dark ? 0.36 : 0.26) + 0.1 * breath));
        halo.addColorStop(1, rgba(palette.ink, 0));
        if (palette.dark) ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(at.x, at.y, reach, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }

      if (node.state === "asking" && !this.still) {
        for (const offset of [0, 0.5]) {
          const phase = (seconds / 1.9 + offset) % 1;
          ctx.strokeStyle = rgba(palette.ask, 0.7 * (1 - phase));
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(at.x, at.y, r + 3 * u + phase * 22 * u, 0, TAU);
          ctx.stroke();
        }
      }

      // The anchors are marked: the desk with ticks and a second ring, a hub with a second ring.
      if (node.role === "desk" || node.role === "hub") {
        ctx.strokeStyle = rgba(node.state === "idle" ? palette.dim : colour, 0.75);
        ctx.lineWidth = 1;
        const outer = r + (node.role === "desk" ? 7.5 : 6.5) * u;
        ctx.beginPath();
        ctx.arc(at.x, at.y, outer, 0, TAU);
        ctx.stroke();
        if (node.role === "desk") {
          for (let tick = 0; tick < 4; tick += 1) {
            const angle = (tick * TAU) / 4;
            ctx.beginPath();
            ctx.moveTo(at.x + Math.cos(angle) * (outer + 2 * u), at.y + Math.sin(angle) * (outer + 2 * u));
            ctx.lineTo(at.x + Math.cos(angle) * (outer + 6 * u), at.y + Math.sin(angle) * (outer + 6 * u));
            ctx.stroke();
          }
        }
      }

      // The body: hollow when idle, half-lit with a reply you haven't read, lit otherwise.
      ctx.beginPath();
      ctx.arc(at.x, at.y, r, 0, TAU);
      if (node.state === "idle") {
        ctx.fillStyle = rgba(palette.surface, 1);
        ctx.fill();
        ctx.fillStyle = rgba(palette.dim, 0.2);
        ctx.fill();
        ctx.strokeStyle = rgba(palette.dim, 0.95);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      } else {
        ctx.fillStyle = rgba(palette.surface, 1);
        ctx.fill();
        ctx.fillStyle = rgba(colour, node.state === "unread" ? 0.6 : 1);
        ctx.fill();
        ctx.strokeStyle = rgba(colour, 1);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }

      // Context used: a ring that fills clockwise from the top, amber then red as it runs out.
      if (node.fill !== null && node.role !== "child") {
        const gauge = r + 3 * u;
        ctx.lineWidth = Math.max(1.5, 2 * u);
        ctx.strokeStyle = rgba(palette.dim, 0.3);
        ctx.beginPath();
        ctx.arc(at.x, at.y, gauge, 0, TAU);
        ctx.stroke();
        const level = node.fill >= 0.88 ? palette.error : node.fill >= 0.7 ? palette.ask : node.state === "idle" ? palette.dim : palette.ink;
        ctx.strokeStyle = rgba(level, node.state === "idle" && node.fill < 0.7 ? 0.8 : 1);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(at.x, at.y, gauge, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, node.fill) * TAU);
        ctx.stroke();
        ctx.lineCap = "butt";
      }

      // Working: two arcs turning round it.
      if (node.state === "working") {
        const turn = this.still ? 0.6 : seconds * 1.5 + node.y * 0.03;
        const orbit = r + (node.role === "child" ? 3.5 : node.role === "thread" ? 6.5 : 10) * u;
        ctx.strokeStyle = rgba(palette.ink, 0.95);
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        for (const half of [0, Math.PI]) {
          ctx.beginPath();
          ctx.arc(at.x, at.y, orbit, turn + half, turn + half + 1.15);
          ctx.stroke();
        }
        ctx.lineCap = "butt";
      }

      // Background agents, commands and workflows: small moons, one each, up to five.
      if (node.satellites > 0) {
        const moons = Math.min(5, node.satellites);
        const orbit = r + (node.role === "child" ? 7 : 13) * u;
        const turn = this.still ? 0 : -seconds * 1.1;
        ctx.fillStyle = rgba(palette.text, 0.95);
        for (let moon = 0; moon < moons; moon += 1) {
          const angle = turn + (moon * TAU) / moons;
          ctx.beginPath();
          ctx.arc(at.x + Math.cos(angle) * orbit, at.y + Math.sin(angle) * orbit, 1.6, 0, TAU);
          ctx.fill();
        }
      }

      if (hovered) {
        ctx.strokeStyle = rgba(palette.text, 0.95);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(at.x, at.y, r + (node.role === "child" ? 6 : 12) * u, 0, TAU);
        ctx.stroke();
      }
    }

    // Ripples, and the tool names rising from them.
    for (const ripple of this.ripples) {
      const at = this.live.get(ripple.id);
      const node = nodes.get(ripple.id);
      if (at === undefined || node === undefined) continue;
      const t = unit((now - ripple.t0) / RIPPLE_MS);
      const colour = this.tone(ripple.tone);
      const reach = (ripple.small ? 14 : 26) * u * easeOut(t);
      ctx.strokeStyle = rgba(colour, 0.75 * (1 - t));
      ctx.lineWidth = ripple.small ? 1 : 1.6;
      ctx.beginPath();
      ctx.arc(at.x, at.y, node.r + 4 * u + reach, 0, TAU);
      ctx.stroke();
      if (ripple.label.length > 0) {
        this.setFont(palette.fontSize, 600);
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        const alpha = t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.55) / 0.45);
        const label = this.fit(ripple.label, 110);
        const measured = ctx.measureText(label).width;
        const line = palette.fontSize + 2;
        const spot = ([dx, dy]: [number, number], drift: number): Box => {
          const reach = node.r + 14 * u + drift;
          const cx = at.x + dx * (reach + (dx !== 0 ? measured / 2 : 0));
          const cy = at.y + dy * (reach + (dy !== 0 ? line / 2 : 0));
          return {
            x: Math.min(width - measured - 4, Math.max(4, cx - measured / 2)),
            y: Math.min(height - line - 2, Math.max(2, cy - line / 2)),
            w: measured,
            h: line,
          };
        };
        if (ripple.way === undefined) {
          // Up unless something's there: then whichever side covers least of what was drawn last frame.
          let least = Infinity;
          for (const way of [[0, -1], [1, 0], [-1, 0], [0, 1]] as [number, number][]) {
            const box = spot(way, 8);
            const price = this.crowd.reduce((sum, other) => sum + overlap(box, other), 0);
            if (price < least - 0.5) {
              least = price;
              ripple.way = way;
            }
          }
        }
        const box = spot(ripple.way ?? [0, -1], 16 * easeOut(t));
        ctx.globalAlpha = Math.max(0, alpha);
        this.write(label, box.x + measured / 2, box.y + line / 2, rgba(colour, 1), true);
        ctx.globalAlpha = 1;
      }
    }

    // Names: the anchors' are their systems', so only threads at work, asking, or under the pointer.
    // Each goes on the side of its thread where it covers the least.
    for (const node of data.nodes) {
      const at = this.live.get(node.id);
      if (at !== undefined) taken.push({ x: at.x - node.r - 3, y: at.y - node.r - 3, w: node.r * 2 + 6, h: node.r * 2 + 6 });
    }
    this.setFont(palette.fontSize, 500);
    const rank: Record<NodeState, number> = { asking: 0, error: 1, working: 2, unread: 3, idle: 4 };
    // A small map has no room for every name: children's wait for the pointer, and the rest are cut shorter.
    const roomy = width >= 640;
    const nameWidth = Math.max(96, Math.min(150, width * 0.24));
    const named = data.nodes
      .filter((node) => ((node.labelled && (roomy || node.role !== "child")) || this.hover === node.id) && node.label.length > 0)
      .sort((a, b) => Number(this.hover === b.id) - Number(this.hover === a.id) || rank[a.state] - rank[b.state]);
    const line = palette.fontSize + 2;
    const seen = new Set<string>();
    for (const node of named) {
      const at = this.live.get(node.id);
      if (at === undefined) continue;
      seen.add(node.id);
      const hovered = this.hover === node.id;
      const label = this.fit(node.label, hovered ? Math.min(240, width - 16) : nameWidth);
      const measured = ctx.measureText(label).width;
      const gap = node.r + (node.state === "working" ? 12 : 9) * u;
      const sides: [number, number][] = [
        [Math.cos(node.out), Math.sin(node.out)],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      const boxFor = ([dx, dy]: [number, number]): Box & { align: CanvasTextAlign } => {
        const px = at.x + dx * gap;
        const py = at.y + dy * gap;
        const align: CanvasTextAlign = dx > 0.35 ? "left" : dx < -0.35 ? "right" : "center";
        let x = align === "left" ? px : align === "right" ? px - measured : px - measured / 2;
        x = Math.min(width - measured - 4, Math.max(4, x));
        const y = align === "center" ? (dy > 0 ? py : py - line) : py - line / 2;
        return { x, y: Math.min(height - line - 2, Math.max(2, y)), w: measured, h: line, align };
      };
      const cost = (box: Box) => taken.reduce((sum, other) => sum + overlap(box, other), 0);
      // The side it had last time, while that's still clear: a name that hops about can't be read.
      const kept = this.sides.get(node.id);
      let choice = kept !== undefined && kept < sides.length && cost(boxFor(sides[kept]!)) <= 0.5 ? kept : -1;
      if (choice === -1) {
        let least = Infinity;
        sides.forEach((side, index) => {
          const price = cost(boxFor(side));
          if (price < least - 0.5) {
            least = price;
            choice = index;
          }
        });
        this.sides.set(node.id, choice);
      }
      const box = boxFor(sides[choice]!);
      taken.push(box);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const colour = node.state === "asking" ? palette.ask : node.state === "error" ? palette.error : palette.text;
      this.write(label, box.x, box.y + line / 2, rgba(colour, hovered || node.state !== "idle" ? 1 : 0.85), node.state === "working");
    }
    for (const id of this.sides.keys()) if (!seen.has(id)) this.sides.delete(id);
    this.crowd = taken;
  }
}
