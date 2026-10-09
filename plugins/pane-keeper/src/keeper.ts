// The parts of Pane Keeper that act. Commands and DOM events arrive outside
// React, so the components in app.tsx keep `live` up to date and these
// functions read it.
import { toast } from "sonner";
import {
  EMPTY_MEMORY,
  parseMemory,
  pickPaneToReplace,
  planOpen,
  type FocusMemory,
  type LimitMode,
  type Pane,
  type PaneFacts,
  type Plan,
  type ThreadPane,
} from "./placement";

/** bb's id for the New thread item in its sidebar navigation. */
export const NEW_THREAD_ITEM = "__bb__/new-thread";

/**
 * Fired on `window` by Liam's Notifications Pro patch before it opens a
 * thread. Pane Keeper calls `preventDefault()` when it has opened it.
 */
export const OPEN_THREAD_EVENT = "pane-keeper:open-thread";

// bb's own breakpoint for its compact layout, where there are no splits.
const COMPACT_QUERY = "(max-width: 767px)";

// sessionStorage, like Pane Attention: a reload keeps the focus history, a
// new window starts clean.
const MEMORY_KEY = "bb-plugin-pane-keeper:v1";

export interface ThreadActions {
  open(threadId: string, options?: { split?: boolean }): void;
  openNewThread(options?: { projectId?: string; focusPrompt?: boolean }): void;
}

export interface NavigationActions {
  activate(id: string, options: { openInSplit: boolean }): void;
}

export interface Settings {
  notificationClicks: boolean;
  atPaneLimit: LimitMode;
}

interface ThreadInfo {
  title: string;
  busy: boolean;
}

export const live: {
  panes: readonly Pane[] | null;
  memory: FocusMemory;
  threads: ReadonlyMap<string, ThreadInfo>;
  threadActions: ThreadActions | null;
  settings: Settings;
} = {
  panes: null,
  memory: readMemory(),
  threads: new Map(),
  threadActions: null,
  settings: { notificationClicks: true, atPaneLimit: "replace-oldest" },
};

// The sidebar navigation's actions only work from inside the sidebar, so the
// header bridge in app.tsx registers them here while it's mounted.
const bridges = new Map<object, NavigationActions>();

export function registerBridge(actions: NavigationActions): () => void {
  const token = {};
  bridges.set(token, actions);
  return () => {
    bridges.delete(token);
  };
}

function navigationActions(): NavigationActions | null {
  let latest: NavigationActions | null = null;
  for (const actions of bridges.values()) latest = actions;
  return latest;
}

function readMemory(): FocusMemory {
  try {
    return parseMemory(window.sessionStorage.getItem(MEMORY_KEY));
  } catch {
    return EMPTY_MEMORY;
  }
}

export function saveMemory(memory: FocusMemory): void {
  try {
    window.sessionStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Storage full or blocked: the history still works for this page load.
  }
}

export function parseSettings(values: Record<string, unknown>): Settings {
  return {
    notificationClicks: values.notificationClicks !== false,
    atPaneLimit: values.atPaneLimit === "notice" ? "notice" : "replace-oldest",
  };
}

function isCompact(): boolean {
  return window.matchMedia(COMPACT_QUERY).matches;
}

function paneElement(paneId: string): Element | null {
  return document.querySelector(`[data-split-pane-id="${CSS.escape(paneId)}"]`);
}

function paneFacts(pane: ThreadPane): PaneFacts {
  return {
    // Pane Attention's mark: a finished turn, a question or a failure.
    marked: paneElement(pane.paneId)?.hasAttribute("data-pane-attention") ?? false,
    busy: live.threads.get(pane.threadId)?.busy ?? false,
  };
}

// The layout reports a New thread pane only as a pane with no thread, which a
// plugin page is too. bb gives the New thread prompt this id.
function newThreadPaneOpen(): boolean {
  const prompt = document.getElementById("root-compose-prompt");
  return prompt?.closest("[data-split-pane-id]") != null;
}

function plan(alreadyOpen: boolean): Plan {
  return planOpen({
    compact: isCompact(),
    panes: live.panes,
    alreadyOpen,
    mode: live.settings.atPaneLimit,
    pick: () =>
      live.panes === null
        ? null
        : pickPaneToReplace(live.panes, live.memory, paneFacts),
  });
}

function titleOf(threadId: string): string {
  return live.threads.get(threadId)?.title ?? "that thread";
}

function sayReplaced(pane: ThreadPane): void {
  toast(
    `bb stops at 8 panes, so "${titleOf(pane.threadId)}" made way. It's the pane you'd used least recently.`,
  );
}

function sayFull(): void {
  toast("8 panes open, close one first.");
}

let warnedNoBridge = false;

function sayNoBridge(): void {
  if (warnedNoBridge) return;
  warnedNoBridge = true;
  toast(
    "Pane Keeper can't open New thread beside this pane until it's picked under Settings → Appearance → Header, so this one opened over it.",
  );
}

/**
 * Cmd+N and Cmd+Shift+O. With a split showing, New thread opens as a pane to
 * the right of the focused one, or bb jumps to the New thread pane that's
 * already open. Otherwise it's bb's own New thread.
 */
export function newThreadBeside(projectId: string | null): void {
  const threadActions = live.threadActions;
  if (threadActions === null) return;
  // bb's own New thread does exactly this: select the current project, then
  // open the compose screen with its prompt focused. When a New thread pane
  // is open, bb focuses that pane rather than replacing anything.
  const openPrompt = () =>
    threadActions.openNewThread({
      ...(projectId === null ? {} : { projectId }),
      focusPrompt: true,
    });
  const decision = plan(newThreadPaneOpen());
  if (decision.kind === "default") {
    openPrompt();
    return;
  }
  const navigation = navigationActions();
  if (navigation === null) {
    sayNoBridge();
    openPrompt();
    return;
  }
  if (decision.kind === "blocked") {
    sayFull();
    return;
  }
  // At the limit bb replaces the focused pane, so focus the one to lose first.
  if (decision.kind === "replace") {
    threadActions.open(decision.pane.threadId, { split: true });
  }
  navigation.activate(NEW_THREAD_ITEM, { openInSplit: true });
  openPrompt();
  if (decision.kind === "replace") sayReplaced(decision.pane);
}

/**
 * A notification click from Notifications Pro. Opens the thread the way a
 * sidebar click does, with the pane limit handled, and claims the event.
 * Leaves it alone (so Notifications Pro navigates as before) when the setting
 * is off, the thread isn't in the sidebar, or there's no split to protect.
 */
export function onOpenThreadEvent(event: Event): void {
  if (!live.settings.notificationClicks) return;
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  const threadId =
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as { threadId?: unknown }).threadId === "string"
      ? (detail as { threadId: string }).threadId
      : null;
  const threadActions = live.threadActions;
  if (threadId === null || threadActions === null) return;
  if (!live.threads.has(threadId)) return;
  const alreadyOpen = live.panes?.some((pane) => pane.threadId === threadId) ?? false;
  const decision = plan(alreadyOpen);
  if (decision.kind === "default") return;
  event.preventDefault();
  if (decision.kind === "blocked") {
    sayFull();
    return;
  }
  if (decision.kind === "replace") {
    threadActions.open(decision.pane.threadId, { split: true });
  }
  threadActions.open(threadId, { split: true });
  if (decision.kind === "replace") sayReplaced(decision.pane);
}
