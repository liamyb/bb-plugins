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
  useLayoutEffect,
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
  experimental_useAppPanel as useAppPanel,
  experimental_usePanelTabs as usePanelTabs,
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
  type ExperimentalPanelController,
  type ExperimentalPanelTabs,
  type NewThreadRequest,
  type PluginSidebarSection,
  type PluginSidebarThread,
  type PluginThreadActionsInlineItem,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  commitFailure,
  commitLabel,
  confirmQuestion,
  isNothingToCommit,
  listedPaths,
  type CheckoutChanges,
} from "./src/commit";
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
  chainCheck,
  chainWanted,
  findDesk,
  formatAgo,
  hasUnread,
  judgedOrigins,
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
import {
  AGENT_FILE_WINDOW_MS,
  CHROME_CSS,
  cardRowTitle,
  correctedWidth,
  fileName,
  firstGrowWidth,
  fitOnScreen,
  followTrail,
  newestFileSince,
  parseSlideOutRecord,
  recentItemsKey,
  threadIdForTitle,
  threadIdFromHref,
  untouched,
  workspaceFileFromHref,
  type RecentFile,
  type SlideOutRecord,
} from "./src/slideout";
import {
  EMPTY_MEMORY,
  documentTab,
  fileTarget,
  forgetTabs,
  parseMemory as parsePanelMemory,
  planSync,
  recordTabs,
  threadPanelFiles,
  threadPanelKey,
  type FileTab,
  type PanelMemory,
} from "./src/panelfiles";
import { resetLine, summariseUsage, usageLabel, usageTone, usageWord, type UsageWindow } from "./src/usage";
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
  slideOut: "bb-plugin-switchboard:slide-out",
  panelFiles: "bb-plugin-switchboard:panel-files",
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
  slideOutPanel: boolean;
  threadLinksInSlide: boolean;
  commitButton: boolean;
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
    slideOutPanel: values?.slideOutPanel !== false,
    threadLinksInSlide: values?.threadLinksInSlide !== false,
    commitButton: values?.commitButton !== false,
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

/**
 * The turns of threads that handed work on, read to follow the chain back
 * (src/waiting.ts `chainCheck`). Kept apart from `turnStore`, which keys a
 * thread by its attention, so a thread that's both listed and a sender isn't
 * read over and over. A sender is read again only when a hand-off reached
 * its recipient after the last read, since the turn it was sent from may be
 * newer than that.
 */
const chainStore = (() => {
  const entries = new Map<string, { readAt: number; segments: TurnSegment[] }>();
  const loading = new Set<string>();
  const listeners = new Set<Listener>();
  let snapshot: ReadonlyMap<string, readonly TurnSegment[]> = new Map();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
    ensure(sdk: Sdk, threadId: string, neededAt: number) {
      const entry = entries.get(threadId);
      if (loading.has(threadId) || (entry !== undefined && entry.readAt >= neededAt)) return;
      loading.add(threadId);
      const readAt = Date.now();
      sdk.threads.events
        .list({ threadId, types: TURN_EVENT_TYPES, order: "desc", limit: String(TURN_EVENT_LIMIT) })
        .then((rows) => {
          const exhausted = Array.isArray(rows) && rows.length < TURN_EVENT_LIMIT;
          entries.set(threadId, { readAt, segments: segmentTurns(parseTurnEvents(rows), exhausted) });
        })
        // Unreadable (gone, say): nothing to follow, and not asked again.
        .catch(() => entries.set(threadId, { readAt: Number.MAX_SAFE_INTEGER, segments: [] }))
        .finally(() => {
          loading.delete(threadId);
          snapshot = new Map([...entries].map(([id, value]) => [id, value.segments]));
          for (const listener of listeners) listener();
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
  const chainTurns = useSyncExternalStore(chainStore.subscribe, chainStore.get);

  // Senders that aren't active threads: their section decides a relay.
  const unknownSenders = useMemo(() => {
    const ids = new Set<string>();
    for (const map of [turns, chainTurns]) {
      for (const segments of map.values()) {
        for (const segment of segments) {
          for (const origin of segment.origins) {
            if (origin.kind === "thread" && !byId.has(origin.threadId)) ids.add(origin.threadId);
          }
        }
      }
    }
    return [...ids].sort().join(",");
  }, [turns, chainTurns, byId]);
  useEffect(() => {
    if (unknownSenders.length === 0) return;
    for (const id of unknownSenders.split(",")) senderStore.ensure(sdk, id);
  }, [sdk, unknownSenders]);
  const senders = useSyncExternalStore(senderStore.subscribe, senderStore.get);

  const inRelaySection = useMemo(
    () =>
      relayCheck(relaySections, sections, (id) => {
        const active = byId.get(id);
        if (active !== undefined) return active.sectionId;
        const sender = senders.get(id);
        return sender === undefined ? undefined : (sender?.sectionId ?? null);
      }),
    [relaySections, sections, byId, senders],
  );

  // Follow hand-offs back: read the turns of each thread that handed work to
  // a listed one, and of the threads that handed work to those.
  const chainKey = useMemo(() => {
    const listed = new Set((JSON.parse(wantedKey) as { id: string }[]).map((entry) => entry.id));
    const turnsOf = (id: string) => chainTurns.get(id);
    const wanted = new Map<string, number>();
    for (const thread of threads) {
      const segments = turns.get(thread.id);
      if (!listed.has(thread.id) || segments === undefined) continue;
      for (const [id, at] of chainWanted(judgedOrigins(thread, segments), inRelaySection, turnsOf)) {
        wanted.set(id, Math.max(wanted.get(id) ?? 0, at));
      }
    }
    return JSON.stringify([...wanted].sort(([a], [b]) => a.localeCompare(b)));
  }, [wantedKey, threads, turns, chainTurns, inRelaySection]);
  useEffect(() => {
    for (const [id, at] of JSON.parse(chainKey) as [string, number][]) chainStore.ensure(sdk, id, at);
  }, [sdk, chainKey]);

  const isRelay = useMemo(
    () => chainCheck(inRelaySection, (id) => chainTurns.get(id)),
    [inRelaySection, chainTurns],
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
  trail: string[];
  /** Where you were reading in the slide's chat: how far above its end. */
  scroll: { threadId: string; fromBottom: number } | null;
} = { mounted: 0, leftAt: null, selection: null, slideOpen: false, trail: [], scroll: null };

/** Within this of the end, a chat counts as read to the end: bb keeps it there. */
const AT_END_PX = 48;

/** The element that scrolls the slide's chat, or null while it isn't drawn. */
function chatScroller(body: HTMLElement): HTMLElement | null {
  for (const element of body.querySelectorAll<HTMLElement>("*")) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    if (/(auto|scroll)/.test(window.getComputedStyle(element).overflowY)) return element;
  }
  return null;
}

/** When you last clicked, pressed a key or focused this window, or Switchboard acted for you. */
const inputState = { lastAt: 0 };

// How long after going back the page restores the chat it had open.
const STAY_RESTORE_MS = 5_000;

/**
 * The thread something else opened in this narrow window while it showed
 * Switchboard, kept for the bar that offers it, until shown or dismissed.
 * `file` is the file its agent opened, once the page has looked: undefined
 * while it's looking, null when there was none to bring over.
 */
interface Stayed {
  threadId: string;
  at: number;
  file: RecentFile | null | undefined;
}
const stayStore = (() => {
  let current: Stayed | null = null;
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
      current = { threadId, at: Date.now(), file: undefined };
      notify();
    },
    setFile(threadId: string, file: RecentFile | null) {
      if (current === null || current.threadId !== threadId) return;
      current = { ...current, file };
      notify();
    },
    clear() {
      if (current === null) return;
      current = null;
      notify();
    },
  };
})();

/**
 * The side panel sliding out of this window (see src/slideout.ts): idle,
 * widening, out (widened, with the record of how to undo it), or shrinking
 * back. Kept for the window's life, and in sessionStorage so a reload while
 * the panel's out still knows to shrink back.
 */
type SlidePhase = "idle" | "growing" | "out" | "shrinking";
const slideOut: {
  phase: SlidePhase;
  record: SlideOutRecord | null;
  unsupported: boolean;
  shrunkAt: number;
  /** When the window last started or finished widening or shrinking. */
  changedAt: number;
} = (() => {
  const record = parseSlideOutRecord(readJson(readStorage("session", KEYS.slideOut)));
  const compact = window.matchMedia(COMPACT_QUERY).matches;
  if (record !== null && !compact && untouched(window.outerWidth, record.grownWidth)) {
    return { phase: "out", record, unsupported: false, shrunkAt: 0, changedAt: 0 };
  }
  if (record !== null) writeStorage("session", KEYS.slideOut, null);
  return { phase: "idle", record: null, unsupported: false, shrunkAt: 0, changedAt: 0 };
})();
const slideOutListeners = new Set<Listener>();
function subscribeSlideOut(listener: Listener): () => void {
  slideOutListeners.add(listener);
  return () => {
    slideOutListeners.delete(listener);
  };
}

// The page bb rebuilds while the window widens or shrinks reopens the chat
// the slide had if it mounts within this long of the change.
const SLIDE_RESTORE_MS = 4_000;

// After shrinking back, bb can bring its compact panel back for a moment;
// that's closed, not taken as a reason to widen again.
const SHRINK_SETTLE_MS = 1000;

function isCompact(): boolean {
  return window.matchMedia(COMPACT_QUERY).matches;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Resolves true once `test` holds, or false after `ms`. Timers, not frames: a hidden window still gets there. */
async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (!test()) {
    if (Date.now() >= until) return false;
    await delay(40);
  }
  return true;
}

function screenBounds(): { availLeft: number; availWidth: number } {
  const screen = window.screen as Screen & { availLeft?: number };
  return { availLeft: screen.availLeft ?? 0, availWidth: screen.availWidth };
}

/** Moves and resizes the window, as Electron lets a page do; a web browser ignores it. */
function setWindow(x: number, width: number): void {
  if (x !== window.screenX) window.moveTo(x, window.screenY);
  if (width !== window.outerWidth) window.resizeTo(width, window.outerHeight);
}

/**
 * Hides bb's icon rail and sidebar, and the window's other split panes,
 * while the panel's out (`CHROME_CSS`, only above 768px and only while a
 * Switchboard page is on screen), so the widened window is the column and the
 * panel. Not part of the plugin SDK: if bb renames these, they show, and the
 * window widens to fit them.
 */
const CHROME_STYLE_ID = "bb-plugin-switchboard-slide-out";
function setChromeHidden(hidden: boolean): void {
  const existing = document.getElementById(CHROME_STYLE_ID);
  if (!hidden) {
    existing?.remove();
    return;
  }
  if (existing !== null) return;
  const style = document.createElement("style");
  style.id = CHROME_STYLE_ID;
  style.textContent = CHROME_CSS;
  document.head.appendChild(style);
}

/**
 * Closes the window's other split panes, keeping Switchboard's, one at a
 * time with each pane's own Close button. A narrow window only draws the pane
 * in front, but once it widens bb builds every pane it holds, and a few long
 * chats there took seconds in the Mac app (Liam chose this, 4 Nov). The chats
 * themselves aren't touched. Returns how many it closed.
 */
async function closeOtherPanes(): Promise<number> {
  let closed = 0;
  for (let round = 0; round < 12; round += 1) {
    const other = [...document.querySelectorAll("[data-split-pane-id]")].find(
      (pane) => pane.querySelector(".sb-page") === null,
    );
    const button = other?.querySelector<HTMLButtonElement>('button[aria-label="Close pane"]');
    if (button == null) break;
    button.click();
    closed += 1;
    await delay(0);
  }
  return closed;
}

/**
 * Closes the split pane bb added for a thread, with that pane's own Close
 * button: the SDK can read panes but not close them. False when it can't.
 */
function closePane(paneId: string): boolean {
  const pane = document.querySelector(`[data-split-pane-id="${window.CSS.escape(paneId)}"]`);
  const button = pane?.querySelector<HTMLButtonElement>('button[aria-label="Close pane"]');
  if (button == null) return false;
  button.click();
  return true;
}

/** The on-screen button whose label starts with `label`, if there is one. */
function visibleButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
    if (!(candidate.getAttribute("aria-label") ?? "").startsWith(label)) return false;
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
  });
}

/**
 * Presses bb's panel shortcut (⌘J, "panel.toggle") from code: bb listens for
 * its shortcuts at window level. Only when bb's own panel button says ⌘J is
 * still the shortcut, so a rebound key isn't pressed by mistake. Not part of
 * the plugin SDK. True when it pressed it.
 */
function sendPanelShortcut(): boolean {
  if (!/mac/i.test(navigator.platform)) return false;
  const bound = [...document.querySelectorAll("button[aria-label]")].some((button) =>
    /right panel \(⌘ ?J\)$/.test(button.getAttribute("aria-label") ?? ""),
  );
  if (!bound) return false;
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, bubbles: true, cancelable: true }),
  );
  return true;
}

/** Step-by-step notes on the slide-out, with localStorage `bb-plugin-switchboard:debug` set to 1. */
function debugLog(...parts: unknown[]): void {
  if (readStorage("local", "bb-plugin-switchboard:debug") === "1") {
    const line = `${new Date().toISOString().slice(11, 23)} ${JSON.stringify(parts)}`;
    console.log(`[switchboard] ${line}`);
    const log = ((window as unknown as { __switchboardLog?: string[] }).__switchboardLog ??= []);
    log.push(line);
    if (log.length > 200) log.splice(0, log.length - 200);
  }
}

function saveSlideOut(phase: SlidePhase, record: SlideOutRecord | null): void {
  slideOut.phase = phase;
  slideOut.record = record;
  slideOut.changedAt = Date.now();
  setChromeHidden(phase !== "idle");
  if (phase === "idle") {
    delete document.documentElement.dataset.switchboardSlide;
    document.documentElement.style.removeProperty("--sb-slide-column");
    applyTitleShift(null);
  } else {
    document.documentElement.dataset.switchboardSlide = phase;
    if (record !== null) document.documentElement.style.setProperty("--sb-slide-column", `${record.column}px`);
  }
  for (const listener of slideOutListeners) listener();
  writeStorage(
    "session",
    KEYS.slideOut,
    phase === "out" && record !== null ? JSON.stringify(record) : null,
  );
}

// Commands run outside React, so the overlay keeps these current.
const live: {
  navigate: BbNavigate | null;
  pluginId: string | null;
  threadId: string | null;
  note: ((message: string) => void) | null;
} = { navigate: null, pluginId: null, threadId: null, note: null };

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
    live.note = (message) => {
      void rpc.call("note", { windowId, message: message.slice(0, 600) }).catch(() => undefined);
    };
    return () => {
      live.navigate = null;
      live.note = null;
    };
  }, [navigate, pluginId, rpc, windowId]);

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
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    const threadId = context.threadId;
    if (threadId === null) return;
    const now = Date.now();
    const msSinceSwitchboard =
      pageState.mounted > 0 ? 0 : pageState.leftAt === null ? null : now - pageState.leftAt;
    const stay = shouldStayOnSwitchboard({
      enabled: stayEnabled,
      compact: window.matchMedia(COMPACT_QUERY).matches,
      widened: slideOut.phase === "out",
      msSinceSwitchboard,
      threadId,
      msSinceInput: now - inputState.lastAt,
    });
    if (!stay) return;
    stayStore.set(threadId);
    if (window.matchMedia(COMPACT_QUERY).matches) {
      navigate.toPluginPanel(PANEL_PATH, { replace: true });
      return;
    }
    // Widened, bb adds the thread as a split beside Switchboard rather than
    // swapping it in: close that pane, and Switchboard is what's left. bb's
    // layout can arrive a moment after the route.
    let cancelled = false;
    const addedPane = () => {
      const panes = layoutRef.current?.panes ?? [];
      return panes.length > 1 ? panes.find((pane) => pane.threadId === threadId) : undefined;
    };
    void waitFor(() => addedPane() !== undefined, 600).then(() => {
      if (cancelled) return;
      const added = addedPane();
      if (added !== undefined && closePane(added.paneId)) return;
      navigate.toPluginPanel(PANEL_PATH, { replace: true });
    });
    return () => {
      cancelled = true;
    };
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

/**
 * A still copy of the slide's chat, shown while the window widens or shrinks
 * and until the live chat has redrawn: bb rebuilds the page as the window
 * crosses 768px, and a long chat takes a second or more to draw again, which
 * left the slide blank.
 */
interface ChatSnapshot {
  node: HTMLElement;
  /** Scroll offsets of the copied elements, by their order in the copy. */
  scrolls: [number, number, number][];
  textLength: number;
}
const snapshotStore = (() => {
  let current: ChatSnapshot | null = null;
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
    set(next: ChatSnapshot | null) {
      current = next;
      notify();
    },
  };
})();

/** Copies the chat now in the slide, if there's one; returns a note of what it cost, for the log. */
function captureChatSnapshot(): string | null {
  const started = performance.now();
  const body = slideLive.root?.querySelector(".sb-slide-body");
  const chat = body?.querySelector(":scope > :not(.sb-chat-held):not(.sb-chat-snapshot)");
  if (!(chat instanceof HTMLElement)) return null;
  const scrolls: [number, number, number][] = [];
  chat.querySelectorAll("*").forEach((element, index) => {
    if (element.scrollTop > 0 || element.scrollLeft > 0) {
      scrolls.push([index, element.scrollTop, element.scrollLeft]);
    }
  });
  // A chat still loading (no text yet) isn't worth copying.
  const textLength = chat.textContent?.length ?? 0;
  if (textLength < 40) return null;
  const node = chat.cloneNode(true) as HTMLElement;
  snapshotStore.set({ node, scrolls, textLength });
  return `copied chat (${node.getElementsByTagName("*").length} elements) ${Math.round(performance.now() - started)}ms`;
}

/**
 * The copy, over the slide's body. Once the chat is live again, it stays
 * until the live chat has drawn most of what the copy shows (or four
 * seconds), then goes.
 */
function ChatSnapshotView({ snapshot, live }: { snapshot: ChatSnapshot; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const holder = ref.current;
    if (holder === null) return;
    // The copy itself the first time; a fresh one if bb rebuilt the page.
    const copy = snapshot.node.isConnected ? (snapshot.node.cloneNode(true) as HTMLElement) : snapshot.node;
    copy.inert = true;
    holder.replaceChildren(copy);
    const elements = copy.querySelectorAll("*");
    for (const [index, top, left] of snapshot.scrolls) {
      const element = elements[index];
      if (element !== undefined) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
  }, [snapshot]);
  useEffect(() => {
    if (!live) return;
    const holder = ref.current;
    const until = Date.now() + 4000;
    let timer = 0;
    const check = () => {
      const body = holder?.parentElement;
      const chat = body?.querySelector(":scope > :not(.sb-chat-held):not(.sb-chat-snapshot)");
      const drawn = chat?.textContent?.length ?? 0;
      if (drawn >= snapshot.textLength * 0.6 || Date.now() >= until) {
        if (snapshotStore.get() === snapshot) snapshotStore.set(null);
        return;
      }
      timer = window.setTimeout(check, 100);
    };
    timer = window.setTimeout(check, 100);
    return () => window.clearTimeout(timer);
  }, [live, snapshot]);
  return <div ref={ref} className="sb-chat-snapshot" aria-hidden="true" />;
}

/**
 * What the slide-out works with, from whichever Switchboard page is showing.
 * Crossing bb's 768px line rebuilds bb's layout, so the page that started
 * widening the window isn't the one that finishes; these always point at the
 * current one.
 */
const slideLive: {
  tabs: ExperimentalPanelTabs | null;
  panel: ExperimentalPanelController | null;
  root: HTMLDivElement | null;
  navigate: BbNavigate | null;
} = { tabs: null, panel: null, root: null, navigate: null };

function panelOpenNow(): boolean {
  return slideLive.tabs?.open ?? false;
}

/**
 * bb's panel is docked beside the page: what's on screen, which bb's open
 * flag can lag behind. The panel's own box (`thread-detail-secondary-panel…`,
 * which is zero wide while it's closed), since the page keeps its column's
 * width while the window changes size.
 */
function panelBeside(): boolean {
  if (isCompact()) return false;
  return [...document.querySelectorAll('[data-panel-id^="thread-detail-secondary-panel"]')].some(
    (panel) => panel.getBoundingClientRect().width > 100,
  );
}

/** A row of bb's Threads card: the button that opens its thread (not "Show the whole message"). */
const CARD_ROW_SELECTOR = 'section[aria-label="Threads"] li button[title^="Open “"]';

interface ReactFiberish {
  memoizedProps?: unknown;
  return?: ReactFiberish | null;
}

/**
 * The thread a Threads card row opens. bb draws the row as a button with no
 * link, titled `Open “<thread title>”`, so the title picks it out when only
 * one thread has it. Two threads with the same title fall back to the row's
 * React props (a `thread` prop a level or two up), which aren't bb's API and
 * may change; with neither, the click is left to bb.
 */
function cardRowThread(row: Element, threads: Iterable<{ id: string; displayTitle: string }>): string | null {
  const title = cardRowTitle(row.getAttribute("title") ?? "");
  if (title === null) return null;
  const byTitle = threadIdForTitle(title, threads);
  if (byTitle !== null) return byTitle;
  try {
    const key = Object.keys(row).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key === undefined ? null : ((row as unknown as Record<string, ReactFiberish>)[key] ?? null);
    for (let depth = 0; depth < 4 && fiber !== null && fiber !== undefined; depth += 1) {
      const props = fiber.memoizedProps as { thread?: { id?: unknown; title?: unknown } } | null | undefined;
      const id = props?.thread?.id;
      if (typeof id === "string" && /^thr_[a-z0-9]+$/.test(id)) return id;
      fiber = fiber.return ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A workspace file linked from the chat in the slide, opened in the side
 * panel as bb opens it in a thread's own view (in a narrow window, the panel
 * then slides out). False when the link isn't a file in that chat's
 * workspace, or bb wouldn't open it, so the click is left to bb.
 */
function openLinkedFile(
  href: string,
  threadId: string | null,
  threads: ReadonlyMap<string, PluginSidebarThread>,
): boolean {
  if (threadId === null) return false;
  const environment = threads.get(threadId)?.environment ?? null;
  const navigate = slideLive.navigate;
  if (environment === null || environment.id === null || navigate === null) return false;
  const path = workspaceFileFromHref(href, environment.path);
  if (path === null) return false;
  const opened = navigate.experimental_openFilePreview({
    target: { kind: "workspace", environmentId: environment.id, path },
    location: null,
  });
  debugLog("file link", { href, path, opened });
  if (!opened) return false;
  // In the compact layout bb adds the tab without showing the panel: select it.
  const tabFor = () =>
    fileTabsOf(slideLive.tabs).find((tab) => tab.path === path || tab.path.endsWith(`/${path}`));
  void waitFor(() => tabFor() !== undefined || panelOpenNow(), 1500).then(() => {
    const tab = tabFor();
    if (tab === undefined || panelOpenNow()) return;
    showPanelTab(tab.key);
  });
  return true;
}

/**
 * Switchboard's title in bb's header row (the row outside the side panel
 * that names it). The narrow and wide layouts put the header row in
 * different places (in the Mac app the wide one sits below the window's
 * traffic lights), so while the panel's out the row is moved back to where
 * the title was in the narrow window: `--sb-title-dx`/`--sb-title-dy`.
 */
function switchboardTitle(): Element | null {
  for (const row of document.querySelectorAll('[data-testid="app-page-header-content-row"]')) {
    if (row.closest("aside") !== null || row.getBoundingClientRect().width === 0) continue;
    const title = [...row.querySelectorAll("*")].find(
      (element) => element.childElementCount === 0 && element.textContent?.trim() === "Switchboard",
    );
    if (title !== undefined) return title;
  }
  return null;
}

/** Where the title (and the usage rings' right edge) were in the narrow window, measured just before widening. */
let narrowTitle: { left: number; centreY: number; gaugeRight: number | null } | null = null;

function usageGaugeRect(): DOMRect | null {
  const gauge = [...document.querySelectorAll(".sb-usage")].find((element) => element.closest("aside") === null);
  return gauge?.getBoundingClientRect() ?? null;
}

function noteNarrowTitle(): void {
  const rect = switchboardTitle()?.getBoundingClientRect();
  narrowTitle =
    rect === undefined
      ? null
      : { left: rect.left, centreY: rect.top + rect.height / 2, gaugeRight: usageGaugeRect()?.right ?? null };
}

/**
 * The last move that put the title back in place, kept (in localStorage, as
 * it depends on bb's layout, not the window) so the next widen applies it
 * before the window changes size and the title never leaves its place.
 */
const TITLE_SHIFT_KEY = "bb-plugin-switchboard:title-shift";
interface TitleShift {
  dx: number;
  dy: number;
  /** Extra right padding, so the usage rings stay where they were. */
  dr: number;
}
function readTitleShift(): TitleShift | null {
  const value = readJson(readStorage("local", TITLE_SHIFT_KEY));
  if (typeof value !== "object" || value === null) return null;
  const { dx, dy, dr } = value as Record<string, unknown>;
  return typeof dx === "number" && typeof dy === "number"
    ? { dx, dy, dr: typeof dr === "number" ? dr : 0 }
    : null;
}
function applyTitleShift(shift: TitleShift | null): void {
  const root = document.documentElement;
  if (shift === null) {
    root.style.removeProperty("--sb-title-dx");
    root.style.removeProperty("--sb-title-dy");
    root.style.removeProperty("--sb-title-dr");
    return;
  }
  root.style.setProperty("--sb-title-dx", `${shift.dx}px`);
  root.style.setProperty("--sb-title-dy", `${shift.dy}px`);
  root.style.setProperty("--sb-title-dr", `${shift.dr}px`);
}

/**
 * Moves the wide layout's title row so the title sits where it did in the
 * narrow window, correcting whatever move is already applied; returns the
 * move, for the log.
 */
function keepTitleInPlace(): string {
  const rect = switchboardTitle()?.getBoundingClientRect();
  if (narrowTitle === null || rect === undefined) return "title not found";
  const current = readTitleShift() ?? { dx: 0, dy: 0, dr: 0 };
  const applied = document.documentElement.style.getPropertyValue("--sb-title-dx") !== "";
  const base = applied ? current : { dx: 0, dy: 0, dr: 0 };
  const gauge = usageGaugeRect();
  const shift: TitleShift = {
    dx: Math.round(base.dx + narrowTitle.left - rect.left),
    dy: Math.round(base.dy + narrowTitle.centreY - (rect.top + rect.height / 2)),
    dr: Math.max(
      0,
      Math.round(
        base.dr + (narrowTitle.gaugeRight !== null && gauge !== null ? gauge.right - narrowTitle.gaugeRight : 0),
      ),
    ),
  };
  if (shift.dx !== base.dx || shift.dy !== base.dy || shift.dr !== base.dr || !applied) applyTitleShift(shift);
  writeStorage("local", TITLE_SHIFT_KEY, JSON.stringify(shift));
  return `title moved ${shift.dx},${shift.dy}px, rings ${shift.dr}px`;
}

/** The box bb gives the page beside the panel (Switchboard's own page is pinned meanwhile). */
function pageAreaRect(): DOMRect | null {
  // bb's page area: `plugin-panel-main-<pane>` with one pane, inside
  // `split-workspace-main-panel` with a split.
  const area =
    slideLive.root?.closest('[data-panel-id^="plugin-panel-main"]') ??
    slideLive.root?.closest('[data-panel-id="split-workspace-main-panel"]') ??
    document.querySelector('[data-panel-id="split-workspace-main-panel"]');
  return area?.getBoundingClientRect() ?? slideLive.root?.getBoundingClientRect() ?? null;
}

/** Widens the window for the panel that just opened in the compact layout. */
/**
 * Shows a file tab Switchboard has just added beside the page. In the narrow
 * window it widens first and opens the tab docked, rather than showing it
 * full-window and then widening: bb rebuilds the page when the window crosses
 * 768px, and the chat in the slide redraws each time, so once is quicker.
 */
function showPanelTab(key: string): void {
  if (slideOut.phase === "idle" && isCompact() && !slideOut.unsupported) {
    void growForPanel(key);
    return;
  }
  slideLive.panel?.selectTab(key);
}

async function growForPanel(tabKey?: string): Promise<void> {
  const started = performance.now();
  const steps: string[] = [];
  const mark = (step: string) => steps.push(`${step} ${Math.round(performance.now() - started)}ms`);
  // Copy the chat before the page drops it (see `chatHeld`), and note where
  // the title sits in the narrow header.
  noteNarrowTitle();
  applyTitleShift(readTitleShift());
  const copied = captureChatSnapshot();
  if (copied !== null) steps.push(copied);
  saveSlideOut("growing", null);
  // The chat in the slide's documents, not whatever the panel last showed.
  const documentKey = await syncPanelContents({ mayClosePanel: false });
  if (documentKey !== null) mark("documents");
  const key = tabKey ?? documentKey ?? slideLive.tabs?.selectedKey ?? null;
  const column = Math.round(slideLive.root?.clientWidth || window.innerWidth);
  const narrowWidth = window.outerWidth;
  const narrowX = window.screenX;
  const scale = window.outerWidth / window.innerWidth || 1;
  // An empty panel (bb's New tab page) never carries over to the docked
  // layout, and bb keeps counting it as open for a second or more after the
  // change, which holds up its Show button: close it first.
  const empty = key === null || key.startsWith("new-tab:");
  // Close the full-window panel first, so the window widens with the chat
  // still showing and the panel arrives beside it, rather than bb's narrow
  // panel stretching across the wider window while bb redraws.
  if (panelOpenNow()) {
    slideLive.panel?.close();
    await waitFor(() => !panelOpenNow(), 300);
  }
  document.documentElement.style.setProperty("--sb-slide-column", `${column}px`);
  // The page drops the slide's chat while the window changes layout (see
  // `chatHeld`), so bb's rebuild at 768px doesn't redraw it: let that land.
  await delay(30);
  const first = fitOnScreen(narrowX, firstGrowWidth({ column, scale }), screenBounds());
  setWindow(first.x, first.width);
  if (!(await waitFor(() => !isCompact(), 1500))) {
    // Not Electron, or the window couldn't grow: the panel as bb has it.
    if (window.outerWidth === narrowWidth) slideOut.unsupported = true;
    setWindow(narrowX, narrowWidth);
    saveSlideOut("idle", null);
    if (!panelOpenNow()) visibleButton("Show right panel")?.click();
    noteTiming("slide-out gave up: the window didn't widen", steps);
    return;
  }
  mark("widened");
  // The window's hidden panes go, so the next widen doesn't build them again.
  const closedPanes = await closeOtherPanes();
  if (closedPanes > 0) mark(`closed ${closedPanes} hidden pane${closedPanes === 1 ? "" : "s"}`);
  // Open it beside the column: by its tab, or (an empty panel, the New tab
  // page, which bb won't select) with bb's shortcut or Show button.
  if (!panelBeside() && key !== null && !empty) {
    slideLive.panel?.selectTab(key);
    await waitFor(panelBeside, 300);
    mark(panelBeside() ? "reopened by tab" : "tab didn't reopen");
  }
  // For a second or so after the layout changes bb can still count the
  // compact panel as open, which hides its Show button (or makes it read
  // Hide): close it, then press Show, rather than waiting it out.
  // Quickest: bb's own panel shortcut, while bb shows no button for a second
  // or so after the change.
  if (!panelBeside() && !panelOpenNow() && sendPanelShortcut()) {
    await waitFor(panelBeside, 400);
    mark(panelBeside() ? "shortcut" : "shortcut, not docked");
  }
  const until = Date.now() + 2000;
  while (!panelBeside() && Date.now() < until) {
    const show = visibleButton("Show right panel");
    if (show !== undefined) {
      show.click();
      await waitFor(panelBeside, 500);
      mark(panelBeside() ? "show pressed" : "show pressed, not docked");
      continue;
    }
    const hide = visibleButton("Hide right panel");
    if (hide !== undefined) {
      hide.click();
      await waitFor(() => panelBeside() || visibleButton("Show right panel") !== undefined, 300);
      mark("stale hide pressed");
      continue;
    }
    // Neither button shows while bb thinks a collapsed panel is open: close
    // it through the plugin API, which brings its Show button back.
    if (panelOpenNow()) {
      slideLive.panel?.close();
      await waitFor(() => panelBeside() || visibleButton("Show right panel") !== undefined, 300);
      mark("stale panel closed");
      continue;
    }
    await delay(40);
  }
  if (!panelBeside()) {
    // It wouldn't open beside the page: back to how it was.
    setWindow(narrowX, narrowWidth);
    await waitFor(isCompact, 1500);
    slideOut.shrunkAt = Date.now();
    saveSlideOut("idle", null);
    noteTiming("slide-out gave up: the panel wouldn't dock", steps);
    return;
  }
  mark("docked");
  // bb animates the panel open: measure once the column stops moving.
  const rect = await settledRect();
  if (rect !== null) {
    const target = correctedWidth({
      outerWidth: window.outerWidth,
      innerWidth: window.innerWidth,
      scale: window.outerWidth / window.innerWidth || 1,
      contentLeft: rect.left,
      column: rect.width,
      wantColumn: column,
    });
    if (target !== null && Math.abs(target - window.outerWidth) > 4) {
      const fitted = fitOnScreen(window.screenX, target, screenBounds());
      setWindow(fitted.x, fitted.width);
      mark(`corrected ${Math.round(rect.width)}px column to ${column}px`);
    }
  }
  saveSlideOut("out", {
    narrowWidth,
    narrowX,
    moved: window.screenX !== narrowX,
    grownWidth: window.outerWidth,
    column,
  });
  steps.push(keepTitleInPlace());
  noteTiming(`slide-out to ${window.outerWidth}px`, steps);
  window.setTimeout(noteHeaderBand, 600);
}

/** The page area's box once it has stopped changing size (bb's panel animates), or null. */
async function settledRect(): Promise<DOMRect | null> {
  let last = pageAreaRect();
  const until = Date.now() + 500;
  let still = 0;
  while (Date.now() < until && still < 2) {
    await delay(40);
    const next = pageAreaRect();
    still = next !== null && last !== null && Math.abs(next.width - last.width) < 0.5 ? still + 1 : 0;
    last = next;
  }
  return last;
}

/**
 * Once per page load, what's drawn in the top-left corner of the widened
 * window, to the plugin log: the Mac app lays its title row out differently
 * from a browser, and this is the only way to see it.
 */
let headerNoted = false;
function noteHeaderBand(): void {
  if (headerNoted) return;
  headerNoted = true;
  const items: string[] = [];
  for (const element of document.querySelectorAll("button, a, [role=button], [data-testid]")) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.top > 120 || rect.left > 420) continue;
    const label =
      element.getAttribute("aria-label") ??
      element.getAttribute("data-testid") ??
      element.getAttribute("title") ??
      (element.textContent ?? "").trim().slice(0, 24);
    items.push(`${element.tagName.toLowerCase()} "${label}" at ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}w`);
  }
  live.note?.(`title row: ${items.slice(0, 20).join("; ")}`);
}

/**
 * One line in Switchboard's plugin log (`bb plugin logs switchboard`) with how
 * long each step of a slide-out took, so the Mac app's timings can be read
 * without opening its console.
 */
function noteTiming(what: string, steps: readonly string[]): void {
  const line = `${what}: ${steps.join(", ")}`;
  debugLog(line);
  live.note?.(line);
}

/** Shrinks the window back once the panel's closed, unless you've resized it by hand. */
async function shrinkForPanel(): Promise<void> {
  const record = slideOut.record;
  if (record === null || !untouched(window.outerWidth, record.grownWidth)) {
    // Resized by hand: it stays that size, back to bb's own layout.
    debugLog("not shrinking", { record, width: window.outerWidth });
    saveSlideOut("idle", null);
    return;
  }
  const started = performance.now();
  const copied = captureChatSnapshot();
  saveSlideOut("shrinking", record);
  await delay(30);
  setWindow(record.moved ? record.narrowX : window.screenX, record.narrowWidth);
  await waitFor(isCompact, 1500);
  const narrowed = Math.round(performance.now() - started);
  // bb can bring the compact panel back as it changes layout: close it, or
  // it covers the window.
  if (await waitFor(panelOpenNow, 300)) slideLive.panel?.close();
  slideOut.shrunkAt = Date.now();
  saveSlideOut("idle", null);
  noteTiming(`shrank to ${window.outerWidth}px`, [...(copied === null ? [] : [copied]), `narrowed ${narrowed}ms`]);
}

/**
 * The side panel sliding out of a narrow window. When this page's side panel
 * opens in bb's compact layout (where it would cover the window), the window
 * widens to the right so the panel docks beside the page, and the page's
 * column keeps its width; when the panel closes, the window shrinks back,
 * unless you've resized it by hand meanwhile. Rules in src/slideout.ts.
 * Returns whether the panel is open, for tests to read off the page.
 */
function useSlideOut(
  enabled: boolean,
  rootRef: { current: HTMLDivElement | null },
): { open: boolean; phase: SlidePhase } {
  const tabs = usePanelTabs();
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  slideLive.tabs = tabs;
  slideLive.panel = panel;
  slideLive.navigate = navigate;
  useEffect(() => {
    const root = rootRef.current;
    slideLive.root = root;
    // A reload while the panel was out: keep bb's chrome hidden.
    if (slideOut.phase !== "idle") setChromeHidden(true);
    return () => {
      if (slideLive.root === root) slideLive.root = null;
    };
  }, [rootRef]);
  const phase = useSyncExternalStore(subscribeSlideOut, () => slideOut.phase);

  // Opening the panel in the narrow window: widen first and open it docked,
  // rather than letting bb show it full-window and then widening.
  useEffect(() => {
    if (!enabled) return;
    const takes = () =>
      slideOut.phase === "idle" &&
      !slideOut.unsupported &&
      isCompact() &&
      !panelOpenNow() &&
      (slideLive.root?.isConnected ?? false);
    const onClick = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest("button[aria-label]") : null;
      if (button === null || !(button.getAttribute("aria-label") ?? "").startsWith("Show right panel")) return;
      if (!takes()) return;
      event.preventDefault();
      event.stopPropagation();
      void growForPanel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted || !event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return;
      if (event.key.toLowerCase() !== "j" || !takes()) return;
      event.preventDefault();
      event.stopPropagation();
      void growForPanel();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || slideOut.unsupported) return;
    debugLog("panel", { open: tabs.open, phase, compact: isCompact() });
    if (phase === "idle" && tabs.open && isCompact()) {
      if (Date.now() - slideOut.shrunkAt < SHRINK_SETTLE_MS) panel.close();
      else void growForPanel();
      return;
    }
    if (phase === "out" && !tabs.open) {
      // A beat first: a panel that's only switching tabs reopens at once.
      const timer = window.setTimeout(() => {
        if (slideOut.phase === "out" && !panelOpenNow()) void shrinkForPanel();
      }, 120);
      return () => window.clearTimeout(timer);
    }
  }, [enabled, tabs.open, phase, panel]);
  return { open: tabs.open, phase };
}


/**
 * The panel's files, per chat in the slide (rules in src/panelfiles.ts),
 * kept for the window's life and in sessionStorage for a reload. `agent` is
 * the file an agent's `bb thread open` is bringing over, so its tab is filed
 * under that agent's thread. Tabs Switchboard closes itself are listed in
 * `closedByUs`, so they stay remembered; changes while `quietUntil` hasn't
 * passed are Switchboard's own, not yours.
 */
const panelState: {
  memory: PanelMemory;
  firstSeenAt: number | null;
  closedByUs: Set<string>;
  quietUntil: number;
  agent: { threadId: string; path: string } | null;
  /** The chat the panel last followed: survives bb rebuilding the page. */
  lastView: { view: string | null; keep: string | null } | null;
  /** The chat in the slide now, and an agent's thread whose bar is up. */
  view: string | null;
  keep: string | null;
} = {
  memory: (() => {
    try {
      return parsePanelMemory(readJson(readStorage("session", KEYS.panelFiles)));
    } catch {
      return EMPTY_MEMORY;
    }
  })(),
  firstSeenAt: null,
  closedByUs: new Set(),
  quietUntil: 0,
  agent: null,
  lastView: null,
  view: null,
  keep: null,
};

// Tabs already in the panel when Switchboard first looks, within this long,
// belong to no chat.
const LEGACY_TABS_MS = 1500;

function savePanelMemory(next: PanelMemory): void {
  if (next === panelState.memory) return;
  panelState.memory = next;
  writeStorage("session", KEYS.panelFiles, JSON.stringify(next));
}

/** The panel's document tabs: file previews and file openers' tabs (the PDF viewer's, say). */
function fileTabsOf(tabs: ExperimentalPanelTabs | null): FileTab[] {
  return (tabs?.tabs ?? []).flatMap((tab) => {
    const document = documentTab(tab.key, tab.detail, { threadId: null, environmentId: undefined });
    return document === null ? [] : [document];
  });
}

/**
 * Brings the panel's tabs in line with the chat in the slide: closes other
 * chats' documents (not an agent's whose bar is up), opens this chat's (its
 * thread's documents in bb's own panel, then the ones opened for it here),
 * and with `mayClosePanel` closes the panel when that leaves nothing.
 * Resolves with the key of one of the chat's documents once it's open, to
 * show, or null.
 */
async function syncPanelContents(options: { mayClosePanel: boolean }): Promise<string | null> {
  const view = panelState.view;
  if (view === null || slideLive.tabs === null) return null;
  const threadFiles = threadPanelFiles(readStorage("local", threadPanelKey(view)), view);
  const plan = planSync({
    view,
    tabs: fileTabsOf(slideLive.tabs),
    memory: panelState.memory,
    keep: panelState.keep,
    threadFiles,
  });
  if (plan.close.length > 0 || plan.open.length > 0) {
    debugLog("panel follows", { view, keep: panelState.keep, close: plan.close, open: plan.open });
    panelState.quietUntil = Date.now() + 1500;
    for (const key of plan.close) {
      panelState.closedByUs.add(key);
      slideLive.panel?.closeTab(key);
    }
    for (const target of plan.open) slideLive.navigate?.experimental_openFilePreview({ target, location: null });
  }
  if (plan.closePanel) {
    if (options.mayClosePanel && panelOpenNow()) slideLive.panel?.close();
    return null;
  }
  const paths = [...threadFiles, ...(panelState.memory.files[view] ?? [])].map((file) => file.path);
  const path = plan.open.at(-1)?.path ?? paths.at(-1);
  if (path === undefined) return null;
  await waitFor(() => fileTabsOf(slideLive.tabs).some((tab) => tab.path === path), 1000);
  return fileTabsOf(slideLive.tabs).find((tab) => tab.path === path)?.key ?? null;
}

/**
 * The side panel shows the chat in the slide's documents, as bb's panel shows
 * the thread you're in. Whether it's open is yours: with it open, moving to
 * another chat swaps the documents (or closes it when the chat has none);
 * with it closed, nothing opens; opening it shows the chat's documents (done
 * before the window widens, in `growForPanel`). With no chat in the slide,
 * nothing moves. Only what you do moves it: an agent's file waits behind the
 * bar's Show (see `useStayedFile`).
 */
function usePanelFollowsSlide(
  enabled: boolean,
  view: string | null,
  environmentOf: (threadId: string) => string | undefined,
): void {
  const tabs = usePanelTabs();
  const phase = useSyncExternalStore(subscribeSlideOut, () => slideOut.phase);
  const environmentRef = useRef(environmentOf);
  environmentRef.current = environmentOf;
  const fileTabs = useMemo(() => fileTabsOf(tabs), [tabs]);
  const signature = fileTabs.map((tab) => tab.key).join("\n");
  const keep: string | null = null;
  panelState.view = enabled ? view : null;
  panelState.keep = keep;

  // Note the tabs that came and went.
  useEffect(() => {
    if (!enabled) return;
    panelState.firstSeenAt ??= Date.now();
    let memory = forgetTabs(panelState.memory, fileTabs, panelState.closedByUs);
    for (const key of panelState.closedByUs) {
      if (!fileTabs.some((tab) => tab.key === key)) panelState.closedByUs.delete(key);
    }
    memory = recordTabs(memory, fileTabs, {
      view,
      agent: panelState.agent,
      legacy: Date.now() - panelState.firstSeenAt < LEGACY_TABS_MS,
      targetFor: (tab, owner) =>
        fileTarget(tab, { threadId: owner, environmentId: environmentRef.current(owner) }),
    });
    if (memory !== panelState.memory) debugLog("panel files", memory);
    savePanelMemory(memory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, view]);

  // Moving to another chat with the panel open swaps its documents.
  useEffect(() => {
    if (!enabled || view === null) return;
    if (phase === "growing" || phase === "shrinking") return;
    const previous = panelState.lastView;
    const moved = previous === null || previous.view !== view || previous.keep !== keep;
    panelState.lastView = { view, keep };
    if (!tabs.open) return;
    const timer = window.setTimeout(() => {
      if (!panelOpenNow()) return;
      void syncPanelContents({ mayClosePanel: moved });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [enabled, view, keep, phase, tabs.open]);
}

/**
 * After an agent's `bb thread open` sent this window back to Switchboard
 * (see `stayStore`), the file it opened, from bb's recent items for that
 * thread, so the bar can name it. Nothing opens: what's on screen is yours
 * (Liam, 10 Nov), and the bar's Show opens the thread and the file
 * (`openAgentFile`). bb writes the item once the thread view has opened the
 * file, so it's looked for for a couple of seconds.
 */
function useStayedFile(enabled: boolean, stayed: Stayed | null): void {
  const threadId = stayed?.threadId ?? null;
  const at = stayed?.at ?? 0;
  const looking = stayed !== null && stayed.file === undefined;
  useEffect(() => {
    if (!looking || threadId === null) return;
    if (!enabled) {
      stayStore.setFile(threadId, null);
      return;
    }
    let cancelled = false;
    const until = Date.now() + 2500;
    const look = () => {
      if (cancelled) return;
      const file = newestFileSince(
        readStorage("local", recentItemsKey(threadId)),
        at - AGENT_FILE_WINDOW_MS,
      );
      if (file === null) {
        if (Date.now() < until) window.setTimeout(look, 150);
        else stayStore.setFile(threadId, null);
        return;
      }
      debugLog("stayed file", { threadId, file });
      stayStore.setFile(threadId, file);
    };
    look();
    return () => {
      cancelled = true;
    };
  }, [enabled, looking, threadId, at]);
}

/** Where an agent's file is, for bb's file preview; null when it can't be placed. */
function agentFileTarget(threadId: string, file: RecentFile, environmentId: string | undefined) {
  return file.source === "thread-storage"
    ? ({ kind: "thread-storage", threadId, path: file.path } as const)
    : environmentId === undefined
      ? null
      : ({ kind: "workspace", environmentId, path: file.path } as const);
}

/**
 * The bar's Show for an agent's file: the file in Switchboard's side panel,
 * which slides out, beside its thread in the slide. Its tab belongs to the
 * agent's thread. Called once that thread is the slide's, so the panel's
 * documents (`usePanelFollowsSlide`) take it as the chat's own.
 */
function openAgentFile(
  navigate: BbNavigate,
  threadId: string,
  file: RecentFile,
  target: NonNullable<ReturnType<typeof agentFileTarget>>,
): boolean {
  panelState.agent = { threadId, path: file.path };
  const opened = navigate.experimental_openFilePreview({ target, location: null });
  debugLog("agent file shown", { threadId, file, opened });
  if (!opened) return false;
  // In the compact layout bb adds the tab without showing the panel: select
  // it, which does, and the panel slides out. A file tab, or a file opener's
  // (a PDF opens in the PDF viewer's).
  const tabFor = () => fileTabsOf(slideLive.tabs).find((tab) => tab.path === file.path);
  void (async () => {
    await waitFor(() => tabFor() !== undefined || panelOpenNow(), 1500);
    const tab = tabFor();
    if (tab !== undefined && !panelOpenNow()) showPanelTab(tab.key);
    // bb sometimes shows the panel itself, and the window then widens with
    // the chat's documents, the last one in front: once it's settled, the
    // agent's file is the one showing.
    await waitFor(() => slideOut.phase !== "growing" && panelOpenNow(), 4000);
    await delay(150);
    const settled = tabFor();
    if (settled !== undefined && slideLive.tabs?.selectedKey !== settled.key) {
      slideLive.panel?.selectTab(settled.key);
    }
  })();
  return true;
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
  // Or bb rebuilt its layout as the window widened or shrank for the side panel.
  const [restore] = useState(() => {
    const stayed = stayStore.get();
    if (stayed !== null && Date.now() - stayed.at < STAY_RESTORE_MS) return true;
    return (
      slideOut.phase === "growing" ||
      slideOut.phase === "shrinking" ||
      Date.now() - slideOut.changedAt < SLIDE_RESTORE_MS
    );
  });
  const [selection, setSelection] = useState<Selection>(() =>
    restore ? pageState.selection : null,
  );
  const [slideOpen, setSlideOpen] = useState(() => restore && pageState.slideOpen);
  // The chats you followed links from to reach the one in the slide, oldest
  // first: ← steps back through them before closing the slide.
  const [trail, setTrail] = useState<string[]>(() => (restore ? pageState.trail : []));
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
    pageState.trail = trail;
  }, [selection, slideOpen, trail]);
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

  // The side panel slides out of a narrow window, and a file an agent opened
  // comes over to it.
  const slide = useSlideOut(settings.slideOutPanel, rootRef);
  // While the window widens or shrinks for the panel, the chat waits: bb
  // rebuilds the page as the window crosses 768px, and redrawing a long chat
  // there took seconds in the Mac app. It's drawn once the panel's settled.
  const chatHeld = slide.phase === "growing" || slide.phase === "shrinking";
  const snapshot = useSyncExternalStore(snapshotStore.subscribe, snapshotStore.get);
  const environmentOf = useCallback(
    (threadId: string) => byId.get(threadId)?.environment?.id ?? undefined,
    [byId],
  );
  // An agent's file is only named on the bar; Show opens it.
  useStayedFile(settings.slideOutPanel, stayed);
  // The panel's files follow the chat in the slide.
  const slideView = slideOpen && selection?.kind === "thread" ? selection.id : null;
  usePanelFollowsSlide(settings.slideOutPanel, slideView, environmentOf);

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

  // A chat in the slide. From a row it starts afresh; following a link keeps
  // the trail back.
  const showThread = useCallback((id: string) => {
    setSelection({ kind: "thread", id });
    setSlideOpen(true);
    if (stayStore.get()?.threadId === id) stayStore.clear();
  }, []);
  const openThread = useCallback(
    (id: string) => {
      setTrail([]);
      showThread(id);
    },
    [showThread],
  );
  // The bar's Show: the thread in the slide, and the file its agent opened in
  // Switchboard's side panel beside it. With no file found (or the panel
  // turned off), the thread itself, where bb shows the file: a click, so the
  // window doesn't come straight back.
  const showStayed = useCallback(() => {
    const current = stayStore.get();
    if (current === null) return;
    const file = current.file;
    const target =
      file && settings.slideOutPanel
        ? agentFileTarget(current.threadId, file, environmentOf(current.threadId))
        : null;
    if (file && target !== null) {
      const threadId = current.threadId;
      openThread(threadId);
      void waitFor(() => panelState.view === threadId, 1000).then(() =>
        openAgentFile(navigate, threadId, file, target),
      );
      return;
    }
    stayStore.clear();
    inputState.lastAt = Date.now();
    navigate.toThread(current.threadId);
  }, [navigate, openThread, environmentOf, settings.slideOutPanel]);
  const stayBar =
    stayed === null ? null : (
      <div className="sb-stay" role="status">
        <div className="sb-lines">
          <span className="sb-line sb-stay-title">
            {byId.get(stayed.threadId)?.displayTitle ?? "A thread"}
          </span>
          <span className="sb-hint">
            {stayed.file
              ? `An agent opened ${fileName(stayed.file.path)}. Show opens it here.`
              : "An agent opened this in bb, so Switchboard stayed put."}
          </span>
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
  const readThread = useCallback(
    (id: string, group: WaitingGroup | null) => {
      const thread = byId.get(id);
      setOpened(group === null ? null : { id, group });
      if (thread === undefined) return;
      seenStore.mark(id, thread.latestAttentionAt, activeIds);
      const finished = new Set(summary.finishedThreadIds);
      if (hasUnread(thread, finished, {})) {
        void sdk.threads.markRead({ threadId: id }).catch(() => undefined);
      }
    },
    [byId, activeIds, summary.finishedThreadIds, sdk],
  );
  const openFromWaiting = useCallback(
    (id: string, group: WaitingGroup | null) => {
      openThread(id);
      readThread(id, group);
    },
    [openThread, readThread],
  );
  // A thread link clicked in the slide's chat: that thread in the slide, read
  // like one opened from Waiting, with the chat you came from on the trail.
  const followLink = useCallback(
    (id: string) => {
      const current = selection?.kind === "thread" ? selection.id : null;
      debugLog("follow link", { current, id });
      if (current === id) return;
      setTrail((before) => followTrail(before, current, id));
      showThread(id);
      readThread(id, rowsById.get(id)?.group ?? null);
    },
    [selection, showThread, readThread, rowsById],
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
  const closeSlide = useCallback(() => {
    setSlideOpen(false);
    setTrail([]);
  }, []);
  const stepBackTitle =
    trail.length === 0 ? null : (byId.get(trail[trail.length - 1] ?? "")?.displayTitle ?? "the last chat");

  // Thread links in the slide's chat open in the slide rather than taking the
  // window to the thread, and so do the rows of a Threads card (buttons, not
  // links: see cardRowThread). Caught on the way down, before bb's own
  // handler; a Cmd-, Ctrl-, Shift- or Alt-click is left to bb.
  //
  // Links to workspace files open in the side panel, as they do in a thread's
  // own view: bb's plugin ThreadChat only gets a file opener inside a thread
  // view, so here the browser followed the link against the page's URL (see
  // workspaceFileFromHref). That isn't behind the setting, as it's a fix.
  const slideBodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(followLink);
  followRef.current = followLink;
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const threadLinksRef = useRef(settings.threadLinksInSlide);
  threadLinksRef.current = settings.threadLinksInSlide;
  const slideThreadRef = useRef<string | null>(null);
  slideThreadRef.current = slideOpen && selection?.kind === "thread" ? selection.id : null;
  useEffect(() => {
    const body = slideBodyRef.current;
    if (body === null) return;
    const onClick = (event: MouseEvent) => {
      debugLog("slide click", {
        target: event.target instanceof Element ? event.target.tagName : String(event.target),
        prevented: event.defaultPrevented,
        button: event.button,
        href: event.target instanceof Element ? event.target.closest("a[href]")?.getAttribute("href") : null,
      });
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]") ?? null;
      const row = anchor === null ? (target?.closest(CARD_ROW_SELECTOR) ?? null) : null;
      let id: string | null = null;
      if (anchor !== null && body.contains(anchor)) {
        const href = anchor.getAttribute("href") ?? "";
        id = threadLinksRef.current ? threadIdFromHref(href, window.location.origin) : null;
        if (id === null && openLinkedFile(href, slideThreadRef.current, byIdRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      } else if (row !== null && body.contains(row) && threadLinksRef.current) {
        id = cardRowThread(row, byIdRef.current.values());
        debugLog("card row", { title: row.getAttribute("title"), id });
      }
      if (id === null) return;
      event.preventDefault();
      event.stopPropagation();
      followRef.current(id);
    };
    body.addEventListener("click", onClick, true);
    return () => body.removeEventListener("click", onClick, true);
  }, []);

  // Where you were reading, so the page bb rebuilds after taking the window
  // to an agent's thread and back (or as the window widens) opens the chat
  // at the same place rather than at its end.
  useEffect(() => {
    const body = slideBodyRef.current;
    if (body === null) return;
    const onScroll = (event: Event) => {
      const element = event.target;
      const threadId = slideThreadRef.current;
      if (!(element instanceof HTMLElement) || threadId === null) return;
      if (element.scrollHeight <= element.clientHeight + 1) return;
      const fromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
      pageState.scroll = { threadId, fromBottom: Math.max(0, Math.round(fromBottom)) };
    };
    body.addEventListener("scroll", onScroll, true);
    return () => body.removeEventListener("scroll", onScroll, true);
  }, []);
  const [scrollBack] = useState(() => {
    const saved = pageState.scroll;
    const open = pageState.selection;
    if (!restore || !pageState.slideOpen || saved === null || open?.kind !== "thread") return null;
    return saved.threadId === open.id && saved.fromBottom > AT_END_PX ? saved : null;
  });
  useEffect(() => {
    const body = slideBodyRef.current;
    if (scrollBack === null || body === null) return;
    // Put back once the chat has drawn that far, then held for a moment in
    // case bb's chat scrolls itself to the end as it loads. Anything you do
    // (scroll, click, a key) lets go.
    let stopped = false;
    let timer = 0;
    const stop = () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    const yours = { capture: true, passive: true } as const;
    window.addEventListener("wheel", stop, yours);
    window.addEventListener("touchstart", stop, yours);
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("keydown", stop, true);
    const started = Date.now();
    let placedAt: number | null = null;
    let scroller: HTMLElement | null = null;
    const tick = () => {
      if (stopped) return;
      if (scroller === null || !scroller.isConnected) scroller = chatScroller(body);
      if (scroller !== null) {
        const room = scroller.scrollHeight - scroller.clientHeight;
        if (room >= scrollBack.fromBottom) {
          const want = room - scrollBack.fromBottom;
          if (Math.abs(scroller.scrollTop - want) > 2) scroller.scrollTop = want;
          placedAt ??= Date.now();
        }
      }
      const now = Date.now();
      if (now - started < 4000 && (placedAt === null || now - placedAt < 800)) {
        timer = window.setTimeout(tick, 80);
      } else {
        debugLog("reading place", { fromBottom: scrollBack.fromBottom, placed: placedAt !== null });
      }
    };
    timer = window.setTimeout(tick, 80);
    return () => {
      stop();
      window.removeEventListener("wheel", stop, yours);
      window.removeEventListener("touchstart", stop, yours);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("keydown", stop, true);
    };
  }, [scrollBack]);

  // ←: back along the links you followed, then back to the list.
  const goBack = useCallback(() => {
    const previous = trail.at(-1);
    if (previous === undefined) {
      closeSlide();
      return;
    }
    setTrail(trail.slice(0, -1));
    showThread(previous);
  }, [trail, closeSlide, showThread]);

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
      data-panel={slide.open ? "open" : "closed"}
      data-slide-phase={slide.phase}
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
            data-narrow-only={wide || stepBackTitle !== null ? undefined : ""}
            aria-label={
              stepBackTitle !== null
                ? `Back to ${stepBackTitle}`
                : wide
                  ? "Close the chat"
                  : "Back to the list"
            }
            title={stepBackTitle !== null ? `Back to ${stepBackTitle}` : undefined}
            onClick={goBack}
          >
            {wide && stepBackTitle === null ? "×" : "←"}
          </button>
          <span className="sb-slide-title">
            {selection?.kind === "thread" ? (
              <ThreadTitle threadId={selection.id} />
            ) : selection?.kind === "new" ? (
              "New chat"
            ) : null}
          </span>
          {selection?.kind === "thread" && settings.commitButton ? (
            <CommitButton key={selection.id} thread={byId.get(selection.id) ?? null} />
          ) : null}
        </div>
        {wide ? null : stayBar}
        <div className="sb-slide-body" ref={slideBodyRef}>
          {selection?.kind === "thread" && snapshot !== null ? (
            <ChatSnapshotView snapshot={snapshot} live={!chatHeld} />
          ) : null}
          {selection?.kind === "thread" && chatHeld ? (
            <div className="sb-chat-held" aria-busy="true" />
          ) : selection?.kind === "thread" ? (
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

/**
 * The slide's Commit button (src/commit.ts). It shows while the open chat's
 * checkout has uncommitted changes, with the count; a click lists them and
 * asks, and Commit makes bb's own call, which stages everything and has bb
 * write the message. Read when the chat opens, whenever its state changes
 * (a turn that wrote files has ended), when the window comes back, and once
 * a minute while it shows.
 */
function CommitButton({ thread }: { thread: PluginSidebarThread | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const environment = thread !== null && !thread.isArchived ? thread.environment : null;
  const environmentId = environment?.id ?? null;
  const checkoutPath = environment?.path ?? null;
  const checkout =
    checkoutPath !== null
      ? (checkoutPath.split("/").filter((part) => part.length > 0).pop() ?? null)
      : (environment?.name ?? null);
  const [read, setRead] = useState<{ environmentId: string; changes: CheckoutChanges | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const refresh = useCallback(
    async (fresh = false) => {
      if (environmentId === null) return;
      const asked = ++latest.current;
      let changes: CheckoutChanges | null = null;
      try {
        changes = await rpc.call("checkoutChanges", { environmentId, fresh });
      } catch {
        changes = null;
      }
      if (asked === latest.current) setRead({ environmentId, changes });
    },
    [rpc, environmentId],
  );

  const threadStatus = thread?.status;
  useEffect(() => {
    void refresh();
  }, [refresh, threadStatus]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    const timer = window.setInterval(onReturn, 60_000);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const changes = read !== null && read.environmentId === environmentId ? read.changes : null;
  const count = changes?.count ?? 0;

  useEffect(() => {
    if (count === 0) setAsking(false);
  }, [count]);

  useEffect(() => {
    if (!asking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setAsking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, busy]);

  if (environmentId === null || changes === null || count === 0) return null;

  async function commit() {
    if (environmentId === null || busy) return;
    setBusy(true);
    try {
      const result = await sdk.environments.commit({ environmentId });
      toast.success(`Committed ${result.commitSha.slice(0, 7)}`, { description: result.commitSubject });
      setAsking(false);
    } catch (error) {
      if (isNothingToCommit(error)) {
        toast("Nothing to commit: it's all in already.");
        setAsking(false);
      } else {
        const reason = commitFailure(error);
        toast.error("The commit didn't go through", reason.length > 0 ? { description: reason } : undefined);
      }
    } finally {
      setBusy(false);
      void refresh(true);
    }
  }

  const listed = listedPaths(changes);
  return (
    <>
      <button
        type="button"
        className="sb-button sb-commit"
        aria-label={commitLabel(count)}
        aria-expanded={asking}
        aria-haspopup="dialog"
        title={commitLabel(count)}
        onClick={() => {
          if (!asking) void refresh(true);
          setAsking((open) => !open);
        }}
      >
        Commit
        <span className="sb-commit-count">{count}</span>
      </button>
      {asking ? (
        <div className="sb-commit-confirm" role="dialog" aria-label="Commit">
          <p className="sb-commit-question">{confirmQuestion(changes, checkout)}</p>
          <ul className="sb-commit-paths">
            {listed.paths.map((path) => (
              <li key={path} title={path}>
                {path}
              </li>
            ))}
            {listed.more > 0 ? <li className="sb-commit-more">and {listed.more} more</li> : null}
          </ul>
          <p className="sb-commit-note">
            Everything there goes in, new files too, the same as bb's own Commit. bb writes the message.
          </p>
          <div className="sb-commit-actions">
            <button type="button" className="sb-button" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="sb-button"
              data-primary=""
              disabled={busy}
              autoFocus
              onClick={() => void commit()}
            >
              {busy ? "Committing…" : "Commit"}
            </button>
          </div>
        </div>
      ) : null}
    </>
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
// The last usage figures, so a header bb rebuilds (as the window widens for
// the panel) shows them at once rather than going blank while it re-reads.
let lastUsage: UsageWindow[] | null = null;

function UsageGauge() {
  const sdk = useSdk();
  const { values } = useSettings();
  const enabled = parseSettings(values as Record<string, unknown> | undefined).usageGauge;
  const [windows, setWindows] = useState<UsageWindow[] | null>(() => lastUsage);
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
          if (!controller.signal.aborted) {
            lastUsage = summariseUsage(result);
            setWindows(lastUsage);
          }
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
  // Hover for when each window resets. The card goes on the page's body, so
  // the title bar (which bb clips, and drags the window by) doesn't hide it.
  const gaugeRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const anchor = gaugeRef.current;
    if (!hover || windows === null || anchor === null) return;
    const card = document.createElement("div");
    card.className = "sb-usage-card";
    card.setAttribute("role", "tooltip");
    const at = Date.now();
    for (const item of windows) {
      const line = resetLine(item, at);
      const row = document.createElement("div");
      row.className = "sb-usage-card-row";
      const title = document.createElement("span");
      title.className = "sb-usage-card-title";
      title.textContent = line.title;
      const detail = document.createElement("span");
      detail.className = "sb-usage-card-detail";
      detail.textContent = line.detail;
      row.append(title, detail);
      card.append(row);
    }
    document.body.append(card);
    const box = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(box.bottom + 6)}px`;
    return () => card.remove();
  }, [hover, windows, now]);
  if (!enabled || windows === null) return null;
  const label = usageLabel(windows, now);
  return (
    <div
      ref={gaugeRef}
      className="sb-usage"
      role="img"
      aria-label={`Usage: ${label}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
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
