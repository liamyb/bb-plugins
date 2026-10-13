// Pane Keeper: Cmd+N and notification clicks open beside the pane Liam is in,
// instead of over it.
//
// - Two commands take Cmd+N and Cmd+Shift+O once bb's own New thread lets go
//   of them (`bb settings keyboard set thread.new disabled`).
// - An overlay keeps the layout, threads and focus history current, answers
//   Notifications Pro's open-thread event, and carries the hidden New thread
//   link the commands click to get bb's split-open (see `openNewThreadInSplit`
//   in src/keeper.ts).
import { useEffect } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useSettings,
  useSidebarSplitLayout,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { recordFocus, type Pane } from "./src/placement";
import {
  NEW_THREAD_ROUTE,
  OPEN_THREAD_EVENT,
  live,
  newThreadBeside,
  onOpenThreadEvent,
  parseSettings,
  saveMemory,
} from "./src/keeper";

// bb's own lists of execution and runtime statuses that count as working,
// the same as Pane Attention's.
const BUSY_STATUS = new Set(["active", "starting", "stopping"]);
const BUSY_RUNTIME = new Set([
  "active",
  "host-reconnecting",
  "provisioning",
  "starting",
  "stopping",
]);

function KeeperState() {
  const layout = useSidebarSplitLayout();
  const { threads } = useSidebarThreads();
  const navigate = useBbNavigate();
  const { values } = useSettings();

  useEffect(() => {
    live.navigate = navigate;
  }, [navigate]);

  useEffect(() => {
    live.threads = new Map(
      threads.map((thread) => [
        thread.id,
        {
          title: thread.displayTitle || thread.title || "Untitled thread",
          busy:
            BUSY_STATUS.has(thread.status) ||
            BUSY_RUNTIME.has(thread.runtimeStatus),
        },
      ]),
    );
  }, [threads]);

  // `values` is undefined until bb has loaded the settings.
  useEffect(() => {
    live.settings = parseSettings(
      (values as Record<string, unknown> | undefined) ?? {},
    );
  }, [values]);

  useEffect(() => {
    const panes: Pane[] | null =
      layout?.panes.map(({ paneId, threadId, isFocused }) => ({
        paneId,
        threadId,
        isFocused,
      })) ?? null;
    live.panes = panes;
    const next = recordFocus(live.memory, panes, Date.now());
    if (next !== live.memory) {
      live.memory = next;
      saveMemory(next);
    }
  }, [layout]);

  useEffect(() => {
    window.addEventListener(OPEN_THREAD_EVENT, onOpenThreadEvent);
    return () => {
      window.removeEventListener(OPEN_THREAD_EVENT, onOpenThreadEvent);
      live.navigate = null;
    };
  }, []);

  // Never shown and never focusable. It has to sit inside the plugin's own
  // UI, because that's where bb's link handling applies.
  return (
    <a
      href={NEW_THREAD_ROUTE}
      hidden
      aria-hidden="true"
      tabIndex={-1}
      ref={(element) => {
        live.splitLink = element;
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "pane-keeper",
    component: KeeperState,
  });
  app.commands.register({
    id: "new-thread",
    title: "Pane Keeper: New thread beside this pane",
    defaultShortcut: { key: "n", mod: true },
    run: ({ projectId }) => newThreadBeside(projectId),
  });
  app.commands.register({
    id: "new-thread-alt",
    title: "Pane Keeper: New thread beside this pane (second shortcut)",
    defaultShortcut: { key: "o", mod: true, shift: true },
    run: ({ projectId }) => newThreadBeside(projectId),
  });
});
