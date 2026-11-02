// Pane Attention: marks an unfocused split pane whose thread finished a turn
// ("done"), or is waiting on you or failed ("needs-you"), by setting
// data-pane-attention on bb's [data-split-pane-id] element. It draws nothing
// itself; the Sandbar theme styles the attribute next to its sliding panes.
//
// It also plays the blade slide when the focused pane changes in a row of
// folded panes (src/blades.ts). That part is a content script, because it
// only watches the DOM and needs nothing from React.
//
// And it marks thread families (src/families.ts): a child's pane and its
// family's other open panes get data-pane-family and a shared hue, and the
// child's header gets a "↳ parent" button that opens the parent beside it.
// The theme draws the colour. Setting `families` turns it off.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSdk,
  useSettings,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import {
  parseMemory,
  serializeMemory,
  step,
  type Attention,
  type MemoryMap,
  type ThreadState,
} from "./src/attention";
import { applyAttention, clearAttention } from "./src/dom";
import { installBlades } from "./src/blades";
import {
  familyMarks,
  missingThreadIds,
  type FamilyMark,
  type FamilyThread,
} from "./src/families";
import {
  applyFamilies,
  clearFamilies,
  familyLabelTarget,
} from "./src/family-dom";

// sessionStorage, so a reload of the window keeps a flag but a new window
// starts clean.
const STORAGE_KEY = "bb-plugin-pane-attention:v1";

function readStoredMemory(): MemoryMap {
  try {
    return parseMemory(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeStoredMemory(serialized: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Storage full or blocked: the flags still work for this page load.
  }
}

function PaneAttention() {
  const { status, threads } = useSidebarThreads();
  const layout = useSidebarSplitLayout();
  const memoryRef = useRef<MemoryMap | null>(null);
  const savedRef = useRef<string | null>(null);
  const attentionRef = useRef<ReadonlyMap<string, Attention>>(new Map());

  useEffect(() => {
    if (status !== "ready") return;
    memoryRef.current ??= readStoredMemory();
    const byId = new Map<string, ThreadState>();
    for (const thread of threads) {
      byId.set(thread.id, {
        status: thread.status,
        runtimeStatus: thread.runtimeStatus,
        hasPendingInteraction: thread.hasPendingInteraction,
        activity: thread.activity,
        indicator: thread.indicator,
        latestAttentionAt: thread.latestAttentionAt ?? null,
      });
    }
    const { memory, attention } = step(
      memoryRef.current,
      layout?.panes ?? [],
      byId,
    );
    memoryRef.current = memory;
    const serialized = serializeMemory(memory);
    if (serialized !== savedRef.current) {
      savedRef.current = serialized;
      writeStoredMemory(serialized);
    }
    attentionRef.current = attention;
    applyAttention(document, attention);
  }, [status, threads, layout]);

  // bb can swap a pane's element without the layout changing (a thread page
  // remounting, say), which drops the attribute. Put it back shortly after
  // any change to the tree. Only childList is watched, so our own attribute
  // writes don't wake it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        applyAttention(document, attentionRef.current);
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      clearAttention(document);
    };
  }, []);

  return null;
}

function PaneFamilies() {
  const { values } = useSettings();
  // `values` is undefined until bb has loaded the settings; on by default.
  const enabled = (values as Record<string, unknown> | undefined)?.families !== false;
  return enabled ? <FamilyMarks /> : null;
}

function FamilyMarks() {
  const { status, threads } = useSidebarThreads();
  const layout = useSidebarSplitLayout();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const marksRef = useRef<ReadonlyMap<string, FamilyMark>>(new Map());
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Threads the sidebar list doesn't hold (archived ones), fetched once each.
  // null marks a fetch in flight or one that failed, so it isn't retried.
  const [fetched, setFetched] = useState<ReadonlyMap<string, FamilyThread | null>>(
    () => new Map(),
  );

  const lookup = useMemo(() => {
    const byId = new Map<string, FamilyThread>();
    for (const [id, thread] of fetched) if (thread !== null) byId.set(id, thread);
    for (const thread of threads) {
      byId.set(thread.id, {
        id: thread.id,
        parentThreadId: thread.parentThreadId,
        title: thread.displayTitle,
      });
    }
    return (id: string) => byId.get(id);
  }, [threads, fetched]);

  const panes = useMemo(
    () =>
      layout?.panes.map(({ paneId, threadId }) => ({ paneId, threadId: threadId ?? null })) ??
      [],
    [layout],
  );

  useEffect(() => {
    if (status !== "ready") return;
    const wanted = missingThreadIds(panes, lookup).filter((id) => !fetched.has(id));
    if (wanted.length === 0) return;
    setFetched((previous) => {
      const next = new Map(previous);
      for (const id of wanted) next.set(id, null);
      return next;
    });
    for (const id of wanted) {
      sdk.threads
        .get({ threadId: id })
        .then((thread): FamilyThread => ({
          id: thread.id,
          parentThreadId: thread.parentThreadId ?? null,
          title: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread",
        }))
        .then(
          (thread) => setFetched((previous) => new Map(previous).set(id, thread)),
          () => undefined,
        );
    }
  }, [status, panes, lookup, fetched, sdk]);

  useEffect(() => {
    if (status !== "ready") return;
    marksRef.current = familyMarks(panes, lookup);
    applyFamilies(document, marksRef.current);
  }, [status, panes, lookup]);

  // As with attention: bb can swap a header without the layout changing,
  // which drops the attribute and the label. Our own label insert is a
  // childList change too, but the second pass finds nothing to do.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        applyFamilies(document, marksRef.current);
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Capture on window, so it runs before bb's own handlers. The click
    // still focuses the child's pane first (bb does that on pointerdown), so
    // bb's split rule opens the parent to its right, or focuses the parent's
    // pane when it's already open.
    const onClick = (event: MouseEvent) => {
      const parentId = familyLabelTarget(event);
      if (parentId === null) return;
      event.preventDefault();
      event.stopPropagation();
      navigateRef.current.toThread(parentId, { split: true });
    };
    window.addEventListener("click", onClick, true);

    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("click", onClick, true);
      clearFamilies(document);
    };
  }, []);

  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "pane-attention",
    component: PaneAttention,
  });
  app.slots.experimental_appOverlay({
    id: "pane-families",
    component: PaneFamilies,
  });
  app.contentScripts.register({
    id: "blade-slide",
    mount: () => installBlades(document),
  });
});
