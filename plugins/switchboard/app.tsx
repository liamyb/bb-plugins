// Switchboard: a compact list of the chats open in your bb panes, with bb's
// own chat sliding open in place. Made for a small second bb window
// (Cmd+Shift+N), and it works as a page in the main window too.
//
// - An overlay in every window reports that window's panes to the plugin
//   server (server.ts), so the page in one window can list the panes of
//   another, and it answers "Open in a pane" for the window that owns them.
//   It also reports the threads in its panes that finished a turn while you
//   weren't looking, since bb marks those read.
// - The page (a nav panel) has three views. Panes lists the open threads
//   with a state word each; All lists every active thread; Waiting lists the
//   threads waiting on you, across every section, in four groups (Asking you,
//   Replies, FYI, Working), with today's front desk and its asks under them.
//   Clicking a row slides bb's ThreadChat open. Ask the desk opens today's
//   front desk thread there, and the + beside it starts a chat with bb's New
//   thread composer. A thread's running workflows show as lines under it,
//   read from its timeline while bb counts any.
// - The rail icon carries a count of the threads asking you or with a reply,
//   from the same rules, and the title bar shows the plan's session and week
//   usage (src/usage.ts).
//
// The list rules are pure in src/current.ts, the Waiting rules in
// src/waiting.ts and the pane rules in src/panes.ts; the CSS is in
// src/styles.ts.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type TransitionEvent as ReactTransitionEvent,
} from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  ThreadChat,
  ThreadTitle,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_usePluginId as usePluginId,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  useSettings,
  useSidebarSplitLayout,
  useSidebarThreadRowStatus,
  type BbNavigate,
  type ExperimentalBadge,
  type NewThreadRequest,
  type PluginSidebarSection,
  type PluginSidebarThread,
  type PluginThreadActionsInlineItem,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  STATE_LABEL,
  buildList,
  nextRuns,
  parseMemory,
  parseWorkflowRuns,
  runProgress,
  serializeMemory,
  threadsWithWorkflows,
  type MemoryMap,
  type Row,
  type RunMap,
  type WorkflowRun,
} from "./src/current";
import {
  ASK_STATUS_LABEL,
  GROUP_LABEL,
  GROUP_ORDER,
  TURN_EVENT_LIMIT,
  TURN_EVENT_TYPES,
  askStatus,
  badgeFor,
  buildWaiting,
  findDesk,
  formatAgo,
  hasUnread,
  ledgerFileName,
  ledgerFolder,
  markSeen,
  parseLedger,
  parseSeen,
  parseTurnEvents,
  relayCheck,
  segmentTurns,
  stepPanes,
  tally,
  turnsWanted,
  type LedgerAsk,
  type TurnSegment,
  type WaitingGroup,
  type WaitingRow,
} from "./src/waiting";
import {
  COMPACT_QUERY,
  EMPTY_SUMMARY,
  OPEN_CHANNEL,
  PANES_CHANNEL,
  clampTtlSeconds,
  heartbeatMs,
  holdDisplaced,
  parseHeld,
  parseOpenRequest,
  parseSummary,
  shouldStayOnSwitchboard,
  type PaneRef,
  type PaneReport,
  type PanesSummary,
} from "./src/panes";
import { summariseUsage, usageLabel, usageTone, usageWord, type UsageWindow } from "./src/usage";
import { CSS, SLIDE_MS, STYLE_ID, WIDE_MIN_PX } from "./src/styles";

/** The nav panel's `path`: the page is at /plugins/<pluginId>/switchboard. */
const PANEL_PATH = "switchboard";

// Debounce for pane reports: bb's layout can change several times in a frame
// while a split opens.
const REPORT_DEBOUNCE_MS = 150;

// How often the run lines refresh while any listed thread has a workflow running.
const WORKFLOW_POLL_MS = 10_000;

// How often today's front desk asks are re-read while the Waiting view shows.
const LEDGER_POLL_MS = 60_000;

// How often the usage gauge re-reads bb's plan limits while the page shows.
const USAGE_POLL_MS = 60_000;

// sessionStorage, like Pane Attention and Pane Keeper: a reload keeps the
// state, a new window starts clean. The view, the seen map and the asks
// toggle are localStorage, so every window shares them.
const KEYS = {
  held: "bb-plugin-switchboard:held-panes",
  lastRoute: "bb-plugin-switchboard:last-route-thread",
  localOpen: "bb-plugin-switchboard:local-open",
  memory: "bb-plugin-switchboard:memory",
  paneMemory: "bb-plugin-switchboard:pane-memory",
  showAll: "bb-plugin-switchboard:show-all",
  view: "bb-plugin-switchboard:view",
  seen: "bb-plugin-switchboard:seen",
  asksOpen: "bb-plugin-switchboard:asks-open",
} as const;

function readStorage(storage: "session" | "local", key: string): string | null {
  try {
    const store = storage === "session" ? window.sessionStorage : window.localStorage;
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: "session" | "local", key: string, value: string | null): void {
  try {
    const store = storage === "session" ? window.sessionStorage : window.localStorage;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage full or blocked: the state still works for this page load.
  }
}

function readJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * This window's id, made once and kept for the window's life. It lives in
 * `window.name`, which survives a reload but belongs to one browsing context,
 * so an iframe or a popup gets its own rather than sharing the tab's
 * sessionStorage copy.
 */
function windowIdentity(): string {
  try {
    if (/^win_[a-z0-9]+$/.test(window.name)) return window.name;
  } catch {
    // Fall through to a fresh id.
  }
  const id = `win_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  try {
    window.name = id;
  } catch {
    // The id still holds for this page load.
  }
  return id;
}

function readStringSet(key: string): ReadonlySet<string> {
  const value = readJson(readStorage("session", key));
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string"));
}

function writeStringSet(key: string, value: ReadonlySet<string>): void {
  writeStorage("session", key, JSON.stringify([...value]));
}

interface Settings {
  showChildren: boolean;
  newChatProjectId: string | undefined;
  newChatEnvironmentId: string | undefined;
  ttlSeconds: number;
  frontDesk: string;
  relaySections: string;
  askLedgerFolder: string;
  railBadge: boolean;
  usageGauge: boolean;
  stayOnSwitchboard: boolean;
}

/** Settings as the page reads them. `values` is undefined until bb has loaded them. */
export function parseSettings(values: Record<string, unknown> | undefined): Settings {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  return {
    showChildren: values?.showChildren !== false,
    newChatProjectId: text(values?.newChatProjectId),
    newChatEnvironmentId: text(values?.newChatEnvironmentId),
    ttlSeconds: clampTtlSeconds(values?.paneReportTtlSeconds),
    // Until bb has loaded the settings, the defaults (server.ts).
    frontDesk: typeof values?.frontDesk === "string" ? values.frontDesk : "Front desk",
    relaySections: typeof values?.relaySections === "string" ? values.relaySections : "Front desk",
    askLedgerFolder:
      typeof values?.askLedgerFolder === "string"
        ? values.askLedgerFolder
        : "automation/front-desk/ledger",
    railBadge: values?.railBadge !== false,
    usageGauge: values?.usageGauge !== false,
    stayOnSwitchboard: values?.stayOnSwitchboard !== false,
  };
}

type Listener = () => void;
type Sdk = ReturnType<typeof useSdk>;

/**
 * Each thread's turns, read when its key changes and shared by every hook in
 * this window (the page and the rail badge), so a thread is read once.
 */
const turnStore = (() => {
  const entries = new Map<string, { key: string; segments: TurnSegment[] }>();
  const loading = new Map<string, string>();
  const listeners = new Set<Listener>();
  let snapshot: ReadonlyMap<string, readonly TurnSegment[]> = new Map();
  const notify = () => {
    snapshot = new Map([...entries].map(([id, entry]) => [id, entry.segments]));
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
    ensure(sdk: Sdk, threadId: string, key: string) {
      if (entries.get(threadId)?.key === key || loading.get(threadId) === key) return;
      loading.set(threadId, key);
      sdk.threads.events
        .list({
          threadId,
          types: TURN_EVENT_TYPES,
          order: "desc",
          limit: String(TURN_EVENT_LIMIT),
        })
        .then((rows) => {
          if (loading.get(threadId) !== key) return;
          const exhausted = Array.isArray(rows) && rows.length < TURN_EVENT_LIMIT;
          entries.set(threadId, { key, segments: segmentTurns(parseTurnEvents(rows), exhausted) });
          notify();
        })
        .catch(() => undefined)
        .finally(() => {
          if (loading.get(threadId) === key) loading.delete(threadId);
        });
    },
  };
})();

interface SenderInfo {
  title: string;
  sectionId: string | null;
}

/**
 * Threads that started a turn but aren't in the sidebar's active list (an
 * archived front desk, say): read once each, for their title and section.
 * Null when bb doesn't have it.
 */
const senderStore = (() => {
  const entries = new Map<string, SenderInfo | null>();
  const loading = new Set<string>();
  const listeners = new Set<Listener>();
  let snapshot: ReadonlyMap<string, SenderInfo | null> = new Map();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
    ensure(sdk: Sdk, threadId: string) {
      if (entries.has(threadId) || loading.has(threadId)) return;
      loading.add(threadId);
      sdk.threads
        .get({ threadId })
        .then(
          (result) => {
            const raw = result as unknown as Record<string, unknown>;
            const thread = (typeof raw.thread === "object" && raw.thread !== null ? raw.thread : raw) as Record<
              string,
              unknown
            >;
            const title =
              (typeof thread.title === "string" && thread.title) ||
              (typeof thread.titleFallback === "string" && thread.titleFallback) ||
              threadId;
            entries.set(threadId, {
              title,
              sectionId: typeof thread.sectionId === "string" ? thread.sectionId : null,
            });
          },
          () => entries.set(threadId, null),
        )
        .finally(() => {
          loading.delete(threadId);
          snapshot = new Map(entries);
          for (const listener of listeners) listener();
        });
    },
  };
})();

/**
 * The attention time each thread had when you last opened it from
 * Switchboard. localStorage, so every window agrees; the `storage` event
 * brings another window's changes in.
 */
const seenStore = (() => {
  let value: Record<string, number> | null = null;
  const listeners = new Set<Listener>();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEYS.seen) return;
    value = parseSeen(event.newValue);
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: Listener) {
      if (listeners.size === 0) window.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", onStorage);
      };
    },
    get(): Record<string, number> {
      value ??= parseSeen(readStorage("local", KEYS.seen));
      return value;
    },
    mark(threadId: string, attentionAt: number, activeIds: ReadonlySet<string>) {
      value = markSeen(seenStore.get(), threadId, attentionAt, activeIds);
      writeStorage("local", KEYS.seen, JSON.stringify(value));
      for (const listener of listeners) listener();
    },
  };
})();

/**
 * Which threads are open in panes, and which finished in one unwatched, from
 * the server: on mount, after a reconnect, and whenever it says it changed.
 */
function usePanesSummary(): PanesSummary {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [summary, setSummary] = useState<PanesSummary>(EMPTY_SUMMARY);
  const refresh = useCallback(async () => {
    try {
      const next = parseSummary(await rpc.call("getPanes", null));
      if (next !== null) setSummary(next);
    } catch {
      // The next signal or heartbeat brings it.
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) void refresh();
    connectedBefore.current = true;
  }, [connection, refresh]);
  const onPanes = useCallback(
    (payload: unknown) => {
      const next = parseSummary(payload);
      if (next === null) void refresh();
      else setSummary(next);
    },
    [refresh],
  );
  useRealtime(PANES_CHANNEL, onPanes);
  return summary;
}

interface Waiting {
  status: "error" | "loading" | "ready";
  threads: readonly PluginSidebarThread[];
  sections: readonly PluginSidebarSection[];
  byId: ReadonlyMap<string, PluginSidebarThread>;
  rows: WaitingRow[];
  summary: PanesSummary;
  senders: ReadonlyMap<string, SenderInfo | null>;
}

/**
 * The Waiting view's rows (src/waiting.ts) from bb's live thread list, the
 * pane reports, the seen map and each listed thread's turns. Used by the page
 * and by the rail badge.
 */
function useWaiting(
  relaySections: string,
  keep: { id: string; group: WaitingGroup } | null,
): Waiting {
  const { status, threads, sections } = useSidebarThreads();
  const summary = usePanesSummary();
  const sdk = useSdk();
  const seen = useSyncExternalStore(seenStore.subscribe, seenStore.get);
  const finished = useMemo(() => new Set(summary.finishedThreadIds), [summary.finishedThreadIds]);
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);

  const wantedKey = JSON.stringify(turnsWanted(threads, finished, seen));
  useEffect(() => {
    for (const { id, key } of JSON.parse(wantedKey) as { id: string; key: string }[]) {
      turnStore.ensure(sdk, id, key);
    }
  }, [sdk, wantedKey]);
  const turns = useSyncExternalStore(turnStore.subscribe, turnStore.get);

  // Senders that aren't active threads: their section decides a relay.
  const unknownSenders = useMemo(() => {
    const ids = new Set<string>();
    for (const segments of turns.values()) {
      for (const segment of segments) {
        for (const origin of segment.origins) {
          if (origin.kind === "thread" && !byId.has(origin.threadId)) ids.add(origin.threadId);
        }
      }
    }
    return [...ids].sort().join(",");
  }, [turns, byId]);
  useEffect(() => {
    if (unknownSenders.length === 0) return;
    for (const id of unknownSenders.split(",")) senderStore.ensure(sdk, id);
  }, [sdk, unknownSenders]);
  const senders = useSyncExternalStore(senderStore.subscribe, senderStore.get);

  const isRelay = useMemo(
    () =>
      relayCheck(relaySections, sections, (id) => {
        const active = byId.get(id);
        if (active !== undefined) return active.sectionId;
        const sender = senders.get(id);
        return sender === undefined ? undefined : (sender?.sectionId ?? null);
      }),
    [relaySections, sections, byId, senders],
  );

  const rows = useMemo(
    () => buildWaiting({ threads, finishedInPanes: finished, seen, turns, isRelay, keep }),
    [threads, finished, seen, turns, isRelay, keep],
  );
  return { status, threads, sections, byId, rows, summary, senders };
}

/** The rail badge: how many threads are asking you or have replied. */
function useWaitingBadge(): ExperimentalBadge | null {
  const { values } = useSettings();
  const settings = parseSettings(values as Record<string, unknown> | undefined);
  const { status, rows } = useWaiting(settings.relaySections, null);
  if (!settings.railBadge || status !== "ready") return null;
  return badgeFor(tally(rows));
}

function onPluginPage(): boolean {
  return window.location.pathname.startsWith("/plugins/");
}

/**
 * The Switchboard page in this window: whether it's showing, when it last
 * stopped, and the chat in its slide, so a narrow window that's taken straight
 * back to it (see `shouldStayOnSwitchboard`) reopens the same chat.
 */
const pageState: {
  mounted: number;
  leftAt: number | null;
  selection: Selection;
  slideOpen: boolean;
} = { mounted: 0, leftAt: null, selection: null, slideOpen: false };

/** When you last clicked, pressed a key or focused this window, or Switchboard acted for you. */
const inputState = { lastAt: 0 };

// How long after going back the page restores the chat it had open.
const STAY_RESTORE_MS = 5_000;

/**
 * The thread something else opened in this narrow window while it showed
 * Switchboard, kept for the bar that offers it, until shown or dismissed.
 */
const stayStore = (() => {
  let current: { threadId: string; at: number } | null = null;
  const listeners = new Set<Listener>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => current,
    set(threadId: string) {
      current = { threadId, at: Date.now() };
      notify();
    },
    clear() {
      if (current === null) return;
      current = null;
      notify();
    },
  };
})();

// Commands run outside React, so the overlay keeps these current.
const live: {
  navigate: BbNavigate | null;
  pluginId: string | null;
  threadId: string | null;
} = { navigate: null, pluginId: null, threadId: null };

/**
 * Best-effort "this window is closing", sent with keepalive so it can outlive
 * the page. The lifetime on the server catches anything this misses.
 */
function forgetWindowOnClose(pluginId: string, windowId: string): void {
  try {
    void fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/forgetWindow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowId }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // Nothing to do: the report expires on its own.
  }
}

/**
 * Runs in every bb window. Reports this window's panes to the server (on
 * change, on a heartbeat, when the window comes back into view and after a
 * reconnect) and opens a thread as a split here when the server asks.
 */
function Overlay() {
  const rpc = useRpc<typeof rpcContract>();
  const layout = useSidebarSplitLayout();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { values } = useSettings();
  const connection = useRealtimeConnectionState();
  const windowId = useMemo(windowIdentity, []);
  const ttlSeconds = clampTtlSeconds(values?.paneReportTtlSeconds);

  useEffect(() => {
    live.navigate = navigate;
    live.pluginId = pluginId;
    return () => {
      live.navigate = null;
    };
  }, [navigate, pluginId]);

  // The thread this window last showed on a thread route, for the no-split
  // case: a plugin page (this one included) takes the single pane's place and
  // bb puts the thread back on the way out, so it stays reported meanwhile.
  const lastRouteThread = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    live.threadId = context.threadId;
    if (context.threadId !== null) {
      lastRouteThread.current = context.threadId;
      writeStorage("session", KEYS.lastRoute, context.threadId);
    } else if (!onPluginPage()) {
      lastRouteThread.current = null;
      writeStorage("session", KEYS.lastRoute, null);
    }
  }, [context.threadId]);

  // Keep a narrow window on Switchboard when something other than you moves it
  // to a thread: bb sends `bb thread open` to every window. Your own clicks,
  // key presses and bringing the window into focus count as yours for a moment.
  useEffect(() => {
    const mark = () => {
      inputState.lastAt = Date.now();
    };
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("keydown", mark, true);
    window.addEventListener("focus", mark);
    return () => {
      window.removeEventListener("pointerdown", mark, true);
      window.removeEventListener("keydown", mark, true);
      window.removeEventListener("focus", mark);
    };
  }, []);
  const stayEnabled = values?.stayOnSwitchboard !== false;
  useEffect(() => {
    const threadId = context.threadId;
    if (threadId === null) return;
    const now = Date.now();
    const msSinceSwitchboard =
      pageState.mounted > 0 ? 0 : pageState.leftAt === null ? null : now - pageState.leftAt;
    const stay = shouldStayOnSwitchboard({
      enabled: stayEnabled,
      compact: window.matchMedia(COMPACT_QUERY).matches,
      msSinceSwitchboard,
      threadId,
      msSinceInput: now - inputState.lastAt,
    });
    if (!stay) return;
    stayStore.set(threadId);
    navigate.toPluginPanel(PANEL_PATH, { replace: true });
  }, [context.threadId, stayEnabled, navigate]);

  // With a split, the panes a plugin page has taken over and the thread each
  // showed before (see `holdDisplaced`). Kept per layout change, not per
  // report, so a quick pair of changes can't slip past the debounce.
  const panes = useMemo<PaneRef[] | null>(
    () =>
      layout?.panes.map(({ paneId, threadId, isFocused }) => ({ paneId, threadId, isFocused })) ??
      null,
    [layout],
  );
  const held = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const previousPanes = useRef<PaneRef[] | null>(null);
  useEffect(() => {
    held.current ??= parseHeld(readJson(readStorage("session", KEYS.held)));
    const next = holdDisplaced(held.current, previousPanes.current, panes, onPluginPage());
    // A pane that closed takes its thread with it: that thread is no longer
    // the one going back would show.
    if (panes !== null && lastRouteThread.current != null) {
      const stillOpen = panes.some((pane) => pane.threadId === lastRouteThread.current);
      const wasOpen = previousPanes.current?.some(
        (pane) => pane.threadId === lastRouteThread.current,
      );
      if (wasOpen && !stillOpen) {
        lastRouteThread.current = null;
        writeStorage("session", KEYS.lastRoute, null);
      }
    }
    previousPanes.current = panes;
    if (next !== held.current) {
      held.current = next;
      writeStorage(
        "session",
        KEYS.held,
        next.size === 0 ? null : JSON.stringify(Object.fromEntries(next)),
      );
    }
  }, [panes]);

  // When this window last had focus, so "Open in a pane" can pick the split
  // window you used last when there's more than one.
  const focusedAt = useRef<number | null>(document.hasFocus() ? Date.now() : null);

  // The threads in this window's panes that finished a turn while you weren't
  // looking at the pane, for the Waiting view. With the window itself not
  // focused, no pane counts as looked at. With no split (or bb's layout not
  // loaded yet) nothing's reported, but the memory is kept for when it's back.
  const { threads } = useSidebarThreads();
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const paneMemory = useRef<MemoryMap | null>(null);
  const finished = useMemo(() => {
    paneMemory.current ??= parseMemory(readStorage("session", KEYS.paneMemory));
    if (panes === null) return [];
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const step = stepPanes(paneMemory.current, panes, byId, windowFocused);
    paneMemory.current = step.memory;
    return step.finished;
  }, [panes, threads, windowFocused]);
  const finishedKey = finished.join(",");
  useEffect(() => {
    if (paneMemory.current !== null) {
      writeStorage("session", KEYS.paneMemory, serializeMemory(paneMemory.current));
    }
  }, [finishedKey]);

  const report = useCallback(() => {
    let extraThreadIds: string[] = [];
    if (panes !== null) {
      extraThreadIds = [...(held.current?.values() ?? [])];
    } else if (context.threadId !== null) {
      extraThreadIds = [context.threadId];
    } else if (onPluginPage()) {
      if (lastRouteThread.current === undefined) {
        const saved = readStorage("session", KEYS.lastRoute);
        lastRouteThread.current = saved !== null && /^thr_[a-z0-9]+$/.test(saved) ? saved : null;
      }
      if (lastRouteThread.current !== null) extraThreadIds = [lastRouteThread.current];
    }
    const body: PaneReport = {
      windowId,
      panes,
      extraThreadIds,
      compact: window.matchMedia(COMPACT_QUERY).matches,
      focusedAt: focusedAt.current,
      finishedThreadIds: finishedKey.length === 0 ? [] : finishedKey.split(",").slice(0, 16),
    };
    void rpc.call("reportPanes", body).catch(() => undefined);
  }, [rpc, windowId, panes, context.threadId, finishedKey]);

  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    const onFocus = () => {
      focusedAt.current = Date.now();
      reportRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // On every change, after the dust settles.
  useEffect(() => {
    const timer = window.setTimeout(() => reportRef.current(), REPORT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [report]);

  // The heartbeat that keeps the report alive on the server.
  useEffect(() => {
    const timer = window.setInterval(() => reportRef.current(), heartbeatMs(ttlSeconds));
    return () => window.clearInterval(timer);
  }, [ttlSeconds]);

  // A hidden window's timers are throttled, so report as soon as it shows.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reportRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Reports sent while the socket was down may not have landed.
  const connectedBefore = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) reportRef.current();
    connectedBefore.current = true;
  }, [connection]);

  // Closing the window: say so, rather than waiting for the lifetime.
  useEffect(() => {
    const onHide = (event: PageTransitionEvent) => {
      if (!event.persisted) forgetWindowOnClose(pluginId, windowId);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [pluginId, windowId]);

  // The plugin being disabled or reloaded: this window stops reporting.
  useEffect(
    () => () => {
      void rpc.call("forgetWindow", { windowId }).catch(() => undefined);
    },
    [rpc, windowId],
  );

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const onOpenRequest = useCallback(
    (payload: unknown) => {
      const request = parseOpenRequest(payload);
      if (request === null || request.windowId !== windowId) return;
      navigateRef.current.toThread(request.threadId, { split: true });
    },
    [windowId],
  );
  useRealtime(OPEN_CHANNEL, onOpenRequest);

  return null;
}

type Selection = { kind: "thread"; id: string } | { kind: "new" } | null;

function toActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      thread.environment !== null && thread.environment.id !== null
        ? { id: thread.environment.id, path: thread.environment.path }
        : null,
  };
}

/**
 * The running workflows of the threads in `polled`. bb's sidebar feed only
 * counts them, so this reads each thread's timeline (the summary, without its
 * rows) at once and then every WORKFLOW_POLL_MS, and stops when `polled` is
 * empty. `now` moves with each poll, for the elapsed times.
 */
function useWorkflowRuns(polled: readonly { id: string; workflows: number }[]): {
  runs: RunMap;
  now: number;
} {
  const sdk = useSdk();
  // The counts are in the key, so a second run starting refetches at once.
  const key = JSON.stringify(polled);
  const [state, setState] = useState<{ runs: RunMap; now: number }>(() => ({
    runs: new Map(),
    now: Date.now(),
  }));
  useEffect(() => {
    const ids = (JSON.parse(key) as { id: string }[]).map(({ id }) => id);
    if (ids.length === 0) {
      setState((current) => (current.runs.size === 0 ? current : { runs: new Map(), now: Date.now() }));
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      const fetched = new Map<string, WorkflowRun[] | null>();
      await Promise.all(
        ids.map(async (threadId) => {
          try {
            const timeline = await sdk.threads.timeline({
              threadId,
              summaryOnly: "true",
              signal: controller.signal,
            });
            fetched.set(threadId, parseWorkflowRuns(timeline));
          } catch {
            // Keeps the lines it had until the next poll.
            fetched.set(threadId, null);
          }
        }),
      );
      if (controller.signal.aborted) return;
      setState((current) => ({ runs: nextRuns(current.runs, ids, fetched), now: Date.now() }));
      timer = window.setTimeout(() => void poll(), WORKFLOW_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sdk, key]);
  return state;
}

interface RunLineProps {
  run: WorkflowRun;
  depth: number;
  now: number;
  threadTitle: string;
  onOpen(): void;
}

/** A workflow running in a thread. It has no chat of its own, so it opens the thread's. */
function RunLine({ run, depth, now, threadTitle, onOpen }: RunLineProps) {
  const progress = runProgress(run, now);
  return (
    <li>
      <div className="sb-row sb-run" data-depth={depth} style={{ marginLeft: `${0.375 + depth}rem` }}>
        <button
          type="button"
          className="sb-row-main"
          aria-label={`${run.name}, ${progress}, running in ${threadTitle}`}
          title={`${run.name} · ${progress}`}
          onClick={onOpen}
        >
          <span className="sb-glyph" aria-hidden="true">
            <ThreadStatusGlyph indicator="workflow" size="compact" />
          </span>
          <span className="sb-title">{run.name}</span>
          <span className="sb-state">{progress}</span>
        </button>
      </div>
    </li>
  );
}

interface RowProps {
  row: Row;
  depth: number;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  runs: RunMap;
  now: number;
  selectedId: string | null;
  onOpen(threadId: string): void;
  onOpenInPane(threadId: string): void;
}

function ThreadRow({ row, depth, threads, runs, now, selectedId, onOpen, onOpenInPane }: RowProps) {
  const thread = threads.get(row.id);
  const rowStatus = useSidebarThreadRowStatus(row.id);
  const inline = useMemo<PluginThreadActionsInlineItem[]>(
    () => [
      {
        key: "switchboard-open-in-pane",
        group: THREAD_ACTION_GROUPS.open,
        action: {
          label: "Open in a pane",
          icon: "Columns",
          run: () => onOpenInPane(row.id),
        },
      },
    ],
    [row.id, onOpenInPane],
  );
  if (thread === undefined) return null;
  const selected = selectedId === row.id;
  const label = STATE_LABEL[row.state];
  // The count is live and the timeline is polled, so the count decides.
  const running = (thread.activity?.workflows ?? 0) > 0 ? (runs.get(row.id) ?? []) : [];
  return (
    <li>
      <div
        className="sb-row"
        data-selected={selected ? "" : undefined}
        data-state={row.state}
        data-depth={depth}
        style={{ marginLeft: `${0.375 + depth}rem` }}
      >
        <button
          type="button"
          className="sb-row-main"
          aria-label={`${thread.displayTitle}, ${label}`}
          aria-current={selected ? "true" : undefined}
          onClick={() => onOpen(row.id)}
        >
          <span className="sb-glyph" aria-hidden="true">
            <ThreadStatusGlyph indicator={thread.indicator} rowStatus={rowStatus} size="compact" />
          </span>
          <span className="sb-title">
            <ThreadTitle threadId={row.id} />
          </span>
          <span className="sb-state" data-state={row.state}>
            {label}
          </span>
        </button>
        <ThreadActionsMenu
          thread={toActionTarget(thread)}
          inline={inline}
          side="bottom"
          align="end"
          trigger={(props) => (
            <button {...props} type="button" className="sb-menu" aria-label="Thread actions">
              ⋯
            </button>
          )}
        />
      </div>
      {running.length > 0 || row.children.length > 0 ? (
        <ul>
          {running.map((run) => (
            <RunLine
              key={run.id}
              run={run}
              depth={depth + 1}
              now={now}
              threadTitle={thread.displayTitle}
              onOpen={() => onOpen(row.id)}
            />
          ))}
          {row.children.map((child) => (
            <ThreadRow
              key={child.id}
              row={child}
              depth={depth + 1}
              threads={threads}
              runs={runs}
              now={now}
              selectedId={selectedId}
              onOpen={onOpen}
              onOpenInPane={onOpenInPane}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const ASKING_HINT: Record<NonNullable<WaitingRow["asking"]>, string> = {
  question: "Waiting for your answer",
  "queued-failed": "A queued message didn't send",
  failed: "The last turn failed",
};

/** The second line of a Waiting row: its section, then why it's there. */
function waitingHint(
  row: WaitingRow,
  thread: PluginSidebarThread,
  sections: readonly PluginSidebarSection[],
  titleOf: (threadId: string) => string,
): string {
  const parts: string[] = [];
  if (row.parentId !== null) {
    parts.push(`Under ${titleOf(row.parentId)}`);
  } else {
    const section = sections.find((candidate) => candidate.id === thread.sectionId);
    if (section !== undefined) parts.push(section.name);
  }
  if (row.asking !== null) {
    parts.push(ASKING_HINT[row.asking]);
  } else if (row.verdict.kind === "fyi") {
    const from = row.verdict.from;
    parts.push(
      from.kind === "thread"
        ? `From ${titleOf(from.threadId)}`
        : from.kind === "automation"
          ? "From an automation"
          : "From a child thread",
    );
  }
  return parts.join(" · ");
}

interface WaitingRowProps {
  row: WaitingRow;
  thread: PluginSidebarThread;
  hint: string;
  now: number;
  runs: readonly WorkflowRun[];
  selected: boolean;
  onOpen(threadId: string, group: WaitingGroup): void;
  onOpenInPane(threadId: string): void;
}

function WaitingRowView({ row, thread, hint, now, runs, selected, onOpen, onOpenInPane }: WaitingRowProps) {
  const rowStatus = useSidebarThreadRowStatus(row.id);
  const inline = useMemo<PluginThreadActionsInlineItem[]>(
    () => [
      {
        key: "switchboard-open-in-pane",
        group: THREAD_ACTION_GROUPS.open,
        action: {
          label: "Open in a pane",
          icon: "Columns",
          run: () => onOpenInPane(row.id),
        },
      },
    ],
    [row.id, onOpenInPane],
  );
  const ago = row.group === "working" ? "" : formatAgo(now - row.attentionAt);
  const label = [thread.displayTitle, GROUP_LABEL[row.group], hint, ago].filter(Boolean).join(", ");
  return (
    <li>
      <div
        className="sb-row sb-wrow"
        data-group={row.group}
        data-selected={selected ? "" : undefined}
        style={{ marginLeft: "0.375rem" }}
      >
        <button
          type="button"
          className="sb-row-main"
          aria-label={label}
          aria-current={selected ? "true" : undefined}
          onClick={() => onOpen(row.id, row.group)}
        >
          <span className="sb-glyph" aria-hidden="true">
            <ThreadStatusGlyph indicator={thread.indicator} rowStatus={rowStatus} size="compact" />
          </span>
          <span className="sb-lines">
            <span className="sb-line">
              <span className="sb-title">
                <ThreadTitle threadId={row.id} />
              </span>
              {ago.length > 0 ? <span className="sb-state">{ago}</span> : null}
            </span>
            {hint.length > 0 ? (
              <span className="sb-hint" title={hint}>
                {hint}
              </span>
            ) : null}
          </span>
        </button>
        <ThreadActionsMenu
          thread={toActionTarget(thread)}
          inline={inline}
          side="bottom"
          align="end"
          trigger={(props) => (
            <button {...props} type="button" className="sb-menu" aria-label="Thread actions">
              ⋯
            </button>
          )}
        />
      </div>
      {runs.length > 0 ? (
        <ul>
          {runs.map((run) => (
            <RunLine
              key={run.id}
              run={run}
              depth={1}
              now={now}
              threadTitle={thread.displayTitle}
              onOpen={() => onOpen(row.id, row.group)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A clock for "5m ago" labels, ticking every `ms` while mounted. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Today's front desk asks, from the ledger file in `folder`, read now and
 * every LEDGER_POLL_MS while `enabled`. Null when there's no file to read.
 */
function useLedger(folder: string | null, enabled: boolean): LedgerAsk[] | null {
  const sdk = useSdk();
  const [asks, setAsks] = useState<LedgerAsk[] | null>(null);
  useEffect(() => {
    if (!enabled || folder === null) {
      setAsks(null);
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    const read = async () => {
      const path = `${folder}/${ledgerFileName(new Date())}`;
      try {
        const file = await sdk.files.read({ path, signal: controller.signal });
        const raw = file as unknown as { content?: unknown; contentEncoding?: unknown };
        let text = typeof raw.content === "string" ? raw.content : "";
        if (raw.contentEncoding === "base64") {
          const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
          text = new TextDecoder().decode(bytes);
        }
        if (!controller.signal.aborted) setAsks(parseLedger(text));
      } catch {
        // No ledger today yet, or it can't be read: no list.
        if (!controller.signal.aborted) setAsks(null);
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void read(), LEDGER_POLL_MS);
    };
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [sdk, folder, enabled]);
  return asks;
}

interface TodaysAsksProps {
  asks: readonly LedgerAsk[];
  /** Today's front desk, shown first. */
  desk: { id: string; title: string } | null;
  rows: ReadonlyMap<string, WaitingRow>;
  activeIds: ReadonlySet<string>;
  open: boolean;
  onToggle(open: boolean): void;
  onOpen(threadId: string): void;
}

/**
 * The front desk itself, then what it was asked today, newest first, with
 * where each one is now.
 */
function TodaysAsks({ asks, desk, rows, activeIds, open, onToggle, onOpen }: TodaysAsksProps) {
  const newestFirst = useMemo(() => [...asks].reverse(), [asks]);
  const deskStatus = desk === null ? null : askStatus(desk.id, rows, activeIds);
  return (
    <details
      className="sb-asks"
      open={open}
      onToggle={(event) => onToggle((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="sb-group-head">
        <span>Today's asks</span>
        <span className="sb-group-count">{asks.length}</span>
      </summary>
      <ul className="sb-ask-list">
        {desk !== null && deskStatus !== null ? (
          <li key="desk">
            <button
              type="button"
              className="sb-ask"
              data-desk=""
              title={`Open ${desk.title}`}
              aria-label={[desk.title, ASK_STATUS_LABEL[deskStatus]].filter(Boolean).join(", ")}
              onClick={() => onOpen(desk.id)}
            >
              <span className="sb-ask-time">Desk</span>
              <span className="sb-ask-text">{desk.title}</span>
              <span className="sb-state" data-status={deskStatus}>
                {ASK_STATUS_LABEL[deskStatus]}
              </span>
            </button>
          </li>
        ) : null}
        {newestFirst.map((ask, index) => {
          const status = askStatus(ask.threadId, rows, activeIds);
          const label = ASK_STATUS_LABEL[status];
          const threadId = ask.threadId;
          return (
            <li key={`${index}:${ask.time}:${ask.ask}`}>
              <button
                type="button"
                className="sb-ask"
                disabled={threadId === null || status === "archived"}
                title={ask.ask}
                aria-label={[ask.time, ask.ask, label].filter(Boolean).join(", ")}
                onClick={() => {
                  if (threadId !== null) onOpen(threadId);
                }}
              >
                <span className="sb-ask-time">{ask.time}</span>
                <span className="sb-ask-text">{ask.ask}</span>
                <span className="sb-state" data-status={status}>
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

type View = "panes" | "waiting" | "all";

const VIEWS: readonly { id: View; label: string; title: string }[] = [
  { id: "panes", label: "Panes", title: "The chats open in your panes" },
  { id: "waiting", label: "Waiting", title: "Threads waiting on you, in every section" },
  { id: "all", label: "All", title: "Every active thread" },
];

/** The saved view; before there was one, the old All threads toggle decides. */
function readView(): View {
  const saved = readStorage("local", KEYS.view);
  if (saved === "panes" || saved === "waiting" || saved === "all") return saved;
  return readStorage("local", KEYS.showAll) === "1" ? "all" : "waiting";
}

/** The Switchboard page. */
function SwitchboardPage() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { values } = useSettings();
  const settings = useMemo(
    () => parseSettings(values as Record<string, unknown> | undefined),
    [values],
  );

  const [view, setView] = useState<View>(readView);
  const showAll = view === "all";
  // Threads this page opened itself (new chats), kept until the window closes.
  const [localOpen, setLocalOpen] = useState<ReadonlySet<string>>(() =>
    readStringSet(KEYS.localOpen),
  );
  // Taken straight back here a moment ago (see `shouldStayOnSwitchboard`):
  // reopen the chat that was in the slide.
  const [restore] = useState(() => {
    const stayed = stayStore.get();
    return stayed !== null && Date.now() - stayed.at < STAY_RESTORE_MS;
  });
  const [selection, setSelection] = useState<Selection>(() =>
    restore ? pageState.selection : null,
  );
  const [slideOpen, setSlideOpen] = useState(() => restore && pageState.slideOpen);
  useEffect(() => {
    pageState.mounted += 1;
    return () => {
      pageState.mounted -= 1;
      pageState.leftAt = Date.now();
    };
  }, []);
  useEffect(() => {
    pageState.selection = selection;
    pageState.slideOpen = slideOpen;
  }, [selection, slideOpen]);
  const stayed = useSyncExternalStore(stayStore.subscribe, stayStore.get);
  const [wide, setWide] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<MemoryMap | null>(null);

  // A Waiting row opened in the slide keeps its place while it's open, even
  // though opening it marked it read.
  const [opened, setOpened] = useState<{ id: string; group: WaitingGroup } | null>(null);
  const selectedThreadId = selection?.kind === "thread" ? selection.id : null;
  const keep = opened !== null && opened.id === selectedThreadId ? opened : null;
  const waiting = useWaiting(settings.relaySections, keep);
  const { status, threads, summary, sections, senders } = waiting;
  // The count leaves out the open thread once it's read, like the rail badge.
  const counts = useMemo(() => {
    const kept = keep === null ? undefined : waiting.byId.get(keep.id);
    const finished = new Set(waiting.summary.finishedThreadIds);
    const readNow =
      kept !== undefined && !hasUnread(kept, finished, seenStore.get()) ? kept.id : null;
    return tally(waiting.rows.filter((row) => row.id !== readNow));
  }, [waiting.rows, waiting.byId, waiting.summary.finishedThreadIds, keep]);
  const now = useNow(30_000);
  const [asksOpen, setAsksOpen] = useState(() => readStorage("local", KEYS.asksOpen) !== "0");

  // The plugin's own CSS, for as long as the page is mounted.
  useEffect(() => {
    let style = document.getElementById(STYLE_ID);
    const mine = style === null;
    if (style === null) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    return () => {
      if (mine) style?.remove();
    };
  }, []);

  // Wide or narrow is the page's own width, not the window's.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const measure = (width: number) => setWide(width >= WIDE_MIN_PX);
    measure(root.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      measure(width ?? root.clientWidth);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const selectedId = selection?.kind === "thread" ? selection.id : null;
  const open = useMemo(
    () => new Set<string>([...summary.openThreadIds, ...localOpen]),
    [summary.openThreadIds, localOpen],
  );
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);

  // The list, advancing the Done memory as it goes. The memory lives in a
  // ref so the step is part of the same computation; running it twice on
  // the same inputs gives the same answer.
  const rows = useMemo(() => {
    memoryRef.current ??= parseMemory(readStorage("session", KEYS.memory));
    const result = buildList(
      threads,
      open,
      { showChildren: settings.showChildren, showAll, selectedId },
      memoryRef.current,
    );
    memoryRef.current = result.memory;
    return result.rows;
  }, [threads, open, settings.showChildren, showAll, selectedId]);
  useEffect(() => {
    if (memoryRef.current !== null) {
      writeStorage("session", KEYS.memory, serializeMemory(memoryRef.current));
    }
  }, [rows]);

  // The workflow lines: under the listed threads, or the Working group's.
  const polled = useMemo(() => {
    if (view !== "waiting") return threadsWithWorkflows(rows, byId);
    return waiting.rows
      .filter((row) => row.group === "working")
      .map((row) => ({ id: row.id, workflows: byId.get(row.id)?.activity?.workflows ?? 0 }))
      .filter((entry) => entry.workflows > 0);
  }, [view, rows, waiting.rows, byId]);
  const { runs, now: runNow } = useWorkflowRuns(polled);

  // Today's front desk asks, read from the project checkout while Waiting shows.
  const checkoutPath = useMemo(() => {
    const id = settings.newChatEnvironmentId;
    if (id === undefined) return null;
    return threads.find((thread) => thread.environment?.id === id)?.environment?.path ?? null;
  }, [threads, settings.newChatEnvironmentId]);
  const asks = useLedger(
    ledgerFolder(settings.askLedgerFolder, checkoutPath),
    view === "waiting",
  );
  const activeIds = useMemo(() => new Set(byId.keys()), [byId]);
  const rowsById = useMemo(
    () => new Map(waiting.rows.map((row) => [row.id, row])),
    [waiting.rows],
  );
  const titleOf = useCallback(
    (threadId: string) =>
      byId.get(threadId)?.displayTitle ?? senders.get(threadId)?.title ?? "another thread",
    [byId, senders],
  );

  // Today's front desk: the pinned thread in its section, so it follows the
  // morning run's new desk each day.
  const deskId = useMemo(
    () => findDesk(threads, sections, settings.frontDesk),
    [threads, sections, settings.frontDesk],
  );
  const desk = useMemo(
    () => (deskId === null ? null : { id: deskId, title: byId.get(deskId)?.displayTitle ?? "Front desk" }),
    [deskId, byId],
  );

  // A new chat this page started drops out once bb no longer lists it
  // (archived, say). Only an id the list has carried at some point counts as
  // gone: a thread created a moment ago isn't in the sidebar's view yet.
  const seenIds = useRef(new Set<string>());
  useEffect(() => {
    if (status !== "ready") return;
    for (const id of byId.keys()) seenIds.current.add(id);
    if (localOpen.size === 0) return;
    const kept = new Set(
      [...localOpen].filter((id) => byId.has(id) || !seenIds.current.has(id)),
    );
    if (kept.size !== localOpen.size) {
      setLocalOpen(kept);
      writeStringSet(KEYS.localOpen, kept);
    }
  }, [status, byId, localOpen]);

  const openThread = useCallback((id: string) => {
    setSelection({ kind: "thread", id });
    setSlideOpen(true);
    if (stayStore.get()?.threadId === id) stayStore.clear();
  }, []);
  // The bar's Show: go to the thread, where bb shows what it opened in its
  // panel. A click, so the window doesn't come straight back.
  const showStayed = useCallback(() => {
    const current = stayStore.get();
    if (current === null) return;
    stayStore.clear();
    inputState.lastAt = Date.now();
    navigate.toThread(current.threadId);
  }, [navigate]);
  const stayBar =
    stayed === null ? null : (
      <div className="sb-stay" role="status">
        <div className="sb-lines">
          <span className="sb-line sb-stay-title">
            {byId.get(stayed.threadId)?.displayTitle ?? "A thread"}
          </span>
          <span className="sb-hint">An agent opened this in bb, so Switchboard stayed put.</span>
        </div>
        <button type="button" className="sb-button" onClick={showStayed}>
          Show
        </button>
        <button
          type="button"
          className="sb-icon-button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => stayStore.clear()}
        >
          ×
        </button>
      </div>
    );

  // Opening a thread from Waiting reads it: bb's read state, and the seen map
  // for a thread whose pane finished unwatched.
  const openFromWaiting = useCallback(
    (id: string, group: WaitingGroup | null) => {
      const thread = byId.get(id);
      setOpened(group === null ? null : { id, group });
      openThread(id);
      if (thread === undefined) return;
      seenStore.mark(id, thread.latestAttentionAt, activeIds);
      const finished = new Set(summary.finishedThreadIds);
      if (hasUnread(thread, finished, {})) {
        void sdk.threads.markRead({ threadId: id }).catch(() => undefined);
      }
    },
    [byId, openThread, activeIds, summary.finishedThreadIds, sdk],
  );
  const openNew = useCallback(() => {
    setSelection({ kind: "new" });
    setSlideOpen(true);
  }, []);
  // Ask the desk: today's desk in the slide, its composer focused once the
  // slide settles, read like any thread opened from Waiting.
  const askDesk = useCallback(() => {
    if (deskId === null) {
      openNew();
      return;
    }
    openFromWaiting(deskId, rowsById.get(deskId)?.group ?? null);
  }, [deskId, openNew, openFromWaiting, rowsById]);
  const closeSlide = useCallback(() => setSlideOpen(false), []);

  // Focus the composer when the slide has finished, and let go of the chat
  // once it has slid away. transitionend does it; a timer covers reduced
  // motion and a swap with the slide already open, where nothing animates.
  const settledRef = useRef(0);
  const settle = useCallback(() => {
    settledRef.current += 1;
    if (slideOpen && selection !== null) setFocusRequest((n) => n + 1);
    if (!slideOpen) setSelection(null);
  }, [slideOpen, selection]);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    const before = settledRef.current;
    const timer = window.setTimeout(() => {
      if (settledRef.current === before) settleRef.current();
    }, SLIDE_MS + 80);
    return () => window.clearTimeout(timer);
  }, [slideOpen, selection]);
  const onSlideTransitionEnd = useCallback((event: ReactTransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    settleRef.current();
  }, []);

  // Escape slides the chat away. Listened for on the document, because focus
  // can sit on the body (after answering a question, say) where the page's
  // own handler would never see it; keys aimed at another pane are left alone.
  useEffect(() => {
    if (!slideOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      const inPage = target instanceof Node && (rootRef.current?.contains(target) ?? false);
      const nowhere =
        target === document.body || target === document.documentElement || target === document;
      if (!inPage && !nowhere) return;
      event.preventDefault();
      closeSlide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [slideOpen, closeSlide]);

  const chooseView = useCallback((next: View) => {
    setView(next);
    writeStorage("local", KEYS.view, next);
  }, []);
  const toggleAsks = useCallback((open: boolean) => {
    setAsksOpen(open);
    writeStorage("local", KEYS.asksOpen, open ? "1" : "0");
  }, []);

  // "Open in a pane": the window that owns the panes gets it, through the
  // server. With no such window it opens here, with bb's split rules.
  const openInPane = useCallback(
    async (threadId: string) => {
      let windowId: string | null = null;
      try {
        ({ windowId } = await rpc.call("openInPane", { threadId }));
      } catch {
        windowId = null;
      }
      if (windowId === null) {
        toast("No other bb window has panes open, so it's opening here.");
        navigate.toThread(threadId, { split: true });
      }
    },
    [rpc, navigate],
  );

  // New chat: bb's composer resolves the selections, this plugin creates the
  // thread, and the thread opens in the slide.
  const environmentSeed = useMemo(
    () =>
      settings.newChatEnvironmentId === undefined
        ? undefined
        : ({ type: "reuse", environmentId: settings.newChatEnvironmentId } as const),
    [settings.newChatEnvironmentId],
  );
  const onSubmitNew = useCallback(
    async (request: NewThreadRequest) => {
      let thread: { id: string };
      try {
        thread = await sdk.threads.spawn(request);
      } catch (error) {
        toast.error(
          `Switchboard couldn't start the chat: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      setLocalOpen((current) => {
        const next = new Set(current);
        next.add(thread.id);
        writeStringSet(KEYS.localOpen, next);
        return next;
      });
      setSelection({ kind: "thread", id: thread.id });
    },
    [sdk],
  );

  const emptyText =
    status === "loading"
      ? "Loading threads"
      : showAll
        ? "No active threads."
        : "Nothing's open in a pane. Open a thread in a split, or pick All.";

  const waitingCount = counts.asking + counts.replies;
  const waitingBody = (
    <div className="sb-rows">
      {status === "loading" ? (
        <div className="sb-empty">Loading threads</div>
      ) : waiting.rows.length === 0 ? (
        <div className="sb-empty">Nothing's waiting on you.</div>
      ) : (
        <ul aria-label="Waiting on you">
          {GROUP_ORDER.map((group) => {
            const list = waiting.rows.filter((row) => row.group === group);
            if (list.length === 0) return null;
            return (
              <li key={group} className="sb-group" data-group={group}>
                <div className="sb-group-head">
                  <span>{GROUP_LABEL[group]}</span>
                  <span className="sb-group-count">{list.length}</span>
                </div>
                <ul>
                  {list.map((row) => {
                    const thread = byId.get(row.id);
                    if (thread === undefined) return null;
                    const running =
                      (thread.activity?.workflows ?? 0) > 0 ? (runs.get(row.id) ?? []) : [];
                    return (
                      <WaitingRowView
                        key={row.id}
                        row={row}
                        thread={thread}
                        hint={waitingHint(row, thread, sections, titleOf)}
                        now={Math.max(now, runNow)}
                        runs={running}
                        selected={selectedId === row.id}
                        onOpen={openFromWaiting}
                        onOpenInPane={openInPane}
                      />
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {desk !== null || (asks !== null && asks.length > 0) ? (
        <TodaysAsks
          asks={asks ?? []}
          desk={desk}
          rows={rowsById}
          activeIds={activeIds}
          open={asksOpen}
          onToggle={toggleAsks}
          onOpen={(threadId) => openFromWaiting(threadId, rowsById.get(threadId)?.group ?? null)}
        />
      ) : null}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="sb-page"
      data-slide-open={slideOpen ? "" : undefined}
      data-wide={wide ? "" : undefined}
    >
      <div className="sb-list">
        <div className="sb-toolbar">
          {desk === null ? (
            <button type="button" className="sb-button" data-primary="" onClick={openNew}>
              New chat
            </button>
          ) : (
            <>
              <button
                type="button"
                className="sb-button"
                data-primary=""
                title={`Open ${desk.title} to ask it something`}
                onClick={askDesk}
              >
                Ask the desk
              </button>
              <button
                type="button"
                className="sb-icon-button sb-new"
                aria-label="New chat"
                title="Start a blank chat"
                onClick={openNew}
              >
                +
              </button>
            </>
          )}
          <span className="sb-toolbar-spacer" />
          <div className="sb-views" role="group" aria-label="Show">
            {VIEWS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="sb-view"
                aria-pressed={view === option.id}
                title={option.title}
                onClick={() => chooseView(option.id)}
              >
                {option.label}
                {option.id === "waiting" && waitingCount > 0 ? (
                  <span
                    className="sb-view-count"
                    data-tone={counts.asking > 0 ? "warning" : undefined}
                    aria-label={`, ${waitingCount} waiting`}
                  >
                    {waitingCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        {stayBar}
        {view === "waiting" ? (
          waitingBody
        ) : rows.length === 0 ? (
          <div className="sb-empty">{emptyText}</div>
        ) : (
          <ul className="sb-rows" aria-label="Chats">
            {rows.map((row) => (
              <ThreadRow
                key={row.id}
                row={row}
                depth={0}
                threads={byId}
                runs={runs}
                now={runNow}
                selectedId={selectedId}
                onOpen={openThread}
                onOpenInPane={openInPane}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="sb-blank" aria-hidden="true">
        Pick a chat on the left, or start a new one.
      </div>
      <div
        className="sb-slide"
        aria-hidden={slideOpen ? undefined : "true"}
        onTransitionEnd={onSlideTransitionEnd}
      >
        <div className="sb-slide-header">
          <button
            type="button"
            className="sb-icon-button sb-back"
            data-narrow-only={wide ? undefined : ""}
            aria-label={wide ? "Close the chat" : "Back to the list"}
            onClick={closeSlide}
          >
            {wide ? "×" : "←"}
          </button>
          <span className="sb-slide-title">
            {selection?.kind === "thread" ? (
              <ThreadTitle threadId={selection.id} />
            ) : selection?.kind === "new" ? (
              "New chat"
            ) : null}
          </span>
        </div>
        {wide ? null : stayBar}
        <div className="sb-slide-body">
          {selection?.kind === "thread" ? (
            <ThreadChat
              key={selection.id}
              threadId={selection.id}
              variant={wide ? "full" : "compact"}
              layout="contained"
              permissionPolicy="editable"
              focusRequest={focusRequest}
            />
          ) : selection?.kind === "new" ? (
            <div className="sb-composer-wrap">
              <NewThreadComposer
                defaultProjectId={settings.newChatProjectId}
                defaultEnvironment={environmentSeed}
                onSubmit={onSubmitNew}
                layout="document"
                focusRequest={focusRequest}
                placeholder="What should this chat do?"
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A small ring filled to `percent`. */
function UsageRing({ percent }: { percent: number }) {
  const radius = 5.5;
  const length = 2 * Math.PI * radius;
  return (
    <svg className="sb-usage-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <circle className="sb-usage-track" cx="7" cy="7" r={radius} />
      <circle
        className="sb-usage-fill"
        cx="7"
        cy="7"
        r={radius}
        strokeDasharray={`${(length * percent) / 100} ${length}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

/**
 * The usage gauge on the right of the title bar: the plan's session and week,
 * each a ring and a percentage, with both reset times in the tooltip. Read
 * from bb's plan limits now, once a minute while the window is visible, and
 * whenever it comes back into view.
 */
function UsageGauge() {
  const sdk = useSdk();
  const { values } = useSettings();
  const enabled = parseSettings(values as Record<string, unknown> | undefined).usageGauge;
  const [windows, setWindows] = useState<UsageWindow[] | null>(null);
  const now = useNow(60_000);
  useEffect(() => {
    if (!enabled) {
      setWindows(null);
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    const read = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const result = await sdk.system.usageLimits({ signal: controller.signal });
          if (!controller.signal.aborted) setWindows(summariseUsage(result));
        } catch {
          // Keep the last figures; the next read tries again.
        }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void read(), USAGE_POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sdk, enabled]);
  if (!enabled || windows === null) return null;
  const label = usageLabel(windows, now);
  return (
    <div className="sb-usage" role="img" aria-label={`Usage: ${label}`} title={label}>
      {windows.map((item) => (
        <span
          key={item.key}
          className="sb-usage-item"
          data-tone={usageTone(item.usedPercent) ?? undefined}
        >
          <UsageRing percent={item.usedPercent} />
          <span className="sb-usage-value">{item.usedPercent}%</span>
          <span className="sb-usage-word">{usageWord(item.key)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Cmd+Shift+S. On the Switchboard page: go back to where you were. Anywhere
 * else: open the page.
 */
function toggleSwitchboard(): void {
  const navigate = live.navigate;
  if (navigate === null) return;
  const onSwitchboard =
    live.pluginId !== null &&
    window.location.pathname.startsWith(`/plugins/${live.pluginId}/${PANEL_PATH}`);
  if (!onSwitchboard) {
    navigate.toPluginPanel(PANEL_PATH);
    return;
  }
  if (window.history.length > 1) {
    window.history.back();
  } else if (live.threadId !== null) {
    navigate.toThread(live.threadId);
  }
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "switchboard",
    title: "Switchboard",
    icon: "./assets/icon.svg",
    path: PANEL_PATH,
    component: SwitchboardPage,
    experimental_useBadge: useWaitingBadge,
    headerContent: UsageGauge,
  });
  app.slots.experimental_appOverlay({
    id: "switchboard",
    component: Overlay,
  });
  app.commands.register({
    id: "toggle",
    title: "Switchboard: open, or go back",
    defaultShortcut: { key: "s", mod: true, shift: true },
    run: () => toggleSwitchboard(),
  });
});
