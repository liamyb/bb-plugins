// Switchboard: a compact list of the chats open in your bb panes, with bb's
// own chat sliding open in place. Made for a small second bb window
// (Cmd+Shift+N), and it works as a page in the main window too.
//
// - An overlay in every window reports that window's panes to the plugin
//   server (server.ts), so the page in one window can list the panes of
//   another, and it answers "Open in a pane" for the window that owns them.
// - The page (a nav panel) lists the open threads with a state word each,
//   slides bb's ThreadChat open when a row is clicked, and starts new chats
//   with bb's New thread composer. The list rules are pure in src/current.ts
//   and the pane rules in src/panes.ts; the CSS is in src/styles.ts.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  type NewThreadRequest,
  type PluginSidebarThread,
  type PluginThreadActionsInlineItem,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  STATE_LABEL,
  buildList,
  parseMemory,
  serializeMemory,
  type MemoryMap,
  type Row,
} from "./src/current";
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
  type PaneRef,
  type PaneReport,
  type PanesSummary,
} from "./src/panes";
import { CSS, SLIDE_MS, STYLE_ID, WIDE_MIN_PX } from "./src/styles";

/** The nav panel's `path`: the page is at /plugins/<pluginId>/switchboard. */
const PANEL_PATH = "switchboard";

// Debounce for pane reports: bb's layout can change several times in a frame
// while a split opens.
const REPORT_DEBOUNCE_MS = 150;

// sessionStorage, like Pane Attention and Pane Keeper: a reload keeps the
// state, a new window starts clean. The show-all toggle is localStorage, so
// it's one choice for every window.
const KEYS = {
  held: "bb-plugin-switchboard:held-panes",
  lastRoute: "bb-plugin-switchboard:last-route-thread",
  localOpen: "bb-plugin-switchboard:local-open",
  memory: "bb-plugin-switchboard:memory",
  showAll: "bb-plugin-switchboard:show-all",
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
  };
}

function onPluginPage(): boolean {
  return window.location.pathname.startsWith("/plugins/");
}

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
    };
    void rpc.call("reportPanes", body).catch(() => undefined);
  }, [rpc, windowId, panes, context.threadId]);

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

interface RowProps {
  row: Row;
  depth: number;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  selectedId: string | null;
  onOpen(threadId: string): void;
  onOpenInPane(threadId: string): void;
}

function ThreadRow({ row, depth, threads, selectedId, onOpen, onOpenInPane }: RowProps) {
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
      {row.children.length > 0 ? (
        <ul>
          {row.children.map((child) => (
            <ThreadRow
              key={child.id}
              row={child}
              depth={depth + 1}
              threads={threads}
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

/** The Switchboard page. */
function SwitchboardPage() {
  const { status, threads } = useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { values } = useSettings();
  const connection = useRealtimeConnectionState();
  const settings = useMemo(
    () => parseSettings(values as Record<string, unknown> | undefined),
    [values],
  );

  const [summary, setSummary] = useState<PanesSummary>(EMPTY_SUMMARY);
  const [showAll, setShowAll] = useState(() => readStorage("local", KEYS.showAll) === "1");
  // Threads this page opened itself (new chats), kept until the window closes.
  const [localOpen, setLocalOpen] = useState<ReadonlySet<string>>(() =>
    readStringSet(KEYS.localOpen),
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [slideOpen, setSlideOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<MemoryMap | null>(null);

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

  // Which threads are open in panes, from the server: on mount, after a
  // reconnect, and whenever it says the union changed.
  const refresh = useCallback(async () => {
    try {
      setSummary(await rpc.call("getPanes", null));
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
  }, []);
  const openNew = useCallback(() => {
    setSelection({ kind: "new" });
    setSlideOpen(true);
  }, []);
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

  const toggleShowAll = useCallback(() => {
    setShowAll((current) => {
      writeStorage("local", KEYS.showAll, current ? "0" : "1");
      return !current;
    });
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
        : "Nothing's open in a pane. Open a thread in a split, or show all threads.";

  return (
    <div
      ref={rootRef}
      className="sb-page"
      data-slide-open={slideOpen ? "" : undefined}
      data-wide={wide ? "" : undefined}
    >
      <div className="sb-list">
        <div className="sb-toolbar">
          <button type="button" className="sb-button" data-primary="" onClick={openNew}>
            New chat
          </button>
          <span className="sb-toolbar-spacer" />
          <button
            type="button"
            className="sb-button"
            aria-pressed={showAll}
            title={showAll ? "Showing every active thread" : "Showing the chats open in panes"}
            onClick={toggleShowAll}
          >
            All threads
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="sb-empty">{emptyText}</div>
        ) : (
          <ul className="sb-rows" aria-label="Chats">
            {rows.map((row) => (
              <ThreadRow
                key={row.id}
                row={row}
                depth={0}
                threads={byId}
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
