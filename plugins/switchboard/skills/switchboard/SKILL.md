---
name: switchboard
description: What the Switchboard bb plugin is, its settings, its Waiting view and rail badge, its Ask the desk button and usage gauge, and how its "open in a pane" relay works. Use when the user asks about Switchboard, the compact chat list, the small second bb window, the Waiting view, the count on its rail icon, Ask the desk, the usage rings in its title bar, or why a thread does or doesn't appear in it.
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
  `initiator: "user"`, `initiator: "system"` (a child's completed notice) or from a thread in a
  `relaySections` section makes it a Reply. Only other threads (`initiator: "agent"`,
  `senderThreadId`) or automations (input starting `[bb automation`) make it FYI. A sender that
  isn't an active thread is looked up with `threads.get` for its section; until then the row
  counts as a Reply.

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
  outside `relaySections`. Check with
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
  chat if it comes back within 5s. Show goes to the thread. If the window stays on the thread
  instead, something counted as input; `stayOnSwitchboard` false turns this off.
- Ask the desk opens New chat instead: no active top-level thread in the `frontDesk` section
  (`bb thread list --section <id> --json`).
