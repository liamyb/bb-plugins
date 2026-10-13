// Pane Keeper: Cmd+N, notification clicks and drafts handed in from outside
// the app open beside the pane Liam is in, instead of over it.
//
// - Two commands take Cmd+N and Cmd+Shift+O once bb's own New thread lets go
//   of them (`bb settings keyboard set thread.new disabled`).
// - An overlay keeps the layout, threads and focus history current, answers
//   Notifications Pro's open-thread event, and carries the hidden New thread
//   link the commands click to get bb's split-open (see `openNewThreadInSplit`
//   in src/keeper.ts).
// - The same overlay takes drafts from `bb pane-keeper draft` (server.ts) and
//   types each into New thread without sending it (`useDraftDelivery`).
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_copyToClipboard as copyToClipboard,
  useBbNavigate,
  useComposers,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  useSidebarSplitLayout,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { recordFocus, type Pane } from "./src/placement";
import {
  COMPOSER_WAIT_MS,
  DRAFT_CHANNEL,
  HIDDEN_PAGE_DELAY_MS,
  draftComposer,
  holdsPrompt,
  type Draft,
  type DraftOutcome,
} from "./src/drafts";
import {
  NEW_THREAD_ROUTE,
  OPEN_THREAD_EVENT,
  live,
  newThreadBeside,
  onOpenThreadEvent,
  openDraftBeside,
  parseSettings,
  saveMemory,
} from "./src/keeper";

interface WaitingDraft {
  draft: Draft;
  /** When to give up on New thread's composer and use the clipboard. */
  deadline: number;
}

/**
 * Drafts from `bb pane-keeper draft`. Claims them from the server when it
 * nudges, when the page loads and after a reconnect, so a draft queued while
 * bb was starting still arrives. Each one opens New thread beside the focused
 * pane, and its prompt goes in after anything already typed there once that
 * project's New thread composer shows up. Nothing is sent. If New thread
 * can't take it, the prompt goes on the clipboard instead.
 */
function useDraftDelivery(): void {
  const rpc = useRpc<typeof rpcContract>();
  const composers = useComposers();
  const connection = useRealtimeConnectionState();
  const [waiting, setWaiting] = useState<readonly WaitingDraft[]>([]);
  // Drafts already typed in or given up on, so a re-render can't repeat one.
  const handled = useRef(new Set<string>());
  const mounted = useRef(false);
  const connectedBefore = useRef(false);

  const report = useCallback(
    (id: string, outcome: DraftOutcome, detail?: string) => {
      void rpc
        .call("reportDraft", { id, outcome, ...(detail === undefined ? {} : { detail }) })
        .catch(() => undefined);
    },
    [rpc],
  );

  const fallBack = useCallback(
    async (draft: Draft, why: string) => {
      handled.current.add(draft.id);
      const copied = await copyToClipboard({ text: draft.prompt }).catch(() => false);
      toast(
        copied
          ? `${why}, so the draft is on your clipboard. Paste it into New thread.`
          : `${why}, and Pane Keeper couldn't copy the draft to your clipboard either.`,
      );
      report(draft.id, copied ? "clipboard" : "failed", why);
    },
    [report],
  );

  const claim = useCallback(async () => {
    let drafts: readonly Draft[];
    try {
      drafts = (await rpc.call("claimDrafts", null)).drafts;
    } catch {
      return;
    }
    for (const draft of drafts) {
      const result = openDraftBeside(draft.projectId, draft.environmentId);
      if (result === "opened") {
        setWaiting((current) => [
          ...current,
          { draft, deadline: Date.now() + COMPOSER_WAIT_MS },
        ]);
      } else {
        void fallBack(
          draft,
          result === "blocked"
            ? "8 panes are open"
            : "Pane Keeper wasn't ready to open New thread",
        );
      }
    }
  }, [rpc, fallBack]);

  // A page that's on screen claims at once; a hidden one gives it a moment.
  const claimSoon = useCallback(() => {
    const delay = document.visibilityState === "visible" ? 0 : HIDDEN_PAGE_DELAY_MS;
    window.setTimeout(() => {
      if (mounted.current) void claim();
    }, delay);
  }, [claim]);

  useEffect(() => {
    mounted.current = true;
    claimSoon();
    return () => {
      mounted.current = false;
    };
  }, [claimSoon]);

  useRealtime(DRAFT_CHANNEL, claimSoon);

  // Signals sent while the socket was down aren't replayed.
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) claimSoon();
    connectedBefore.current = true;
  }, [connection, claimSoon]);

  useEffect(() => {
    const done = new Set<string>();
    for (const { draft } of waiting) {
      if (handled.current.has(draft.id)) {
        done.add(draft.id);
        continue;
      }
      const composer = draftComposer(composers, draft.projectId);
      if (composer === null) continue;
      handled.current.add(draft.id);
      done.add(draft.id);
      try {
        if (holdsPrompt(composer.text, draft.prompt)) {
          composer.focus();
          report(draft.id, "already-there");
          continue;
        }
        composer.insert(draft.prompt, { at: "end", block: true });
        composer.focus();
        report(draft.id, "inserted");
      } catch {
        void fallBack(draft, "bb wouldn't take the text into New thread");
      }
    }
    if (done.size > 0) {
      setWaiting((current) => current.filter(({ draft }) => !done.has(draft.id)));
    }
  }, [composers, waiting, report, fallBack]);

  useEffect(() => {
    if (waiting.length === 0) return;
    const next = Math.min(...waiting.map(({ deadline }) => deadline));
    const timer = window.setTimeout(() => {
      const now = Date.now();
      for (const { draft, deadline } of waiting) {
        if (deadline <= now && !handled.current.has(draft.id)) {
          void fallBack(draft, "New thread didn't show up in time");
        }
      }
      setWaiting((current) => current.filter(({ deadline }) => deadline > now));
    }, Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [waiting, fallBack]);
}

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

  // After the effects above, so `live` is current before a draft opens.
  useDraftDelivery();

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
