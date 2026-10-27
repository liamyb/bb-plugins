// The parts of Pane Keeper that act. Commands and DOM events arrive outside
// React, so the overlay in app.tsx keeps `live` up to date and these
// functions read it.
import { toast } from "sonner";
import {
  EMPTY_MEMORY,
  parseMemory,
  pickPaneToReplace,
  planButtonClick,
  planOpen,
  type FocusMemory,
  type LimitMode,
  type Pane,
  type PaneFacts,
  type Plan,
  type ThreadPane,
} from "./placement";

/** bb's route for the New thread screen. */
export const NEW_THREAD_ROUTE = "/";

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

/** The parts of the SDK's `useBbNavigate()` that Pane Keeper uses. */
export interface Navigate {
  /** `split: true` is bb's split-open: right of the focused pane, or focus it if open. */
  toThread(threadId: string, options?: { split?: boolean }): void;
  /** The New thread screen. `environmentId` makes New thread reuse that environment. */
  toCompose(options?: {
    projectId?: string;
    environmentId?: string;
    focusPrompt?: boolean;
  }): void;
}

export interface Settings {
  notificationClicks: boolean;
  atPaneLimit: LimitMode;
  newThreadButton: boolean;
}

interface ThreadInfo {
  title: string;
  busy: boolean;
}

export const live: {
  panes: readonly Pane[] | null;
  memory: FocusMemory;
  threads: ReadonlyMap<string, ThreadInfo>;
  navigate: Navigate | null;
  settings: Settings;
  /** The overlay's hidden link to New thread. See `openNewThreadInSplit`. */
  splitLink: HTMLAnchorElement | null;
  /** The project in view, which Cmd+N gets from bb's command context. */
  projectId: string | null;
} = {
  panes: null,
  memory: readMemory(),
  threads: new Map(),
  navigate: null,
  settings: {
    notificationClicks: true,
    atPaneLimit: "replace-oldest",
    newThreadButton: true,
  },
  splitLink: null,
  projectId: null,
};

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
    newThreadButton: values.newThreadButton !== false,
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
// plugin page is too. bb gives the New thread prompt this id. With nothing
// split, the only pane is the one showing it.
function newThreadPaneOpen(): boolean {
  const prompt = document.getElementById("root-compose-prompt");
  if (prompt === null) return false;
  return live.panes === null || prompt.closest("[data-split-pane-id]") != null;
}

function plan(alreadyOpen: boolean, splitSinglePane: boolean): Plan {
  return planOpen({
    compact: isCompact(),
    panes: live.panes,
    alreadyOpen,
    mode: live.settings.atPaneLimit,
    splitSinglePane,
    pick: () =>
      live.panes === null
        ? null
        : pickPaneToReplace(live.panes, live.memory, paneFacts),
  });
}

/**
 * bb's split-open for New thread. The SDK has had no call for it since bb
 * 0.46, but bb wraps every plugin's UI in a click handler that treats a Cmd-
 * or Ctrl-click on an in-app link as "open in split", which is the same
 * split-open the sidebar's New thread button uses, and "/" is the New thread
 * route. So the overlay renders a hidden link to "/" and this clicks it with
 * Cmd held. bb then adds a pane to the right of the focused one, focuses a
 * New thread pane that's already open, or at 8 panes replaces the focused
 * one.
 *
 * Returns false when bb didn't take the click, and stops the browser
 * following the link in that case.
 */
function openNewThreadInSplit(): boolean {
  const link = live.splitLink;
  if (link === null || !link.isConnected) return false;
  let taken = false;
  // React handles the click at bb's root element, so a listener on `window`
  // sees it after bb has.
  const settle = (event: Event) => {
    if (event.target !== link) return;
    taken = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", settle);
  try {
    link.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        metaKey: true,
      }),
    );
  } finally {
    window.removeEventListener("click", settle);
  }
  return taken;
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

let warnedNoSplit = false;

function sayNoSplit(): void {
  if (warnedNoSplit) return;
  warnedNoSplit = true;
  toast(
    "Pane Keeper couldn't open New thread beside this pane, so it opened over it. bb may have changed how it opens splits.",
  );
}

interface NewThreadOptions {
  /** Have New thread reuse this environment, such as the project's checkout. */
  environmentId?: string;
  /** Open beside a single pane too. See `PlanInput.splitSinglePane`. */
  splitSinglePane?: boolean;
}

/** Whether New thread opened: "unavailable" until the overlay has mounted. */
export type NewThreadResult = "opened" | "blocked" | "unavailable";

function openNewThread(
  projectId: string | null,
  options: NewThreadOptions,
): NewThreadResult {
  const navigate = live.navigate;
  if (navigate === null) return "unavailable";
  // bb's own New thread does exactly this: select the current project, then
  // open the compose screen with its prompt focused. When a New thread pane
  // is open, bb focuses that pane rather than replacing anything.
  const openPrompt = () =>
    navigate.toCompose({
      ...(projectId === null ? {} : { projectId }),
      ...(options.environmentId === undefined
        ? {}
        : { environmentId: options.environmentId }),
      focusPrompt: true,
    });
  const decision = plan(newThreadPaneOpen(), options.splitSinglePane ?? false);
  if (decision.kind === "default") {
    openPrompt();
    return "opened";
  }
  if (decision.kind === "blocked") return "blocked";
  // At the limit bb replaces the focused pane, so focus the one to lose first.
  if (decision.kind === "replace") {
    navigate.toThread(decision.pane.threadId, { split: true });
  }
  if (!openNewThreadInSplit()) {
    sayNoSplit();
    openPrompt();
    return "opened";
  }
  openPrompt();
  if (decision.kind === "replace") sayReplaced(decision.pane);
  return "opened";
}

/**
 * Cmd+N and Cmd+Shift+O. With a split showing, New thread opens as a pane to
 * the right of the focused one, or bb jumps to the New thread pane that's
 * already open. Otherwise it's bb's own New thread.
 */
export function newThreadBeside(projectId: string | null): void {
  if (openNewThread(projectId, {}) === "blocked") sayFull();
}

// bb's New thread button, which since bb 0.47 comes from its builtin
// navigation plugin: one in the sidebar's top row, and a row in the "Top
// list" layout. The top-row one only has an aria-label while bb's own New
// thread has a shortcut, so it's matched by its text.
const NEW_THREAD_ROW_BUTTON =
  '[data-sidebar-navigation-item="__bb__/new-thread"] > button';
const SIDEBAR_HEADER = '[data-testid="sidebar-header-slot"]';

function newThreadButton(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest("button");
  if (button === null) return null;
  if (button.matches(NEW_THREAD_ROW_BUTTON)) return button;
  if (button.closest(SIDEBAR_HEADER) === null) return null;
  const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
  return label.trim().startsWith("New thread") ? button : null;
}

/**
 * A click on the sidebar's New thread button, caught on `window` before bb
 * sees it. With a split showing, a plain click opens New thread beside the
 * focused pane, as Cmd+N does, and a Cmd- or Ctrl-click opens it over the
 * focused pane, which is bb's plain click. That's bb's rule swapped round.
 * Anything else, and every click that isn't a person's (including Pane
 * Keeper's own), is left to bb.
 */
export function onNewThreadButtonClick(event: MouseEvent): void {
  if (!event.isTrusted || event.button !== 0) return;
  const button = newThreadButton(event.target);
  if (button === null) return;
  const action = planButtonClick({
    enabled: live.settings.newThreadButton,
    modified: event.metaKey || event.ctrlKey,
    compact: isCompact(),
    panes: live.panes,
  });
  if (action === "bb") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (action === "beside") {
    newThreadBeside(live.projectId);
    return;
  }
  // The same button, clicked again with no key held, is bb's own "open over
  // the focused pane". It isn't trusted, so this handler lets it through.
  button.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      view: window,
    }),
  );
}

/**
 * A draft from `bb pane-keeper draft`. Opens New thread the way Cmd+N does,
 * but beside a single pane as well, and on the draft's environment. The
 * prompt goes in once New thread's composer shows up (see app.tsx).
 */
export function openDraftBeside(
  projectId: string,
  environmentId: string | null,
): NewThreadResult {
  return openNewThread(projectId, {
    ...(environmentId === null ? {} : { environmentId }),
    splitSinglePane: true,
  });
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
  const navigate = live.navigate;
  if (threadId === null || navigate === null) return;
  if (!live.threads.has(threadId)) return;
  const alreadyOpen = live.panes?.some((pane) => pane.threadId === threadId) ?? false;
  const decision = plan(alreadyOpen, false);
  if (decision.kind === "default") return;
  event.preventDefault();
  if (decision.kind === "blocked") {
    sayFull();
    return;
  }
  if (decision.kind === "replace") {
    navigate.toThread(decision.pane.threadId, { split: true });
  }
  navigate.toThread(threadId, { split: true });
  if (decision.kind === "replace") sayReplaced(decision.pane);
}
