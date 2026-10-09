// Pane Keeper: Cmd+N and notification clicks open beside the pane Liam is in,
// instead of over it.
//
// - Two commands take Cmd+N and Cmd+Shift+O once bb's own New thread lets go
//   of them (`bb settings keyboard set thread.new disabled`).
// - A header component that draws nothing sits inside the sidebar, because
//   the sidebar navigation's "open New thread in a split" action only works
//   from in there. It has to be picked under Settings → Appearance → Header.
// - An overlay keeps the layout, threads and focus history current, and
//   answers Notifications Pro's open-thread event.
import { useEffect } from "react";
import {
  definePluginApp,
  useSettings,
  useSidebarSplitLayout,
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { recordFocus, type Pane } from "./src/placement";
import {
  NEW_THREAD_ITEM,
  OPEN_THREAD_EVENT,
  live,
  newThreadBeside,
  onOpenThreadEvent,
  parseSettings,
  registerBridge,
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
  const threadActions = useSidebarThreadActions();
  const { values } = useSettings();

  useEffect(() => {
    live.threadActions = threadActions;
  }, [threadActions]);

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
      live.threadActions = null;
    };
  }, []);

  return null;
}

// Draws nothing. It's only here to hand the navigation's actions to the
// commands, which run outside React.
function NavigationBridge() {
  const { items, actions } = useSidebarNavigation();
  const item = items.find((entry) => entry.id === NEW_THREAD_ITEM);
  const usable = item !== undefined && !item.isDisabled && !item.isLoading;

  useEffect(() => {
    if (!usable) return;
    return registerBridge(actions);
  }, [actions, usable]);

  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "pane-keeper",
    component: KeeperState,
  });
  app.slots.experimental_sidebarHeader({
    id: "bridge",
    title: "Pane Keeper",
    description:
      "Draws nothing. Lets Cmd+N open New thread beside the focused pane.",
    component: NavigationBridge,
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
