// Orbit: a live map of every thread across bb.
//
// - The page (a nav panel) draws the map on a canvas (src/scene.ts) from bb's
//   live thread list: today's front desk in the middle, each section a system
//   round it with its pinned hub as the anchor, child threads beside their
//   parents (src/layout.ts). Beside it: what each working thread is doing,
//   a feed, and tool calls a minute over the last hour.
// - What a thread is doing (its tool calls, who started its turn, its model
//   and context) comes from the plugin server (server.ts), which reads bb's
//   event log while a page is showing and publishes what's new. The page
//   applies it with the same reducer the server uses (src/model.ts).
// - Today's front desk asks come from the desk's ledger file, read the way
//   Switchboard reads it, by Switchboard's own rules (src/rules.ts).
//
// Nothing here starts an agent turn: it's bb's own state, drawn.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  useSettings,
  type PluginSidebarSection,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { findDesk, ledgerFileName, ledgerFolder, parseLedger, type LedgerAsk } from "./src/rules";
import { buildLayout, LOOSE_ID, type LayoutThread } from "./src/layout";
import {
  BEATS_CHANNEL,
  HIST_MINUTES,
  applyBeats,
  contextFill,
  emptyState,
  formatClock,
  formatElapsed,
  formatTokens,
  histTotals,
  mergeStates,
  nodeState,
  originLabel,
  parseWireBeats,
  shortModel,
  toolsPerMinute,
  type Beat,
  type FeedBeat,
  type NodeState,
  type OrbitState,
  type Vitals,
} from "./src/model";
import { Scene, type Palette, type Rgb, type SceneData, type SceneNode } from "./src/scene";
import { CSS, STYLE_ID } from "./src/styles";

const PANEL_PATH = "orbit";
const HEARTBEAT_MS = 20_000;
/** A heartbeat older than this and the server may have stopped reading: start from a snapshot. */
const STALE_MS = 45_000;
const LEDGER_POLL_MS = 20_000;
/** A beat older than this is applied without a ripple: it's history, not news. */
const NEWS_MS = 20_000;
const FEED_SHOWN = 60;

// ---- Settings ---------------------------------------------------------------

interface Settings {
  frontDesk: string;
  ledgerFolder: string;
  motion: boolean;
}

function parseSettings(values: Record<string, unknown> | undefined): Settings {
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  return {
    frontDesk: text(values?.frontDesk, "Front desk"),
    ledgerFolder: text(values?.ledgerFolder, "automation/front-desk/ledger"),
    motion: values?.motion !== false,
  };
}

// ---- The theme, read for the canvas -----------------------------------------

const FALLBACK: Rgb = [128, 128, 128];

/** A CSS colour as red, green and blue, by painting it: this takes color-mix() and oklch() too. */
function toRgb(colour: string, ctx: CanvasRenderingContext2D): Rgb {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === undefined || a === 0) return FALLBACK;
  // Painted on nothing, a see-through colour comes back premultiplied: undo it.
  const k = 255 / a;
  return [Math.round((r ?? 0) * k), Math.round((g ?? 0) * k), Math.round((b ?? 0) * k)];
}

function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The map's colours and type, from the --orb-* variables on the page. */
function readPalette(page: HTMLElement, probe: HTMLElement): Palette {
  const scratch = document.createElement("canvas");
  scratch.width = 1;
  scratch.height = 1;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  const style = getComputedStyle(page);
  const colour = (name: string): Rgb => {
    if (ctx === null) return FALLBACK;
    probe.style.color = `var(${name})`;
    return toRgb(getComputedStyle(probe).color, ctx);
  };
  const surface = colour("--orb-surface");
  const lcd = style.getPropertyValue("--orb-lcd").trim().length > 0;
  const font = style.getPropertyValue("--orb-font").trim() || "ui-sans-serif, system-ui, sans-serif";
  return {
    surface,
    ink: colour("--orb-ink"),
    dim: colour("--orb-dim"),
    text: colour("--orb-text"),
    ask: colour("--orb-ask"),
    error: colour("--orb-error"),
    accent: colour("--orb-accent"),
    dark: luminance(surface) < 0.42,
    lcd,
    font,
    // A pixel face reads small for its size.
    fontSize: lcd ? 15 : 11,
  };
}

function samePalette(a: Palette, b: Palette): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The palette, re-read whenever bb swaps the theme or its light and dark side. */
function usePalette(page: HTMLElement | null, probe: HTMLElement | null): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(null);
  useEffect(() => {
    if (page === null || probe === null) return;
    const read = () => {
      const next = readPalette(page, probe);
      setPalette((current) => (current !== null && samePalette(current, next) ? current : next));
    };
    read();
    // A theme's fonts can land after its colours.
    const later = window.setTimeout(read, 600);
    const observer = new MutationObserver(read);
    const theme = document.querySelector("style#bb-app-theme");
    if (theme) observer.observe(theme, { childList: true, characterData: true, subtree: true });
    observer.observe(document.head, { childList: true });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", read);
    window.addEventListener("focus", read);
    return () => {
      window.clearTimeout(later);
      observer.disconnect();
      scheme.removeEventListener("change", read);
      window.removeEventListener("focus", read);
    };
  }, [page, probe]);
  return palette;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The page's CSS, in the document while a page is mounted. */
function useStyle(): void {
  useEffect(() => {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (style === null) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.dataset.count = "0";
      document.head.appendChild(style);
    }
    style.textContent = CSS;
    style.dataset.count = String(Number(style.dataset.count ?? "0") + 1);
    return () => {
      const current = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (current === null) return;
      const count = Number(current.dataset.count ?? "1") - 1;
      if (count <= 0) current.remove();
      else current.dataset.count = String(count);
    };
  }, []);
}

/** A clock for elapsed times, ticking every `ms` while mounted. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

// ---- The live state ---------------------------------------------------------

interface Live {
  state: OrbitState;
  /** False until the first snapshot lands. */
  ready: boolean;
  error: string | null;
}

/**
 * What the server knows, kept current: a snapshot when the page opens or
 * comes back, then the beats it publishes. `onNews` is called with the beats
 * that were new, for the map's ripples and comets.
 */
function useLive(onNews: (beats: readonly Beat[]) => void): Live {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const windowId = useMemo(() => `orbit_${Math.random().toString(36).slice(2, 10)}`, []);
  const [live, setLive] = useState<Live>({ state: emptyState(), ready: false, error: null });
  const stateRef = useRef(live.state);
  const newsRef = useRef(onNews);
  newsRef.current = onNews;
  const lastBeat = useRef(0);
  const loading = useRef(false);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const snapshot = await rpc.call("snapshot", { windowId });
      lastBeat.current = Date.now();
      stateRef.current = mergeStates(stateRef.current, snapshot.state, Date.now());
      setLive({ state: stateRef.current, ready: true, error: null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setLive((current) => ({ ...current, error: message }));
    } finally {
      loading.current = false;
    }
  }, [rpc, windowId]);

  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastBeat.current > STALE_MS) {
        void load();
        return;
      }
      rpc.call("watch", { windowId }).then(
        () => {
          lastBeat.current = Date.now();
        },
        () => undefined,
      );
    };
    void load();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", beat);
      rpc.call("unwatch", { windowId }).catch(() => undefined);
    };
  }, [rpc, windowId, load]);

  // Signals sent while the connection was down are gone: start from a snapshot again.
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected" && !wasConnected.current) void load();
    wasConnected.current = connection === "connected";
  }, [connection, load]);

  const onBeats = useCallback((payload: unknown) => {
    const before = stateRef.current;
    const fresh = parseWireBeats(payload).filter((beat) => beat.seq > (before.vitals[beat.threadId]?.lastSeq ?? 0));
    if (fresh.length === 0) return;
    const next = applyBeats(before, fresh, Date.now());
    if (next === before) return;
    stateRef.current = next;
    setLive((current) => ({ ...current, state: next }));
    newsRef.current(fresh);
  }, []);
  useRealtime(BEATS_CHANNEL, onBeats);

  return live;
}

interface Ledger {
  /** Today's asks, or null when there's no file to read. */
  asks: LedgerAsk[] | null;
  /** Why there are none, for the readout's tooltip. */
  why: string | null;
}

/**
 * Today's front desk asks, from the ledger file in `folder`, read now and
 * every LEDGER_POLL_MS while the page shows.
 */
function useLedger(folder: string | null, missing: string): Ledger {
  const sdk = useSdk();
  const [ledger, setLedger] = useState<Ledger>({ asks: null, why: missing });
  useEffect(() => {
    if (folder === null) {
      setLedger({ asks: null, why: missing });
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    const read = async () => {
      if (document.visibilityState === "visible") {
        const path = `${folder}/${ledgerFileName(new Date())}`;
        try {
          const file = await sdk.files.read({ path, signal: controller.signal });
          const raw = file as unknown as { content?: unknown; contentEncoding?: unknown };
          let text = typeof raw.content === "string" ? raw.content : "";
          if (raw.contentEncoding === "base64") {
            text = new TextDecoder().decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
          }
          if (!controller.signal.aborted) setLedger({ asks: parseLedger(text), why: null });
        } catch (cause) {
          // No ledger today yet, or it can't be read: no lines.
          const reason = cause instanceof Error ? cause.message : String(cause);
          if (!controller.signal.aborted) setLedger({ asks: null, why: `${path} couldn't be read: ${reason}` });
        }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void read(), LEDGER_POLL_MS);
    };
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sdk, folder, missing]);
  return ledger;
}

// ---- What the page draws ----------------------------------------------------

interface Roster {
  threads: readonly PluginSidebarThread[];
  byId: ReadonlyMap<string, PluginSidebarThread>;
  sections: readonly PluginSidebarSection[];
  deskId: string | null;
}

function useRoster(frontDesk: string): Roster & { status: "error" | "loading" | "ready" } {
  const { status, threads: all, sections } = useSidebarThreads();
  return useMemo(() => {
    const threads = all.filter((thread) => !thread.isHidden && !thread.isArchived);
    return {
      status,
      threads,
      byId: new Map(threads.map((thread) => [thread.id, thread])),
      sections,
      deskId: findDesk(threads, sections, frontDesk),
    };
  }, [status, all, sections, frontDesk]);
}

function sectionName(roster: Roster, thread: PluginSidebarThread): string {
  // A child is filed with whatever it works under.
  let top = thread;
  for (let hops = 0; hops < 4 && top.parentThreadId !== null; hops += 1) {
    const parent = roster.byId.get(top.parentThreadId);
    if (parent === undefined) break;
    top = parent;
  }
  return roster.sections.find((section) => section.id === top.sectionId)?.name ?? "No section";
}

function titleOf(roster: Roster, id: string | null): string {
  if (id === null) return "";
  return roster.byId.get(id)?.displayTitle ?? "another thread";
}

function satellitesOf(thread: PluginSidebarThread): number {
  const activity = thread.activity;
  return activity.backgroundAgents + activity.backgroundCommands + activity.workflows;
}

/** Who the running turn is for: "you", "Vendors hub", "an automation". */
function forWhom(roster: Roster, vitals: Vitals | undefined): string | null {
  const turn = vitals?.turn;
  // Upkeep (a compact, a retry with nothing known before it) is for nobody.
  if (turn === undefined || turn === null || turn.origin === "maintenance") return null;
  if ((turn.origin === "thread" || turn.origin === "child") && turn.from !== null && roster.byId.has(turn.from)) {
    return titleOf(roster, turn.from);
  }
  return originLabel(turn.origin);
}

function buildScene(
  roster: Roster,
  state: OrbitState,
  asks: readonly LedgerAsk[] | null,
  width: number,
  height: number,
): SceneData {
  const threads: LayoutThread[] = roster.threads.map((thread) => ({
    id: thread.id,
    parentId: thread.parentThreadId,
    sectionId: thread.sectionId,
    pinnedAt: thread.isPinned ? (thread.pinnedAt ?? thread.createdAt) : null,
    createdAt: thread.createdAt,
  }));
  const layout = buildLayout({ threads, sections: roster.sections, deskId: roster.deskId, width, height });
  const working = new Map<string, number>();
  const total = new Map<string, number>();
  const nodes: SceneNode[] = [];
  for (const node of layout.nodes) {
    const thread = roster.byId.get(node.id);
    if (thread === undefined) continue;
    const condition = nodeState(thread);
    total.set(node.systemId, (total.get(node.systemId) ?? 0) + 1);
    if (condition === "working") working.set(node.systemId, (working.get(node.systemId) ?? 0) + 1);
    nodes.push({
      ...node,
      state: condition,
      label: thread.displayTitle,
      fill: contextFill(state.vitals[node.id]),
      satellites: satellitesOf(thread),
      // An anchor's name is its system's; a thread's shows while there's something to say about it.
      labelled: node.role !== "desk" && node.role !== "hub" && (condition === "working" || condition === "asking" || condition === "error"),
    });
  }
  const spokes = new Map<string, number>();
  for (const ask of asks ?? []) {
    if (ask.threadId === null || ask.threadId === roster.deskId || !roster.byId.has(ask.threadId)) continue;
    spokes.set(ask.threadId, (spokes.get(ask.threadId) ?? 0) + 1);
  }
  return {
    width,
    height,
    unit: layout.nodeScale,
    nodes,
    systems: layout.systems.map((system) => ({
      id: system.id,
      name: system.id === LOOSE_ID ? "No section" : system.name,
      x: system.x,
      y: system.y,
      radius: system.radius,
      rings: system.rings,
      isDesk: system.isDesk,
      captionAbove: system.captionAbove,
      working: working.get(system.id) ?? 0,
      total: total.get(system.id) ?? 0,
    })),
    arcs: state.edges.filter((edge) => roster.byId.has(edge.from) && roster.byId.has(edge.to)),
    spokes: [...spokes].map(([to, count]) => ({ to, count })),
    deskId: roster.deskId,
  };
}

// ---- The map ----------------------------------------------------------------

interface Hover {
  id: string;
  x: number;
  y: number;
}

interface MapProps {
  roster: Roster;
  state: OrbitState;
  asks: readonly LedgerAsk[] | null;
  palette: Palette | null;
  still: boolean;
  sceneRef: { current: Scene | null };
  note: string | null;
  onOpen(id: string, split: boolean): void;
}

function OrbitMap({ roster, state, asks, palette, still, sceneRef, note, onOpen }: MapProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (canvas.current === null) return;
    let scene: Scene;
    try {
      scene = new Scene(canvas.current, {
        onHover: (id, x, y) => setHover(id === null ? null : { id, x, y }),
        onOpen: (id, split) => openRef.current(id, split),
      });
    } catch {
      return;
    }
    sceneRef.current = scene;
    return () => {
      scene.destroy();
      sceneRef.current = null;
    };
  }, [sceneRef]);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => {
      const width = Math.round(element.clientWidth);
      const height = Math.round(element.clientHeight);
      setSize((current) => (current !== null && current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const data = useMemo(
    () => (size === null || size.width < 40 || size.height < 40 ? null : buildScene(roster, state, asks, size.width, size.height)),
    [roster, state, asks, size],
  );
  useEffect(() => {
    if (data !== null) sceneRef.current?.setData(data);
  }, [data, sceneRef]);
  useEffect(() => {
    if (palette !== null) sceneRef.current?.setPalette(palette);
  }, [palette, sceneRef]);
  useEffect(() => {
    sceneRef.current?.setStill(still);
  }, [still, sceneRef]);

  const hovered = hover === null ? undefined : roster.byId.get(hover.id);
  return (
    <div className="orb-map" ref={box}>
      <canvas ref={canvas} role="img" aria-label={`A map of ${roster.threads.length} threads. The lists beside it name the ones at work.`} />
      <div className="orb-legend" aria-hidden="true">
        <span className="orb-key"><i data-kind="working" />Working</span>
        <span className="orb-key"><i data-kind="asking" />Asking you</span>
        <span className="orb-key"><i data-kind="unread" />Unread reply</span>
        <span className="orb-key"><i data-kind="idle" />Idle</span>
        <span className="orb-key"><i data-kind="error" />Failed</span>
        <span className="orb-key"><i data-kind="handoff" />Hand-off</span>
        <span className="orb-key"><i data-kind="ask-line" />Desk ask today</span>
      </div>
      {note !== null && (
        <div className="orb-note" data-centre={roster.threads.length === 0 ? "" : undefined}>
          {note}
        </div>
      )}
      {hover !== null && hovered !== undefined && size !== null && (
        <Tip roster={roster} thread={hovered} vitals={state.vitals[hovered.id]} at={hover} size={size} />
      )}
    </div>
  );
}

const STATE_WORD: Record<NodeState, string> = {
  asking: "Asking you",
  error: "Failed",
  working: "Working",
  unread: "Unread reply",
  idle: "Idle",
};

interface TipProps {
  roster: Roster;
  thread: PluginSidebarThread;
  vitals: Vitals | undefined;
  at: Hover;
  size: { width: number; height: number };
}

function Tip({ roster, thread, vitals, at, size }: TipProps) {
  const now = useNow(1000);
  const condition = nodeState(thread);
  const whom = condition === "working" ? forWhom(roster, vitals) : null;
  const role =
    thread.id === roster.deskId
      ? "today's front desk"
      : thread.parentThreadId !== null && roster.byId.has(thread.parentThreadId)
        ? `child of ${titleOf(roster, thread.parentThreadId)}`
        : thread.isPinned
          ? "pinned"
          : null;
  const fill = contextFill(vitals);
  const moons = satellitesOf(thread);
  const right = at.x > size.width * 0.58;
  const below = at.y < size.height * 0.5;
  const style = {
    ...(right ? { right: Math.max(8, size.width - at.x + 16) } : { left: Math.max(8, at.x + 16) }),
    ...(below ? { top: Math.max(8, at.y + 14) } : { bottom: Math.max(8, size.height - at.y + 14) }),
  };
  const model = [shortModel(vitals?.model ?? null), vitals?.reasoning ?? ""].filter((part) => part.length > 0).join(" · ");
  const last = vitals !== undefined && vitals.lastAt > 0 ? vitals.lastAt : (thread.latestAttentionAt ?? thread.updatedAt);
  return (
    <div className="orb-tip" style={style} role="status">
      <div className="orb-tip-title">{thread.displayTitle}</div>
      <div className="orb-tip-line">{[sectionName(roster, thread), role].filter(Boolean).join(" · ")}</div>
      <div className="orb-tip-line">
        <strong>{STATE_WORD[condition]}</strong>
        {whom !== null && ` for ${whom}`}
        {condition === "working" && vitals?.turn != null && ` · ${formatElapsed(now - vitals.turn.at)}`}
        {moons > 0 && ` · ${moons} in the background`}
      </div>
      {condition === "working" && vitals?.doing != null && (
        <div className="orb-tip-line">
          <strong>{vitals.doing.tool}</strong>
          {vitals.doing.detail.length > 0 && ` · ${vitals.doing.detail}`}
        </div>
      )}
      {model.length > 0 && <div className="orb-tip-line">{model}</div>}
      {fill !== null && vitals?.used != null && vitals.window != null && (
        <div className="orb-tip-line">
          <Level fill={fill} /> {formatTokens(vitals.used)} of {formatTokens(vitals.window)} context ({Math.round(fill * 100)}%)
        </div>
      )}
      <div className="orb-tip-line">Last active {formatElapsed(now - last)} ago</div>
      <div className="orb-tip-hint">Click to open · Cmd-click for a split</div>
    </div>
  );
}

function Level({ fill }: { fill: number }) {
  const level = fill >= 0.88 ? "full" : fill >= 0.7 ? "high" : "ok";
  return (
    <span className="orb-level" data-level={level} aria-hidden="true">
      <i style={{ width: `${Math.max(3, Math.round(fill * 100))}%` }} />
    </span>
  );
}

// ---- The readouts, the lists ------------------------------------------------

interface StatsProps {
  roster: Roster;
  state: OrbitState;
  asks: readonly LedgerAsk[] | null;
  /** Why there are no desk asks to count. */
  noAsks: string | null;
  now: number;
}

function Stats({ roster, state, asks, noAsks, now }: StatsProps) {
  let working = 0;
  let asking = 0;
  let tokens = 0;
  for (const thread of roster.threads) {
    const condition = nodeState(thread);
    if (condition === "working") {
      working += 1;
      tokens += state.vitals[thread.id]?.used ?? 0;
    } else if (condition === "asking" || condition === "error") {
      asking += 1;
    }
  }
  const rate = toolsPerMinute(state, now);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const handoffs = state.edges.filter((edge) => edge.kind === "tell" && edge.at >= midnight).length;
  const tiles: { label: string; value: string; tone?: "ask" | "quiet"; title: string }[] = [
    { label: "Working", value: String(working), tone: working === 0 ? "quiet" : undefined, title: "Threads with a turn running, or background work still going after one" },
    { label: "Need you", value: String(asking), tone: asking > 0 ? "ask" : "quiet", title: "Threads asking you something, and threads whose turn failed" },
    {
      label: "Tools a min",
      value: rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1),
      tone: rate === 0 ? "quiet" : undefined,
      title: "Tool calls a minute across every thread, over the last five minutes",
    },
    {
      label: "In context",
      value: tokens > 0 ? formatTokens(tokens) : "0",
      tone: tokens === 0 ? "quiet" : undefined,
      title: "Context window tokens held by the threads working now",
    },
    { label: "Hand-offs today", value: String(handoffs), tone: handoffs === 0 ? "quiet" : undefined, title: "Messages one thread sent another since midnight" },
    {
      label: "Desk asks today",
      value: asks === null ? "-" : String(asks.length),
      tone: asks === null || asks.length === 0 ? "quiet" : undefined,
      title: asks === null ? (noAsks ?? "Today's ledger hasn't been read yet.") : "Lines in the front desk's ledger today",
    },
  ];
  return (
    <div className="orb-stats">
      {tiles.map((tile) => (
        <div className="orb-stat" key={tile.label} title={tile.title}>
          <span className="orb-stat-value" data-tone={tile.tone}>{tile.value}</span>
          <span className="orb-stat-label">{tile.label}</span>
        </div>
      ))}
    </div>
  );
}

function Spectrum({ state, now }: { state: OrbitState; now: number }) {
  const totals = useMemo(() => histTotals(state, now), [state, now]);
  const peak = Math.max(...totals);
  const top = Math.max(6, peak);
  return (
    <div className="orb-spectrum">
      <div className="orb-spectrum-head">
        <span>Tool calls a minute · last hour</span>
        <span>{peak > 0 ? `peak ${peak}` : "quiet"}</span>
      </div>
      <div className="orb-bars" role="img" aria-label={`Tool calls a minute over the last ${HIST_MINUTES} minutes, peaking at ${peak}.`}>
        {totals.map((count, index) => (
          <i
            key={index}
            data-empty={count === 0 ? "" : undefined}
            data-now={index === totals.length - 1 && count > 0 ? "" : undefined}
            style={{ height: count === 0 ? "1px" : `${Math.max(8, Math.round((count / top) * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

interface ListProps {
  roster: Roster;
  state: OrbitState;
  now: number;
  onOpen(id: string, split: boolean): void;
}

function NowList({ roster, state, now, onOpen }: ListProps) {
  const rows = useMemo(() => {
    const rank: Record<NodeState, number> = { asking: 0, error: 1, working: 2, unread: 3, idle: 4 };
    return roster.threads
      .map((thread) => ({ thread, condition: nodeState(thread) }))
      .filter((row) => row.condition === "working" || row.condition === "asking" || row.condition === "error")
      .sort(
        (a, b) =>
          rank[a.condition] - rank[b.condition] ||
          (state.vitals[a.thread.id]?.turn?.at ?? a.thread.updatedAt) - (state.vitals[b.thread.id]?.turn?.at ?? b.thread.updatedAt) ||
          a.thread.id.localeCompare(b.thread.id),
      );
  }, [roster.threads, state.vitals]);
  return (
    <section className="orb-panel orb-now" aria-label="Threads at work now">
      <div className="orb-panel-head">
        <span>Now</span>
        <span className="orb-panel-count">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="orb-empty">Nothing is working. A thread shows here the moment it starts a turn.</div>
      ) : (
        <ul className="orb-panel-body">
          {rows.map(({ thread, condition }) => {
            const vitals = state.vitals[thread.id];
            const fill = contextFill(vitals);
            const whom = condition === "working" ? forWhom(roster, vitals) : null;
            const meta = [
              condition === "working" ? null : STATE_WORD[condition],
              shortModel(vitals?.model ?? null) || null,
              whom === null ? null : `for ${whom}`,
              sectionName(roster, thread),
            ].filter((part): part is string => part !== null);
            const doing = condition === "working" ? vitals?.doing : null;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className="orb-row"
                  title={`Open ${thread.displayTitle}`}
                  onClick={(event) => onOpen(thread.id, event.metaKey || event.ctrlKey)}
                >
                  <span className="orb-dot" data-state={condition} aria-hidden="true" />
                  <span className="orb-row-title">{thread.displayTitle}</span>
                  <span className="orb-row-time">
                    {condition === "working" && vitals?.turn != null ? formatElapsed(now - vitals.turn.at) : ""}
                  </span>
                  <span className="orb-row-meta">
                    <span>{meta.join(" · ")}</span>
                  </span>
                  {(doing != null || fill !== null) && (
                    <span className="orb-row-doing">
                      {fill !== null && <Level fill={fill} />}
                      {doing != null && <b>{doing.tool}</b>}
                      {doing != null && doing.detail.length > 0 && <span>{doing.detail}</span>}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function feedLine(roster: Roster, beat: FeedBeat): { lead: string; rest: string } {
  if (beat.kind === "tool") return { lead: beat.tool, rest: beat.detail };
  if (beat.kind === "end") return { lead: beat.status === "completed" ? "Finished" : `Stopped (${beat.status})`, rest: "" };
  if (beat.origin === "you") return { lead: "You", rest: beat.text };
  if (beat.origin === "automation") return { lead: "Automation", rest: "started a run" };
  if (beat.origin === "child") return { lead: "Report", rest: beat.from === null ? "from a child" : `from ${titleOf(roster, beat.from)}` };
  return { lead: `From ${titleOf(roster, beat.from)}`, rest: beat.text };
}

function Feed({ roster, state, onOpen }: Omit<ListProps, "now">) {
  const rows = useMemo(() => state.feed.slice(-FEED_SHOWN).reverse(), [state.feed]);
  return (
    <section className="orb-panel orb-feed" aria-label="What just happened">
      <div className="orb-panel-head">
        <span>Feed</span>
      </div>
      {rows.length === 0 ? (
        <div className="orb-empty">Tool calls and hand-offs show here as they happen.</div>
      ) : (
        <ul className="orb-panel-body">
          {rows.map((beat) => {
            const line = feedLine(roster, beat);
            const title = titleOf(roster, beat.threadId);
            return (
              <li key={`${beat.threadId}:${beat.seq}`}>
                <button
                  type="button"
                  className="orb-feed-row"
                  data-kind={beat.kind}
                  title={`${title}: ${line.lead}${line.rest.length > 0 ? ` · ${line.rest}` : ""}`}
                  onClick={(event) => onOpen(beat.threadId, event.metaKey || event.ctrlKey)}
                >
                  <span className="orb-feed-time">{formatClock(beat.at)}</span>
                  <span>{title}</span>
                  <span className="orb-feed-what">
                    <b>{line.lead}</b>
                    {line.rest.length > 0 && ` ${line.rest}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---- The page ---------------------------------------------------------------

function OrbitPage() {
  useStyle();
  const navigate = useBbNavigate();
  const { values } = useSettings();
  const settings = useMemo(() => parseSettings(values as Record<string, unknown> | undefined), [values]);
  const roster = useRoster(settings.frontDesk);
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const sceneRef = useRef<Scene | null>(null);
  const [page, setPage] = useState<HTMLDivElement | null>(null);
  const [probe, setProbe] = useState<HTMLSpanElement | null>(null);
  const palette = usePalette(page, probe);
  const reduced = useReducedMotion();
  const still = reduced || !settings.motion;

  // What's new on the map: a ripple for a tool call, a comet for a hand-off.
  const onNews = useCallback((beats: readonly Beat[]) => {
    const scene = sceneRef.current;
    if (scene === null) return;
    const now = Date.now();
    const known = rosterRef.current.byId;
    for (const beat of beats) {
      if (now - beat.at > NEWS_MS) continue;
      if (beat.kind === "tool") {
        if (!beat.quiet) scene.ripple(beat.threadId, beat.tool, "ink", beat.sub);
      } else if (beat.kind === "ask") {
        if (beat.origin === "thread" || beat.origin === "child") {
          const tone = beat.origin === "thread" ? "accent" : "ink";
          if (beat.from !== null && known.has(beat.from)) scene.comet(beat.from, beat.threadId, tone);
          else scene.ripple(beat.threadId, "hand-off", tone);
        } else if (beat.origin === "you") {
          scene.ripple(beat.threadId, "you", "text");
        } else if (beat.origin === "automation") {
          scene.ripple(beat.threadId, "automation", "text");
        }
      } else if (beat.kind === "end") {
        scene.ripple(beat.threadId, beat.status === "completed" ? "done" : beat.status, "text", true);
      }
    }
  }, []);
  const live = useLive(onNews);

  const desk = roster.deskId === null ? undefined : roster.byId.get(roster.deskId);
  const folder = useMemo(
    () => ledgerFolder(settings.ledgerFolder, desk?.environment?.path ?? null),
    [settings.ledgerFolder, desk?.environment?.path],
  );
  const ledger = useLedger(
    folder,
    roster.deskId === null
      ? "No front desk thread was found, so there's no ledger to read."
      : settings.ledgerFolder.trim().length === 0
        ? "The ledger folder setting is empty."
        : "The front desk thread's checkout isn't known, so the ledger can't be found.",
  );
  const asks = ledger.asks;

  // A new line in the ledger: the ask flies from the desk to the thread it went to.
  const seenAsks = useRef<number | null>(null);
  useEffect(() => {
    if (asks === null) return;
    const before = seenAsks.current;
    seenAsks.current = asks.length;
    if (before === null || asks.length <= before || roster.deskId === null) return;
    for (const ask of asks.slice(before)) {
      if (ask.threadId !== null && ask.threadId !== roster.deskId) sceneRef.current?.comet(roster.deskId, ask.threadId, "text");
    }
  }, [asks, roster.deskId]);

  const anyWorking = roster.threads.some((thread) => nodeState(thread) === "working");
  const now = useNow(anyWorking ? 1000 : 15_000);

  const open = useCallback(
    (id: string, split: boolean) => {
      if (split) navigate.toThread(id, { split: true });
      else navigate.toThread(id);
    },
    [navigate],
  );

  const note =
    roster.status === "loading"
      ? "Reading bb's threads…"
      : roster.status === "error"
        ? "bb's thread list can't be read just now."
        : roster.threads.length === 0
          ? "No active threads. Start one and it shows here."
          : live.error !== null
            ? `Live detail is off (${live.error}). The map still follows bb's thread list.`
            : !live.ready
              ? "Reading what each thread is doing…"
              : null;

  return (
    <div className="orb-page" ref={setPage} data-skin={palette?.lcd === true ? "lcd" : "plain"}>
      <span className="orb-probe" ref={setProbe} aria-hidden="true" />
      <div className="orb-frame">
        <div className="orb-main">
          <Stats roster={roster} state={live.state} asks={asks} noAsks={ledger.why} now={now} />
          <OrbitMap
            roster={roster}
            state={live.state}
            asks={asks}
            palette={palette}
            still={still}
            sceneRef={sceneRef}
            note={note}
            onOpen={open}
          />
          <Spectrum state={live.state} now={now} />
        </div>
        <div className="orb-side">
          <NowList roster={roster} state={live.state} now={now} onOpen={open} />
          <Feed roster={roster} state={live.state} onOpen={open} />
        </div>
      </div>
    </div>
  );
}

/** The title bar: how many threads are working, whatever page of Orbit shows. */
function OrbitHeader() {
  useStyle();
  const { threads } = useSidebarThreads();
  const working = threads.filter((thread) => !thread.isHidden && !thread.isArchived && nodeState(thread) === "working").length;
  return (
    <span className="orb-header" title={`${working} ${working === 1 ? "thread is" : "threads are"} working across bb`}>
      <i data-quiet={working === 0 ? "" : undefined} />
      {working} working
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "orbit",
    title: "Orbit",
    icon: "./assets/icon.svg",
    path: PANEL_PATH,
    component: OrbitPage,
    headerContent: OrbitHeader,
  });
});
