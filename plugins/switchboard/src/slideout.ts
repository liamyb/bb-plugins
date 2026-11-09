/**
 * The side panel sliding out of a narrow window, and thread links that stay
 * in Switchboard's slide.
 *
 * In bb's compact layout (under 768px) the side panel covers the whole
 * window. When it opens there, Switchboard widens the window to the right so
 * the panel docks beside its column, which keeps the width and place it had
 * (bb's rail and the window's other panes are hidden meanwhile), and shrinks
 * it back when the panel closes. bb's Mac app is Electron, which
 * resizes a window when the page calls `window.resizeTo`; a web browser
 * ignores that for a normal window, so there it changes nothing.
 *
 * Pure, so it can be tested without bb. Window sizes and positions are in the
 * screen's units (what `outerWidth`, `screenX` and `resizeTo` use); layout
 * widths are CSS pixels. `scale` is the window's screen units per CSS pixel
 * (bb's zoom), measured as `outerWidth / innerWidth`.
 */

/** bb's compact layout ends here: at this width and above the panel docks beside the page. */
export const DOCKED_MIN_PX = 768;

/**
 * While the panel's out, bb's icon rail, sidebar and sidebar button, and its
 * back and forward buttons (the Mac app draws these in the title row, over
 * Switchboard's title, where the rail would be) are hidden, and so are the
 * window's other split panes (a narrow window keeps them, folded, behind the
 * one it shows): every pane that doesn't hold Switchboard, at each level of
 * bb's split, with Switchboard's taking the room. So the widened window is
 * the column and the panel, nothing else. Above 768px only, and only while a
 * Switchboard page is on screen. While the window widens or shrinks, the
 * page keeps its column's width (`--sb-slide-column`), so its own wide
 * layout never shows, with the panel's colour beside it until the panel's
 * there. Once the panel's docked, bb's window-level
 * panel button goes too: the Mac app draws it over the panel's own Hide
 * button (it's left while widening, as it's the Show button an empty panel
 * needs).
 *
 * bb's title row is pinned to the column too, with the title moved back to
 * where it was in the narrow window. The row's own "Show right panel"
 * button goes once the panel docks, a moment after the window widens, so
 * the padding that keeps the usage rings in place (`--sb-title-dr`) only
 * applies once that button has gone.
 */
export const CHROME_CSS = `@media (min-width: 768px) {
  body:has(.sb-page) [data-sidebar="gap"],
  body:has(.sb-page) [data-sidebar="panel"],
  body:has(.sb-page) [data-testid="app-sidebar-trigger-overlay"],
  body:has(.sb-page) button[data-sidebar="trigger"],
  body:has(.sb-page) button[aria-label^="Toggle sidebar"],
  body:has(.sb-page) [data-split-resize-grid-root]:not([data-panel-group]) > :not(:has(.sb-page)) {
    display: none !important;
  }
  body:has(.sb-page) [data-split-resize-grid-root]:not([data-panel-group]) > :has(.sb-page) {
    flex: 1 1 0px !important;
  }
  html[data-switchboard-slide="out"] body:has(.sb-page) [data-testid="split-workspace-panel-toggle"] {
    display: none !important;
  }
  body:has(.sb-page) button[aria-label^="Go back"]:not(aside *),
  body:has(.sb-page) button[aria-label^="Go forward"]:not(aside *) {
    display: none !important;
  }
  body:has(.sb-page) [data-testid="app-page-header-content-row"]:not(aside *) {
    padding-left: calc(12px + var(--sb-title-dx, 0px)) !important;
    translate: 0 var(--sb-title-dy, 0px);
    transition: none !important;
  }
  html[data-switchboard-slide] body:has(.sb-page) [data-testid="app-page-header-content-row"]:not(aside *):not(:has(button[aria-label^="Show right panel"])) {
    padding-right: var(--sb-title-dr, 0px) !important;
  }
  html[data-switchboard-slide] body:has(.sb-page) .sb-page,
  html[data-switchboard-slide] body:has(.sb-page) header:has(> [data-testid="app-page-header-content-row"]):not(aside *) {
    max-width: var(--sb-slide-column, 100%) !important;
  }
  html[data-switchboard-slide] body:has(.sb-page) :is([data-panel-id^="plugin-panel-main"], [data-panel-id="split-workspace-main-panel"]) {
    background: var(--sidebar, var(--muted, transparent));
  }
}`;

/** A window this close to the width Switchboard set still counts as untouched. */
export const RESIZED_BY_HAND_PX = 8;

/** How recently bb must have opened an agent's file for Switchboard to pick it up. */
export const AGENT_FILE_WINDOW_MS = 10_000;

export interface Screen {
  availLeft: number;
  availWidth: number;
}

/** A window's left edge and width, kept on the screen: as wide as it fits, moved left if it must. */
export function fitOnScreen(x: number, width: number, screen: Screen): { x: number; width: number } {
  const fitted = Math.min(Math.round(width), Math.max(1, Math.floor(screen.availWidth)));
  const right = screen.availLeft + screen.availWidth;
  const left = Math.max(screen.availLeft, Math.min(Math.round(x), Math.floor(right - fitted)));
  return { x: left, width: fitted };
}

/**
 * The first guess at the widened window, made while still compact: the
 * column, and a panel as wide as it (bb's default split is half and half).
 * Never narrower than bb's docked layout needs.
 */
export function firstGrowWidth(input: { column: number; scale: number }): number {
  const inner = Math.max(DOCKED_MIN_PX + 1, input.column * 2);
  return Math.round(inner * input.scale);
}

/**
 * The window width that brings the column back to `wantColumn`, measured
 * once the panel has docked. The panel takes a share of the space right of
 * the column's left edge (`contentLeft`), and that share holds as the window
 * widens, so the space grows by `wantColumn / share`. Null when the layout
 * gives nothing to work from (no panel beside the column).
 */
export function correctedWidth(input: {
  outerWidth: number;
  innerWidth: number;
  scale: number;
  contentLeft: number;
  column: number;
  wantColumn: number;
}): number | null {
  const space = input.innerWidth - input.contentLeft;
  if (!(input.column > 0) || !(space > input.column + 1)) return null;
  const share = input.column / space;
  const wantInner = input.contentLeft + input.wantColumn / share;
  return Math.round(input.outerWidth + (wantInner - input.innerWidth) * input.scale);
}

/** Whether the window is still the width Switchboard left it, so closing the panel may shrink it. */
export function untouched(outerWidth: number, grownWidth: number): boolean {
  return Math.abs(outerWidth - grownWidth) <= RESIZED_BY_HAND_PX;
}

/** What Switchboard remembers while the panel is out. */
export interface SlideOutRecord {
  /** The window's width and left edge before it widened. */
  narrowWidth: number;
  narrowX: number;
  /** Whether it had to move left to fit, so shrinking puts it back. */
  moved: boolean;
  /** The width Switchboard set, to tell a window you've resized by hand. */
  grownWidth: number;
  /** The column's width in CSS pixels, which the widened window keeps. */
  column: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A record as saved to sessionStorage, or null when it isn't one. */
export function parseSlideOutRecord(value: unknown): SlideOutRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { narrowWidth, narrowX, moved, grownWidth, column } = record;
  if (!finite(narrowWidth) || !finite(narrowX) || !finite(grownWidth) || !finite(column)) {
    return null;
  }
  if (typeof moved !== "boolean" || narrowWidth <= 0 || grownWidth <= 0 || column <= 0) return null;
  return { narrowWidth, narrowX, moved, grownWidth, column };
}

/** A file bb opened in a thread's side panel, as it keeps them in its recent items. */
export interface RecentFile {
  source: "workspace" | "thread-storage";
  path: string;
  openedAt: number;
}

/**
 * bb's recent items for one thread's panel: localStorage
 * `bb.thread.recentItems-<threadId>-1`, written when a file opens there,
 * which is how a file an agent opened with `bb thread open` lands. Not part
 * of the plugin SDK, so anything unexpected reads as nothing.
 */
export function recentItemsKey(threadId: string): string {
  return `bb.thread.recentItems-${threadId}-1`;
}

/** The newest file opened at or after `since`, or null. */
export function newestFileSince(raw: string | null, since: number): RecentFile | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  let best: RecentFile | null = null;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { source, path, openedAt } = item as Record<string, unknown>;
    if (source !== "workspace" && source !== "thread-storage") continue;
    if (typeof path !== "string" || path.length === 0 || !finite(openedAt)) continue;
    if (openedAt < since) continue;
    if (best === null || openedAt > best.openedAt) best = { source, path, openedAt };
  }
  return best;
}

/** The last part of a path, for the bar. */
export function fileName(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

/**
 * The thread a link in a chat points at, or null for any other link: a path
 * on this origin with `/threads/thr_…` in it, as bb's thread chips have.
 */
export function threadIdFromHref(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /\/threads\/(thr_[a-z0-9]+)(?:\/|$)/.exec(url.pathname);
  return match?.[1] ?? null;
}

/**
 * The thread a row of bb's Threads card opens: the card (`section[aria-label=
 * "Threads"]`, the `Threads()` status card agents put in replies) draws each
 * row as a button titled `Open “<thread title>”`, with no link, so the title is
 * the only thing in the page that names the thread. Null for anything else,
 * such as the row's "Show the whole message" button.
 */
export function cardRowTitle(buttonTitle: string): string | null {
  const match = /^Open “([\s\S]+)”$/.exec(buttonTitle.trim());
  return match?.[1] ?? null;
}

/** The one thread with this title, or null when none or more than one has it. */
export function threadIdForTitle(
  title: string,
  threads: Iterable<{ id: string; displayTitle: string }>,
): string | null {
  const wanted = title.trim();
  let found: string | null = null;
  for (const thread of threads) {
    if (thread.displayTitle.trim() !== wanted) continue;
    if (found !== null && found !== thread.id) return null;
    found = thread.id;
  }
  return found;
}

/**
 * The workspace file a link in the slide's chat points at, as a path relative
 * to the workspace root, or null for anything else. bb's chat opens these
 * itself in a thread's own view, but the plugin ThreadChat only gets a file
 * opener when it sits inside a thread view, so on Switchboard's page a
 * relative link fell through to the browser and resolved against the page's
 * URL. Takes a relative path (`current-projects/notes.md`), an absolute one
 * under the root, or a `file://` URL under the root; query and fragment are
 * dropped. Null for other URLs, in-page anchors, paths outside the root, and
 * folders.
 */
export function workspaceFileFromHref(href: string, rootPath: string | null): string | null {
  const raw = href.trim();
  if (raw.length === 0 || raw.startsWith("#") || raw.startsWith("//")) return null;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!/^file:/i.test(raw)) return null;
    try {
      path = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return null;
    }
  } else {
    const bare = raw.split(/[?#]/)[0] ?? "";
    try {
      path = decodeURIComponent(bare);
    } catch {
      path = bare;
    }
  }
  if (path.length === 0 || path.endsWith("/")) return null;
  let relative = path;
  if (path.startsWith("/")) {
    const root = (rootPath ?? "").replace(/\/+$/, "");
    if (root.length === 0 || !path.startsWith(`${root}/`)) return null;
    relative = path.slice(root.length + 1);
  }
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
}

/** The threads you followed links from, oldest first, after following one to `next`. */
export function followTrail(trail: readonly string[], current: string | null, next: string): string[] {
  if (current === null || current === next) return [...trail];
  return [...trail, current];
}
