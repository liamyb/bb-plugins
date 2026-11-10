---
name: switchboard
description: What the Switchboard bb plugin is, its settings, its Waiting view and rail badge, its Ask the desk button and usage gauge, the side panel sliding out of the narrow window, thread links in the slide, its Commit button, and how its "open in a pane" relay works. Use when the user asks about Switchboard, the compact chat list, the small second bb window, the Waiting view, the count on its rail icon, Ask the desk, the usage rings in its title bar, the window widening when the side panel opens, thread links opening in the slide, committing from the slide or where bb's Commit button went, or why a thread does or doesn't appear in it.
---

# Switchboard

Switchboard is a bb plugin page (rail icon, or Cmd+Shift+S) that lists the threads open in the
split panes of any bb window, with a state word each, and slides bb's own chat open in place
when a row is clicked. Its Waiting view lists every thread waiting on the user across all
sections, and the rail icon carries a count. It's sized for a small second bb window
(Cmd+Shift+N, about 500px wide) and works in the main window too. There is no CLI command.

## What's listed

- Threads open in a split pane of any bb window, until the pane closes. A window showing one
  thread with no split counts. Threads started from Switchboard's own New chat button stay
  listed until that window closes.
- With `showChildren` on (the default), threads spawned by a listed thread nest under it.
- Hidden helper threads (`visibility: "hidden"`) and archived threads never show.
- The view switch at the top picks Panes (the above), Waiting (below) or All (every active
  thread). It's a per-browser choice, kept in localStorage (`bb-plugin-switchboard:view`).

The state words are Needs you (pending interaction, `waiting-for-input` or `queued-failed`
indicator, or `error` status), Working (`active`, `starting`, `stopping`, a runtime status
of `provisioning` or `host-reconnecting`, or any running workflow, background agent or
background command in the thread's `activity` counts), Done (bb's unread flag, or it went from
working to idle while it wasn't the chat open in the slide) and Idle. Order is Needs you,
Working, Done, then the rest by most recent attention.

## The Waiting view

Rules are pure in `src/waiting.ts` (`buildWaiting`). Over every top-level, visible, active
thread:

- **Asking you:** `hasPendingInteraction`, a `waiting-for-input` or `queued-failed` indicator,
  `error` status or an `unread-error` indicator. Children appear only here, and only while
  waiting on the user (pending interaction, `waiting-for-input` or `queued-failed`), labelled
  "Under <parent>".
- **Working:** busy, by the same rule as the Panes view.
- **Replies / FYI:** not busy and unread. Unread is bb's `isUnread`, `latestAttentionAt` after
  `lastReadAt`, or the thread being in the server's `finishedThreadIds` (it finished in a pane
  while that pane, or its window, wasn't focused; each window's overlay works this out with
  `stepPanes` and adds it to its `reportPanes` call). A thread opened from Switchboard is marked
  read (`threads.markRead`) and its attention time saved in localStorage
  (`bb-plugin-switchboard:seen`), which overrides the pane flag until it finishes again.
- **Reply or FYI** is decided from `threads.events.list` (types `client/turn/requested` and
  `turn/completed`, newest first, 24 events), cut into turns. The turns that completed after
  `lastReadAt` (or, with none, the newest completed turn) are checked: any request with
  `initiator: "user"`, `initiator: "system"` (a child's completed notice) or from a thread
  working for the user makes it a Reply. Only automations (input starting `[bb automation`) and
  threads not working for the user make it FYI. A sender that isn't an active thread is looked
  up with `threads.get` for its section; until then the row counts as a Reply.
- **Working for the user (`chainCheck`):** the sender is in a `relaySections` section, or the
  sender's turn that sent the hand-off was the user's by the same rule, followed back up to
  `CHAIN_DEPTH` (3) threads. The sender's turn is its newest turn that started by the time the
  request reached the recipient (`turnAt`, matched on start because a message can wait behind a
  compact or a busy recipient). Senders' turns are read into `chainStore` (`chainWanted` says
  which, and how recent a read each needs). A thread the desk spawns has its first turn recorded
  as `initiator: "user"`, which is what makes its hand-offs count. Until a sender's turns are
  read, or when they don't reach back that far, the row counts as a Reply.
- **Maintenance turns** don't count either way: input `/compact` (also how
  `bb thread tell --compact-first` arrives, as the user's) and `initiator: "system"` with no
  `systemMessageSubject` and input "Please continue." (bb's retry after a usage limit). A
  retry's output, unread on its own, is judged by the turn before it.

Today's asks: headed by today's front desk thread (below) with its status, then
`<askLedgerFolder>/<YYYY-MM-DD>.jsonl` (local date), read with `files.read` every 60 seconds
while the Waiting view shows. Relative folders resolve against the path of the
`newChatEnvironmentId` environment. Each status is the thread's Waiting group, else Read
(active) or Archived.

## Ask the desk and the usage gauge

Today's desk is `findDesk` in `src/waiting.ts`: the pinned, visible, top-level, active thread in
the `frontDesk` section with the latest `pinnedAt`, or with none pinned the newest by
`createdAt`. Ask the desk opens it in the slide (marking it read) with the composer focused; the
+ beside it is New chat. With no desk, the main button is New chat.

The gauge is the nav panel's `headerContent` (right of the title bar), from
`sdk.system.usageLimits()` (`GET /api/v1/system/usage-limits`): the `five-hour` and `weekly`
windows without a `model`, for `claude-code` if its status is `ok`, else the first provider
that is. Rules in `src/usage.ts`; read every 60 seconds while visible.

The rail badge (`experimental_useBadge` on the nav panel) is Asking you plus Replies, tone
`warning` while anything is asking, computed in every window. Setting `railBadge` turns it off.

## Thread links and the slide-out panel

Rules pure in `src/slideout.ts`; the glue is `useSlideOut`, `useStayedFile` and the slide's
click listener in `app.tsx`.

- **Thread links:** a capture-phase click listener on `.sb-slide-body` catches a plain left
  click on an `a[href]` whose path has `/threads/thr_…` (`threadIdFromHref`), prevents bb's
  navigation and opens that thread in the slide, read like one opened from Waiting. The chat it
  came from goes on a trail (`followTrail`); ← steps back along it ("Back to <title>"), then
  closes the slide. Escape and opening a row clear the trail. Modifier clicks are left to bb.
  Setting `threadLinksInSlide`.
- **Workspace file links:** bb's plugin ThreadChat (`PluginThreadChat` in bb's web bundle) only
  passes the timeline an `onOpenLocalFileLink` when it's rendered inside a thread view's
  navigation context, for a chat on the same environment, and the SDK's `ThreadChat` takes no
  file-opener prop. So on Switchboard's page bb's markdown link (`linkRouting.localFile`) had no
  opener and the browser followed the raw href against `/plugins/switchboard/...` ("This plugin
  panel is not available"). The same capture listener now catches a plain left click on a link
  that `workspaceFileFromHref` places in the chat thread's workspace (relative, absolute under
  `environment.path`, or `file://` under it) and opens it with `experimental_openFilePreview`
  (`openLinkedFile`), selecting the tab in the compact layout so the panel slides out. Not behind
  `threadLinksInSlide`. Thread-storage paths aren't handled and are left to bb.
- **Threads card rows:** bb's Threads card (`section[aria-label="Threads"]`, the `Threads()`
  status card in agents' replies) draws each row as a `<button>` titled `Open “<thread title>”`,
  with no link and no thread id in the DOM, so the same listener also catches that button
  (`CARD_ROW_SELECTOR`). `cardRowTitle` reads the title and `threadIdForTitle` finds the one
  thread with it; when two threads share a title, `cardRowThread` falls back to the row's React
  props (a `thread` prop a level or two up, not bb's API), and with neither the click is left to
  bb. The row's "Show the whole message" button isn't matched, so it still expands the preview.
- **Commit:** bb 0.48.0 hid its own Commit button by default (the Git plugin's
  `showCommitButton`, `bb plugin config bb--git set showCommitButton true`) and made it a
  `placement: "header"` thread action, which bb shows only in the open thread's header (folded
  into the header's thread menu at compact width) and never in other menus, so it's in neither
  the slide (bb's chat without the header) nor Switchboard's row menus. `CommitButton` in
  `app.tsx` puts one in `.sb-slide-header`: the server's `checkoutChanges` RPC reads
  `git --no-optional-locks status --porcelain=v1 -z --branch --untracked-files=all` in the
  environment's path (`bb.sdk.environments.get`), parsed by `parseStatus` in `src/commit.ts`,
  shared for 2s across windows; the button shows while the count is above 0, a click opens a
  confirm listing up to 8 paths, and Commit calls `sdk.environments.commit({ environmentId })`
  (POST `/api/v1/environments/<id>/actions` `{action: "commit"}`), the same call as bb's button:
  `git add -A`, "No changes to commit" when there's nothing, then `git commit --no-verify` with
  bb's message. Not tied to bb's `showCommitButton`. Setting `commitButton`.
- **Slide-out:** when the page's panel opens (`experimental_usePanelTabs().open`) in bb's compact
  layout (under 768px), `growForPanel` adds `CHROME_CSS` (above 768px, while a `.sb-page` is on
  screen: hides `[data-sidebar=gap]`, `[data-sidebar=panel]`, the sidebar trigger overlay and any
  sidebar button (the Mac app draws one in the title row, over Switchboard's title), and
  every child of a non-panel-group `[data-split-resize-grid-root]` that doesn't hold `.sb-page`,
  with the one that does set to `flex: 1`), calls `window.resizeTo` (Electron honours it; bb's
  main process has no `content-bounds-updated` handler) to twice the column (`firstGrowWidth`),
  reopens the panel docked (the compact panel doesn't carry over: `selectTab(key)`, else bb's
  visible "Show right panel" button once bb's open flag has dropped), then corrects the width so
  the column is what it was (`correctedWidth`). bb's "Maximize pane" isn't used: it hides the
  side panel too. Once widened, `closeOtherPanes` closes every other split pane in the window
  with its own Close button (Liam's call, 4 Nov): bb mounts all of a window's panes above 768px,
  and four long chats hidden there made the widen take 3.4s in the Mac app. If the panel won't dock, the window goes back. Phase is in
  `slideOut` (idle, growing, out, shrinking) and sessionStorage `bb-plugin-switchboard:slide-out`.
  Closing the panel while out shrinks the window back (`shrinkForPanel`) unless its width moved
  more than 8px (resized by hand); the CSS goes when the phase is idle again. Crossing 768px makes bb rebuild the page, so the slide-out
  works through module-level `slideLive` refs, and a page mounted within 4s of a change restores
  the slide's chat and trail. Setting `slideOutPanel`.
- **The panel shows the chat's documents** (`src/panelfiles.ts`, `usePanelFollowsSlide`,
  `syncPanelContents`): document tabs are file previews and file openers' plugin tabs whose
  params carry `{path, source}` (`documentTab`; bb opens PDFs in the `pdf-preview` plugin's tab).
  A chat's documents are its thread's own in bb (`threadPanelFiles` over localStorage
  `bb.thread.fixedPanelTabsState-<thread>-1`, secondary.tabs `workspace-file-preview`,
  `thread-storage-file-preview` and `plugin-panel` with `paramsJson`) plus the ones filed under it
  here: a tab is filed under the chat in the slide when it appeared, or the agent's thread for an
  agent's file shown from the bar (`panelState.agent`); tabs seen within 1.5s of Switchboard first looking belong to
  no chat. Memory is in sessionStorage `bb-plugin-switchboard:panel-files`. Open or closed is
  yours: with the panel open, a move to another chat closes other chats' documents and opens
  this chat's, closing the panel when nothing's left; with it
  closed, nothing happens; `growForPanel` syncs first, so opening the panel shows the chat's
  documents. The list moves nothing. Nothing an agent does moves it either (Liam, 10 Nov).
- **Agent files:** after a stay (below), `useStayedFile` reads localStorage
  `bb.thread.recentItems-<thread>-1` for a file opened in the last 10s, only so the bar can name
  it: nothing an agent does changes what's on screen (Liam's rule, 10 Nov 2026, after another
  thread's `bb thread open` slid the panel out over the chat he was reading). The bar's Show (`showStayed`) opens the thread in the slide, waits until it's the
  panel's view, then `openAgentFile` opens the file with `navigate.experimental_openFilePreview`
  (workspace target from the thread's environment, or thread-storage), selects its tab (bb adds
  it without showing the panel), and once any widening has settled selects it again, since
  `growForPanel` puts the chat's last document in front when bb showed the panel itself.
  Until 0.2.5 the file opened by itself and, with no chat in the slide, its thread did too. While widened, the stay rule also
  applies (`widened` in `shouldStayOnSwitchboard`): bb adds the thread as a split, which is closed
  with that pane's own Close button (`[data-split-pane-id=<paneId>]`).
- **No in-between layouts:** in the narrow window a capture-phase click on bb's "Show right
  panel" button and a trusted Cmd+J keydown are taken by Switchboard (`growForPanel`), so bb
  never opens its full-window panel first; a panel bb did open full-window is closed before the
  window widens. While the phase isn't idle, `.sb-page` is pinned to `--sb-slide-column` (CSS),
  so its own wide layout never shows, with the panel colour beside it. `panelBeside` reads bb's
  panel box (`[data-panel-id^="thread-detail-secondary-panel"]` wider than 100px), and the width
  correction measures `split-workspace-main-panel`.
- **Title row:** before widening, `noteNarrowTitle` records where the "Switchboard" title sits in
  the narrow header; once out, `keepTitleInPlace` sets `--sb-title-dx`/`--sb-title-dy` so the wide
  header row (`app-page-header-content-row` outside any aside: padding-left and `translate`) puts
  the title back there. In the Mac app the wide row otherwise sits about 20pt lower, under the
  traffic lights. With one pane, bb's page area is `plugin-panel-main-<pane>`, not
  `split-workspace-main-panel`. The move is kept in localStorage
  (`bb-plugin-switchboard:title-shift`) and applied before the window widens, so the title never
  leaves its place after the first time; the row's `transition` is off, and the `header` holding
  it is pinned to `--sb-slide-column` like the page. `--sb-title-dr` is right padding that keeps
  the usage rings in place once the row's own "Show right panel" button goes (bb drops it about
  100ms after the window widens, when the panel docks), so it only applies while that button is
  gone (`:not(:has(…))`); applied earlier, the rings jumped left and back.
- **Timings:** every slide-out and shrink logs its steps to the plugin log through the `note`
  RPC (`bb plugin logs switchboard`, lines like `win_…: slide-out to 1000px: widened 208ms,
  docked 968ms`). The slow part was bb rebuilding the page at 768px with the slide's chat in
  it (3.5s in the Mac app with a long thread), so the page renders `.sb-chat-held` instead of
  ThreadChat while the phase is growing or shrinking (`chatHeld`) and draws the chat after.
  Meanwhile a DOM copy of the chat taken just before (`captureChatSnapshot`, with its scroll
  offsets) sits over the slide (`.sb-chat-snapshot`, inert) until the live chat's text is at
  least 60% of the copy's, or four seconds. After each slide-out, the first one per page load
  also logs what's in the window's top-left corner (`title row: …`), to see the Mac app's title
  row. bb's back and forward buttons outside the panel are hidden while out, and Switchboard's
  header row gets 12px of left padding. An empty panel is reopened with bb's ⌘J shortcut, sent as a window-level keydown, but
  only while bb's panel button label shows ⌘J. A file Switchboard adds widens first and opens
  docked (`showPanelTab`), so the chat redraws once.
- **Debugging:** localStorage `bb-plugin-switchboard:debug` = `1` logs each step to the console
  and `window.__switchboardLog`; the page carries `data-panel` and `data-slide-phase`.

## Workflow lines

Each running workflow of a listed thread shows as an indented line under it, before its
children: the workflow name, then where it is, any failures, and the time since it started.
"Where it is" is the phase when the workflow declares phases (`workflow.phases`) and its agents
carry a `phaseIndex` among them: the earliest declared phase with an agent `queued` or
`running`, or between phases the latest one any agent reached, shown as "Refute · 3 of 5" (the
position among the declared phases in index order; "phase 3 of 5" when the phase has no title).
Otherwise it's "settled/spawned agents" (done, failed or skipped, out of the agents spawned so
far, so the total grows as it fans out). Clicking the line opens the thread, and its tooltip
is the whole line. The sidebar feed only has the count
(`activity.workflows`), so while that's above zero the page calls `threads.timeline` with
`summaryOnly: "true"` for that thread, at once and every 10 seconds, and reads
`activeWorkflows`. A line shows only while the live count is above zero. Background agents and
background commands get no lines.

## Settings

`bb plugin config switchboard set <key> <value>`:

- `showChildren` (boolean, default `true`).
- `newChatProjectId` (string, default `proj_m7g3w6c5r8`): the project the New chat composer
  starts on. Empty means the composer's own choice.
- `newChatEnvironmentId` (string, default `env_82jgfihfwx`): the environment it starts on,
  normally the project checkout so a new chat doesn't land in a fresh worktree. Empty means the
  composer's own choice.
- `paneReportTtlSeconds` (number, default `120`, 10 to 600): how long a window's pane report
  counts after its last heartbeat. Windows re-report every quarter of this.
- `frontDesk` (string, default `Front desk`): the section name or id whose pinned thread is
  today's desk. Empty: no Ask the desk and no desk line.
- `relaySections` (string, default `Front desk`): section names or ids, comma-separated, whose
  threads pass on the user's asks, so a reply to their hand-off counts as a Reply, not FYI.
- `askLedgerFolder` (string, default `automation/front-desk/ledger`): the front desk ledger
  folder for Today's asks. Empty turns the list off.
- `railBadge` (boolean, default `true`): the count on the rail icon.
- `usageGauge` (boolean, default `true`): the session and week rings in the title bar.
- `stayOnSwitchboard` (boolean, default `true`): a narrow window showing Switchboard goes
  straight back to it when something other than the user opens a thread there.
- `slideOutPanel` (boolean, default `true`): the side panel slides out of a window under 768px
  (the window widens) instead of covering it, and the bar's Show opens an agent's file in it.
- `threadLinksInSlide` (boolean, default `true`): thread links in the slide's chat open in the
  slide, with ← stepping back.
- `commitButton` (boolean, default `true`): the Commit button at the top of the slide.

## How panes cross windows

An overlay in every bb window reports that window's panes to the plugin server over RPC
(`reportPanes`), keyed by a per-window id kept in `window.name`. The server keeps the union in
kv (`window:<id>`), publishes it on the realtime channel `panes` when it changes, and drops a
window on `forgetWindow` or when its report expires. A plugin page takes the focused pane's
place, so the thread it displaced stays reported until that pane shows a thread again or
closes; a single-pane window keeps reporting the thread it showed before the page.

"Open in a pane" in a row's menu calls `openInPane`; the server picks the window that owns the
panes (not compact, with a split if any window has one, then the window used most recently) and
publishes `open-thread` with that window's id, and the overlay there calls
`toThread(id, { split: true })`. With no such window the page opens the thread in its own
window.

## Troubleshooting

- A thread isn't listed: check it's open in a pane of a bb window whose overlay is running
  (`bb plugin list` shows switchboard running), or pick All.
- A thread is in FYI but should be a Reply: its unread turns all came from another thread
  outside `relaySections` whose sending turn wasn't the user's either, three threads back. Check
  each with
  `curl "http://127.0.0.1:38886/api/v1/threads/<id>/events?types=client/turn/requested,turn/completed&order=desc&limit=24"`.
- The pane summary, finished threads included:
  `curl -X POST -H 'content-type: application/json' -d null http://127.0.0.1:38886/api/v1/plugins/switchboard/rpc/getPanes`.
- The rail has no Switchboard icon: `bb settings ui get sidebar.visiblePluginPanels` must
  include `switchboard/switchboard`, or be null.
- `bb plugin logs switchboard` shows window goodbyes and open-in-pane relays.
- A bar says "An agent opened this in bb, so Switchboard stayed put": an agent ran
  `bb thread open <thread> <file> --split right`, which bb broadcasts to every client
  (`notifyThreadOpen`, `broadcastToAllClients`), and each window goes to the thread. The
  overlay sends a compact window (under 768px) back to Switchboard when it was showing the
  page within the last second and there was no pointerdown, keydown or focus in that window in
  the 1.5s before (`shouldStayOnSwitchboard` in `src/panes.ts`); the page reopens the slide's
  chat if it comes back within 5s, at the reading place: a capture-phase scroll listener on
  `.sb-slide-body` keeps `pageState.scroll` (distance from the end), and on a restore the page
  puts it back once the chat has drawn that far, holding it for 0.8s against bb's own
  scroll-to-end and letting go on any wheel, touch, pointer or key. Show opens the thread in the
  slide and its file beside it, or goes to the thread when there's no file. If the window stays on the thread
  instead, something counted as input; `stayOnSwitchboard` false turns this off.
- The window didn't widen when the panel opened: only in bb's Mac app, only under 768px, and
  only on the Switchboard page. Turn on the debug log (above) and open the panel again; a window
  that couldn't resize at all is marked unsupported until the page reloads.
- The window stayed wide: it only shrinks back if its width hasn't changed by hand since it
  widened, and not after bb restarts. Drag it narrow by hand.
- Ask the desk opens New chat instead: no active top-level thread in the `frontDesk` section
  (`bb thread list --section <id> --json`).
