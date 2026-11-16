// Status Strip: a one-line readout above each thread's composer, in bb's
// context row, like a player's display: how many threads are working, how
// much of this thread's context window is used (with an LED bar), and its
// branch. Click it for the list of working threads, each one click away.
//
// It shows in themes that ask for it (a theme sets --status-strip: on, as
// Mixtape does), or everywhere with the "everyTheme" setting. While anything
// is working it also sets data-agents-running on the page, so a theme can
// react (Mixtape's level meter only moves then).
//
// One tracker per window watches bb's live thread list and the theme, and
// shares both with every strip in the window through a small store.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSdk,
  useSettings,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { STYLE } from "./src/styles";
import {
  contextLevel,
  contextPercent,
  litLeds,
  runningLabel,
  sameWorking,
  themeWantsStrip,
  tokensLabel,
  workingThreads,
  type ContextUsage,
  type WorkingThread,
} from "./src/strip";

const LEDS = 10;
const ATTRIBUTE = "data-agents-running";

// ---- The window's shared state --------------------------------------------

interface Shared {
  working: readonly WorkingThread[];
  themeWants: boolean;
}

let shared: Shared = { working: [], themeWants: false };
const listeners = new Set<() => void>();

function update(next: Partial<Shared>): void {
  const merged = { ...shared, ...next };
  if (merged.themeWants === shared.themeWants && sameWorking(merged.working, shared.working)) return;
  shared = merged;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useShared(): Shared {
  return useSyncExternalStore(subscribe, () => shared);
}

/** Reads the active theme's --status-strip flag from the page. */
function readThemeFlag(): boolean {
  return themeWantsStrip(getComputedStyle(document.documentElement).getPropertyValue("--status-strip"));
}

// ---- The tracker, one per window ------------------------------------------

function Tracker(): null {
  const { threads } = useSidebarThreads();
  const { values } = useSettings();
  const markWindow = values?.markWindow !== false;

  // The working threads, and the page mark a theme can react to.
  useEffect(() => {
    const working = workingThreads(threads);
    update({ working });
    const root = document.documentElement;
    if (markWindow && working.length > 0) root.setAttribute(ATTRIBUTE, String(working.length));
    else root.removeAttribute(ATTRIBUTE);
  }, [threads, markWindow]);

  // The theme's flag, re-read whenever bb swaps the theme's stylesheet.
  useEffect(() => {
    update({ themeWants: readThemeFlag() });
    const reread = () => update({ themeWants: readThemeFlag() });
    const observer = new MutationObserver(reread);
    const watch = () => {
      const style = document.querySelector("style#bb-app-theme");
      if (style) observer.observe(style, { childList: true, characterData: true, subtree: true });
      observer.observe(document.head, { childList: true });
    };
    watch();
    // The class on <html> (light or dark) can change the flag too.
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // The strip's CSS, and the page mark taken off when the plugin stops.
  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-status-strip", "");
    style.textContent = STYLE;
    document.head.appendChild(style);
    return () => {
      style.remove();
      document.documentElement.removeAttribute(ATTRIBUTE);
    };
  }, []);

  return null;
}

// ---- Per-thread data --------------------------------------------------------

type Sdk = ReturnType<typeof useSdk>;

/** The thread's context window use, polled while the page is visible. */
function useContextUsage(sdk: Sdk, threadId: string, working: boolean): ContextUsage | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await sdk.threads.context({ threadId });
        if (!stopped) setUsage(result.usage ?? null);
      } catch {
        // Leave the last reading; the next poll tries again.
      }
    };
    void load();
    // Every 10 seconds while the thread works, every minute while it's idle.
    const timer = setInterval(load, working ? 10_000 : 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sdk, threadId, working]);
  return usage;
}

/** The environment's branch, refreshed every minute while visible. */
function useBranch(sdk: Sdk, environmentId: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    setBranch(null);
    if (environmentId === null) return;
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const environment = await sdk.environments.get({ environmentId });
        if (!stopped) setBranch(environment.branchName ?? null);
      } catch {
        // No branch shown until a read works.
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sdk, environmentId]);
  return branch;
}

// ---- The segment ------------------------------------------------------------

function useStripVisible(): boolean {
  const { values } = useSettings();
  const { themeWants } = useShared();
  return values?.everyTheme === true || themeWants;
}

function StatusSummary({ threadId, environment, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const sdk = useSdk();
  const { working } = useShared();
  const thisWorking = working.some((thread) => thread.id === threadId);
  const usage = useContextUsage(sdk, threadId, thisWorking);
  const branch = useBranch(sdk, environment?.id ?? null);
  const percent = contextPercent(usage);
  const tokens = usage === null ? null : tokensLabel(usage);
  const level = percent === null ? "ok" : contextLevel(percent);
  const lit = percent === null ? 0 : litLeds(percent, LEDS);
  const title = [
    `${runningLabel(working.length)} across bb`,
    tokens === null ? null : `Context: ${tokens}`,
    branch === null ? null : `Branch: ${branch}`,
    isExpanded ? "Click to hide the working threads" : "Click to see the working threads",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <button type="button" className="bss-strip" aria-expanded={isExpanded} onClick={onToggle} title={title}>
      <span className="bss-cell" data-busy={working.length > 0 ? "" : undefined}>
        <span className="bss-dot" aria-hidden="true" />
        {runningLabel(working.length)}
      </span>
      {percent !== null && (
        <span className="bss-cell">
          <span className="bss-label">CTX</span>
          <span className="bss-leds" aria-hidden="true">
            {Array.from({ length: LEDS }, (_, i) => (
              <span key={i} className="bss-led" data-on={i < lit ? "" : undefined} data-level={level} />
            ))}
          </span>
          <span>{percent}%</span>
        </span>
      )}
      {branch !== null && (
        <span className="bss-cell">
          <span className="bss-label" aria-hidden="true">
            ⎇
          </span>
          <span className="bss-branch-name">{branch}</span>
        </span>
      )}
    </button>
  );
}

function StatusDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const navigate = useBbNavigate();
  const { working } = useShared();
  if (!isExpanded) return null;
  const others = working.filter((thread) => thread.id !== threadId);
  const thisOne = working.length !== others.length;
  return (
    <div className="bss-details">
      <p className="bss-details-head">Working now</p>
      {working.length === 0 ? (
        <p className="bss-note">Nothing's running.</p>
      ) : (
        <ol>
          {thisOne && (
            <li>
              <span className="bss-open" aria-disabled="true">
                <span className="bss-dot" aria-hidden="true" />
                <span className="bss-open-title">This thread</span>
              </span>
            </li>
          )}
          {others.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className="bss-open"
                title={`Open "${thread.title}" beside this pane`}
                onClick={() => navigate.toThread(thread.id, { split: true })}
              >
                <span className="bss-dot" aria-hidden="true" />
                <span className="bss-open-title">{thread.title}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "tracker",
    component: Tracker,
  });
  app.slots.experimental_threadContextSegment({
    id: "status",
    title: "Status strip",
    // Sorts before bb's own groups ("1_thread", "3_git"), so the strip leads the row.
    group: "0_status",
    summary: StatusSummary,
    details: StatusDetails,
    useVisible: useStripVisible,
  });
});
