// Pane Attention: marks an unfocused split pane whose thread finished a turn
// ("done"), or is waiting on you or failed ("needs-you"), by setting
// data-pane-attention on bb's [data-split-pane-id] element. It draws nothing
// itself; the Sandbar theme styles the attribute next to its sliding panes.
//
// It also plays the blade slide when the focused pane changes in a row of
// folded panes (src/blades.ts). That part is a content script, because it
// only watches the DOM and needs nothing from React.
import { useEffect, useRef } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
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

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "pane-attention",
    component: PaneAttention,
  });
  app.contentScripts.register({
    id: "blade-slide",
    mount: () => installBlades(document),
  });
});
