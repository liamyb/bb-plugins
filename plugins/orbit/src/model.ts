/**
 * Orbit's live state: what each thread is doing, worked out from bb's own
 * event log with no agent turns.
 *
 * The server reads a thread's events (turn requests, turn starts and ends,
 * the things the agent starts: tool calls, commands, file reads) and turns
 * them into small "beats". The same reducer runs on the server, to keep the
 * state a new window starts from, and in each window, to apply the beats the
 * server publishes as they happen.
 *
 * Who started a turn is Switchboard's rule (`originOf` in src/rules.ts):
 * yours, a child reporting back, another thread's hand-off, an automation, or
 * maintenance (a `/compact`, or the "Please continue." of a retry).
 *
 * Pure, so it can be tested without bb.
 */

import { isBusy, isWaitingOnUser, originOf, type ThreadFacts, type TurnOrigin } from "./rules.ts";

export type OriginKind = TurnOrigin["kind"];

export const TURN_TYPES = ["client/turn/requested", "turn/started", "turn/completed"] as const;
export const ITEM_TYPES = ["item/started"] as const;
export const CONTEXT_TYPES = ["thread/contextWindowUsage/updated"] as const;
/** Everything a live tail asks `threads.events.list` for. */
export const TAIL_TYPES = [...TURN_TYPES, ...ITEM_TYPES, ...CONTEXT_TYPES] as const;

/** The realtime channel the server publishes new beats on. */
export const BEATS_CHANNEL = "beats";

/** How far back the tool-call history goes. */
export const HIST_MINUTES = 60;
/** How many feed lines are kept. */
export const FEED_MAX = 120;
/** How many hand-offs are kept, and for how long. */
export const EDGE_MAX = 80;
export const EDGE_TTL_MS = 24 * 60 * 60 * 1000;

const MINUTE = 60_000;
const DETAIL_MAX = 96;

interface BeatBase {
  threadId: string;
  seq: number;
  at: number;
}

/** The agent started something: a tool call, a command, a file read. */
export interface ToolBeat extends BeatBase {
  kind: "tool";
  /** A short name: "Bash", "Read", "ClickUp". */
  tool: string;
  /** What it's for, where bb says. */
  detail: string;
  /** Started by a sub-agent inside the thread. */
  sub: boolean;
  /** Thinking or writing: it updates what the thread is doing, and nothing else. */
  quiet: boolean;
}

/** A turn was asked for. */
export interface AskBeat extends BeatBase {
  kind: "ask";
  origin: OriginKind;
  /** The thread that sent it or reported back, where there is one. */
  from: string | null;
  model: string | null;
  reasoning: string | null;
  /** The start of the message, for a hand-off or one of yours. */
  text: string;
  /** bb sending the turn again after a failure or a usage limit: it carries on the turn before it. */
  retry: boolean;
}

export interface StartBeat extends BeatBase {
  kind: "start";
}

export interface EndBeat extends BeatBase {
  kind: "end";
  status: string;
}

export interface ContextBeat extends BeatBase {
  kind: "context";
  used: number | null;
  window: number | null;
}

export type Beat = ToolBeat | AskBeat | StartBeat | EndBeat | ContextBeat;
export type FeedBeat = ToolBeat | AskBeat | EndBeat;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  const n = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** One line, trimmed to `max` characters. */
export function clip(value: string, max: number = DETAIL_MAX): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The part of a shell command that says what it does: its first line, without
 * the `cd … &&` and `NAME=value;` set-up in front of the work.
 */
export function commandGist(command: string): string {
  let line = command.split("\n")[0] ?? "";
  for (let pass = 0; pass < 6; pass += 1) {
    const stripped = line
      .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "")
      .replace(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\$\([^)]*\)|[^\s;&]*)\s*(?:&&|;)\s*/, "");
    if (stripped === line) break;
    line = stripped;
  }
  return line.trim();
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}

const SERVER_NAMES: Record<string, string> = {
  "claude-in-chrome": "Chrome",
  "bb-bridge": "bb",
};

/** An MCP server's name as a word: "claude_ai_ClickUp" as "ClickUp". */
function serverName(server: string): string {
  const known = SERVER_NAMES[server];
  if (known !== undefined) return known;
  return server.replace(/^claude_ai_/i, "").replace(/^plugin[_:]/i, "").replace(/_/g, " ");
}

/** A tool of that server without the server's name on the front: "clickup_create_task" as "create task". */
function serverAction(server: string, tool: string): string {
  const prefix = serverName(server).replace(/\s+/g, "_");
  const bare = tool.toLowerCase().startsWith(`${prefix.toLowerCase()}_`) ? tool.slice(prefix.length + 1) : tool;
  return bare.replace(/_/g, " ");
}

/** "mcp__claude_ai_ClickUp__clickup_create_task" as { tool: "ClickUp", detail: "create task" }. */
function mcpName(tool: string): { tool: string; detail: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (match === null) return null;
  return { tool: serverName(match[1]!), detail: serverAction(match[1]!, match[2]!) };
}

/**
 * What an item the agent started is, as a short name and a detail, or null
 * for the items that aren't the agent doing something (your own message, an
 * error).
 */
export function describeItem(value: unknown): { tool: string; detail: string; quiet: boolean } | null {
  const item = record(value);
  if (item === null) return null;
  const presentation = record(item.presentation);
  const label = record(presentation?.label);
  const title = text(presentation?.title) ?? text(label?.pending) ?? "";
  switch (item.type) {
    case "reasoning":
      return { tool: "Thinking", detail: "", quiet: true };
    case "agentMessage":
      return { tool: "Writing", detail: "", quiet: true };
    case "userMessage":
    case "error":
      return null;
    case "commandExecution": {
      const command = text(item.command) ?? "";
      return { tool: "Bash", detail: clip(text(item.description) ?? (commandGist(command) || command)), quiet: false };
    }
    case "toolCall": {
      const tool = text(item.tool) ?? "Tool";
      // A connector's tool: bb gives the server apart from the tool, or the two joined in one name.
      const server = text(item.server);
      if (server !== null) return { tool: serverName(server), detail: clip(serverAction(server, tool)), quiet: false };
      const mcp = mcpName(tool);
      if (mcp !== null) return { tool: mcp.tool, detail: clip(mcp.detail), quiet: false };
      return { tool, detail: clip(title), quiet: false };
    }
    case "fileRead":
      return { tool: "Read", detail: clip(baseName(text(item.path) ?? title)), quiet: false };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const path = text(record(changes[0])?.path);
      return { tool: "Edit", detail: clip(path === null ? title : baseName(path)), quiet: false };
    }
    case "webSearch": {
      const queries = Array.isArray(item.queries) ? item.queries : [];
      return { tool: "Search", detail: clip(text(queries[0]) ?? title), quiet: false };
    }
    case "webFetch":
      return { tool: "Fetch", detail: clip(hostOf(text(item.url) ?? title)), quiet: false };
    case "search":
      return { tool: "Grep", detail: clip(text(item.query) ?? title), quiet: false };
    case "imageView":
      return { tool: "View", detail: clip(baseName(text(item.path) ?? title)), quiet: false };
    case "imageGeneration":
      return { tool: "Image", detail: clip(text(item.prompt) ?? title), quiet: false };
    case "plan":
    case "planSteps":
      return { tool: "Plan", detail: clip(title), quiet: false };
    case "contextCompaction":
      return { tool: "Compact", detail: "", quiet: false };
    default: {
      const type = text(item.type);
      return type === null ? null : { tool: type, detail: clip(title), quiet: false };
    }
  }
}

// What bb puts at the top of a message one thread sends another.
const ENVELOPE = /^\s*\[bb message from thread:[^\]]*\]\s*/;

/** The start of a turn request's message, without bb's envelope. */
function previewOf(input: unknown): string {
  if (!Array.isArray(input)) return "";
  for (const part of input) {
    const value = text(record(part)?.text);
    if (value !== null) return clip(value.replace(ENVELOPE, ""));
  }
  return "";
}

/** The beats in a `threads.events.list` response, oldest first, dropping anything else. */
export function parseBeats(rows: unknown): Beat[] {
  if (!Array.isArray(rows)) return [];
  const beats: Beat[] = [];
  for (const value of rows) {
    const row = record(value);
    if (row === null) continue;
    const threadId = text(row.threadId);
    const seq = finite(row.seq);
    const at = finite(row.createdAt);
    if (threadId === null || seq === null || at === null) continue;
    const data = record(row.data) ?? {};
    const base = { threadId, seq, at };
    switch (row.type) {
      case "client/turn/requested": {
        const origin = originOf(data);
        const execution = record(data.execution);
        const from = origin.kind === "thread" || origin.kind === "child" ? origin.threadId : null;
        const shown = origin.kind === "you" || origin.kind === "thread";
        beats.push({
          ...base,
          kind: "ask",
          origin: origin.kind,
          from,
          model: text(execution?.model),
          reasoning: text(execution?.reasoningLevel),
          text: shown ? previewOf(data.input) : "",
          retry: text(data.retryOfRequestId) !== null,
        });
        break;
      }
      case "turn/started":
        beats.push({ ...base, kind: "start" });
        break;
      case "turn/completed":
        beats.push({ ...base, kind: "end", status: text(data.status) ?? "completed" });
        break;
      case "item/started": {
        const item = record(data.item);
        const described = describeItem(item);
        if (described === null) break;
        beats.push({ ...base, kind: "tool", ...described, sub: text(item?.parentToolCallId) !== null });
        break;
      }
      case "thread/contextWindowUsage/updated": {
        const usage = record(data.contextWindowUsage);
        const used = finite(usage?.usedTokens);
        const window = finite(usage?.modelContextWindow);
        if (used !== null || window !== null) beats.push({ ...base, kind: "context", used, window });
        break;
      }
      default:
        break;
    }
  }
  return beats.sort((a, b) => a.seq - b.seq);
}

const ORIGINS: readonly OriginKind[] = ["you", "child", "thread", "automation", "maintenance"];

/**
 * The beats in a realtime payload, which is untrusted like anything a window
 * receives: each one is checked field by field and the rest dropped.
 */
export function parseWireBeats(payload: unknown): Beat[] {
  const list = record(payload)?.beats;
  if (!Array.isArray(list)) return [];
  const beats: Beat[] = [];
  for (const value of list) {
    const beat = record(value);
    if (beat === null) continue;
    const threadId = text(beat.threadId);
    const seq = finite(beat.seq);
    const at = finite(beat.at);
    if (threadId === null || seq === null || at === null) continue;
    const base = { threadId, seq, at };
    const string = (field: unknown) => (typeof field === "string" ? field : "");
    if (beat.kind === "tool") {
      beats.push({
        ...base,
        kind: "tool",
        tool: clip(string(beat.tool), 40) || "Tool",
        detail: clip(string(beat.detail)),
        sub: beat.sub === true,
        quiet: beat.quiet === true,
      });
    } else if (beat.kind === "ask") {
      const origin = ORIGINS.find((kind) => kind === beat.origin);
      if (origin === undefined) continue;
      beats.push({
        ...base,
        kind: "ask",
        origin,
        from: text(beat.from),
        model: text(beat.model),
        reasoning: text(beat.reasoning),
        text: clip(string(beat.text)),
        retry: beat.retry === true,
      });
    } else if (beat.kind === "start") {
      beats.push({ ...base, kind: "start" });
    } else if (beat.kind === "end") {
      beats.push({ ...base, kind: "end", status: clip(string(beat.status), 40) || "completed" });
    } else if (beat.kind === "context") {
      beats.push({ ...base, kind: "context", used: finite(beat.used), window: finite(beat.window) });
    }
  }
  return beats;
}

/** What Orbit knows about one thread beyond bb's thread list. */
export interface Vitals {
  /** The newest event applied, so nothing is counted twice. */
  lastSeq: number;
  model: string | null;
  reasoning: string | null;
  /** Context window tokens used, and the window's size. */
  used: number | null;
  window: number | null;
  /** The turn running now: when it began and who asked for it. */
  turn: { at: number; origin: OriginKind; from: string | null } | null;
  /** The newest request, which a queued turn starts from. */
  ask: { origin: OriginKind; from: string | null } | null;
  /** The newest thing the agent started. */
  doing: { at: number; tool: string; detail: string } | null;
  /** When the newest beat happened. */
  lastAt: number;
  /** Tool calls a minute, keyed by the minute (epoch ms / 60000). */
  hist: Record<string, number>;
}

/** One thread sending another a turn. */
export interface Edge {
  key: string;
  at: number;
  from: string;
  to: string;
  /** "tell": a hand-off or a message. "report": a child reporting back to its parent. */
  kind: "tell" | "report";
}

export interface OrbitState {
  vitals: Record<string, Vitals>;
  edges: Edge[];
  feed: FeedBeat[];
}

export function emptyState(): OrbitState {
  return { vitals: {}, edges: [], feed: [] };
}

export function emptyVitals(): Vitals {
  return {
    lastSeq: 0,
    model: null,
    reasoning: null,
    used: null,
    window: null,
    turn: null,
    ask: null,
    doing: null,
    lastAt: 0,
    hist: {},
  };
}

function pruneHist(hist: Record<string, number>, now: number): Record<string, number> {
  const oldest = Math.floor(now / MINUTE) - HIST_MINUTES;
  let stale = false;
  for (const key of Object.keys(hist)) {
    if (Number(key) <= oldest) {
      stale = true;
      break;
    }
  }
  if (!stale) return hist;
  return Object.fromEntries(Object.entries(hist).filter(([key]) => Number(key) > oldest));
}

/**
 * The state with some beats applied. A thread's beats must come oldest
 * first; one at or before the thread's newest applied event is skipped, so
 * the same beat arriving twice (in a snapshot and again live) counts once.
 */
export function applyBeats(state: OrbitState, beats: readonly Beat[], now: number): OrbitState {
  if (beats.length === 0) return state;
  const vitals = { ...state.vitals };
  const edges = [...state.edges];
  const feed = [...state.feed];
  let changed = false;
  for (const beat of beats) {
    const before = vitals[beat.threadId] ?? emptyVitals();
    if (beat.seq <= before.lastSeq) continue;
    changed = true;
    const next: Vitals = { ...before, lastSeq: beat.seq, lastAt: Math.max(before.lastAt, beat.at) };
    switch (beat.kind) {
      case "tool": {
        next.doing = { at: beat.at, tool: beat.tool, detail: beat.detail };
        if (!beat.quiet) {
          // An old call read on the first pass is in the feed, and too old for the history.
          if (beat.at > now - HIST_MINUTES * MINUTE) {
            const minute = String(Math.floor(beat.at / MINUTE));
            next.hist = { ...pruneHist(before.hist, now), [minute]: (before.hist[minute] ?? 0) + 1 };
          }
          feed.push(beat);
        }
        break;
      }
      case "ask": {
        if (beat.model !== null) next.model = beat.model;
        if (beat.reasoning !== null) next.reasoning = beat.reasoning;
        if (beat.retry) {
          // The same turn, sent again: it's still for whoever asked for it, where that's known.
          if (before.turn === null) {
            next.turn = { at: beat.at, origin: before.ask?.origin ?? "maintenance", from: before.ask?.from ?? null };
          }
          break;
        }
        next.ask = { origin: beat.origin, from: beat.from };
        if (before.turn === null) next.turn = { at: beat.at, origin: beat.origin, from: beat.from };
        if (beat.origin !== "maintenance") feed.push(beat);
        if (beat.from !== null && beat.from !== beat.threadId && (beat.origin === "thread" || beat.origin === "child")) {
          edges.push({
            key: `${beat.threadId}:${beat.seq}`,
            at: beat.at,
            from: beat.from,
            to: beat.threadId,
            kind: beat.origin === "child" ? "report" : "tell",
          });
        }
        break;
      }
      case "start": {
        // A queued message starts a turn with no new request: it's the newest one's.
        if (before.turn === null) {
          next.turn = { at: beat.at, origin: before.ask?.origin ?? "you", from: before.ask?.from ?? null };
        }
        break;
      }
      case "end": {
        if (before.turn?.origin !== "maintenance") feed.push(beat);
        next.turn = null;
        next.doing = null;
        break;
      }
      case "context": {
        if (beat.used !== null) next.used = beat.used;
        if (beat.window !== null) next.window = beat.window;
        break;
      }
    }
    vitals[beat.threadId] = next;
  }
  if (!changed) return state;
  const cutoff = now - EDGE_TTL_MS;
  return {
    vitals,
    edges: edges.filter((edge) => edge.at >= cutoff).slice(-EDGE_MAX),
    feed: feed.slice(-FEED_MAX),
  };
}

function feedKey(beat: FeedBeat): string {
  return `${beat.threadId}:${beat.seq}`;
}

/**
 * Two readings of the state joined, for a snapshot that lands in a window
 * already applying live beats: each thread keeps whichever reading has seen
 * more of it, and the feed and hand-offs are the two lists with nothing twice.
 */
export function mergeStates(a: OrbitState, b: OrbitState, now: number): OrbitState {
  const vitals: Record<string, Vitals> = { ...a.vitals };
  for (const [id, theirs] of Object.entries(b.vitals)) {
    const mine = vitals[id];
    if (mine === undefined || theirs.lastSeq > mine.lastSeq) {
      // A context reading can come from outside the event log: keep one the newer side lacks.
      vitals[id] = { ...theirs, used: theirs.used ?? mine?.used ?? null, window: theirs.window ?? mine?.window ?? null };
    } else {
      vitals[id] = { ...mine, used: mine.used ?? theirs.used, window: mine.window ?? theirs.window };
    }
  }
  const feed = new Map<string, FeedBeat>();
  for (const beat of [...a.feed, ...b.feed]) feed.set(feedKey(beat), beat);
  const edges = new Map<string, Edge>();
  for (const edge of [...a.edges, ...b.edges]) edges.set(edge.key, edge);
  const cutoff = now - EDGE_TTL_MS;
  return {
    vitals,
    feed: [...feed.values()].sort((x, y) => x.at - y.at || x.seq - y.seq).slice(-FEED_MAX),
    edges: [...edges.values()]
      .filter((edge) => edge.at >= cutoff)
      .sort((x, y) => x.at - y.at)
      .slice(-EDGE_MAX),
  };
}

/** The state with a thread's context reading set, from `threads.context`. */
export function withContext(
  state: OrbitState,
  threadId: string,
  used: number | null,
  window: number | null,
): OrbitState {
  if (used === null && window === null) return state;
  const before = state.vitals[threadId] ?? emptyVitals();
  return {
    ...state,
    vitals: {
      ...state.vitals,
      [threadId]: { ...before, used: used ?? before.used, window: window ?? before.window },
    },
  };
}

/** The state without some threads: archived or deleted ones. */
export function withoutThreads(state: OrbitState, ids: readonly string[]): OrbitState {
  const drop = new Set(ids);
  if (!Object.keys(state.vitals).some((id) => drop.has(id))) return state;
  return {
    ...state,
    vitals: Object.fromEntries(Object.entries(state.vitals).filter(([id]) => !drop.has(id))),
  };
}

/** Tool calls a minute across every thread, oldest first, ending at the current minute. */
export function histTotals(state: OrbitState, now: number, minutes: number = HIST_MINUTES): number[] {
  const end = Math.floor(now / MINUTE);
  const totals = new Array<number>(minutes).fill(0);
  for (const vitals of Object.values(state.vitals)) {
    for (const [key, count] of Object.entries(vitals.hist)) {
      const index = minutes - 1 - (end - Number(key));
      if (index >= 0 && index < minutes) totals[index] = (totals[index] ?? 0) + count;
    }
  }
  return totals;
}

/** One thread's tool calls a minute, oldest first. */
export function threadHist(vitals: Vitals | undefined, now: number, minutes: number): number[] {
  const end = Math.floor(now / MINUTE);
  const out = new Array<number>(minutes).fill(0);
  if (vitals === undefined) return out;
  for (const [key, count] of Object.entries(vitals.hist)) {
    const index = minutes - 1 - (end - Number(key));
    if (index >= 0 && index < minutes) out[index] = count;
  }
  return out;
}

/** Tool calls a minute, averaged over the last `window` whole minutes and the current one. */
export function toolsPerMinute(state: OrbitState, now: number, window: number = 5): number {
  const totals = histTotals(state, now, window);
  return totals.reduce((sum, count) => sum + count, 0) / window;
}

/** How a thread shows on the map. */
export type NodeState = "asking" | "error" | "working" | "unread" | "idle";

/**
 * A thread's state, by Switchboard's rules: waiting on you beats everything,
 * then a failed turn, then work in flight (a running turn, or background
 * agents, commands or workflows after it), then a reply you haven't read.
 */
export function nodeState(thread: ThreadFacts): NodeState {
  if (isWaitingOnUser(thread)) return "asking";
  if (thread.status === "error" || thread.indicator === "unread-error") return "error";
  if (isBusy(thread)) return "working";
  if (thread.isUnread) return "unread";
  return "idle";
}

/** "claude-fable-5-2" as "Fable 5.2"; anything else as it is. */
export function shortModel(model: string | null): string {
  if (model === null) return "";
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/.exec(model);
  if (match === null) return model;
  const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
  return match[3] === undefined ? `${name} ${match[2]}` : `${name} ${match[2]}.${match[3]}`;
}

/** 228721 as "229k", 1200000 as "1.2M", 1000000 as "1M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(tokens >= 9_950_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.max(0, Math.round(tokens)));
}

/** "12s", "4m 05s", "1h 12m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "17:42:07" in local time. */
export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The share of the context window used, 0 to 1, or null when it isn't known. */
export function contextFill(vitals: Vitals | undefined): number | null {
  if (vitals === undefined || vitals.used === null || vitals.window === null || vitals.window <= 0) return null;
  return Math.min(1, Math.max(0, vitals.used / vitals.window));
}

/** Who a turn is for, in a word or two. */
export function originLabel(origin: OriginKind): string {
  switch (origin) {
    case "you":
      return "you";
    case "child":
      return "a child's report";
    case "thread":
      return "a hand-off";
    case "automation":
      return "an automation";
    case "maintenance":
      return "upkeep";
  }
}
