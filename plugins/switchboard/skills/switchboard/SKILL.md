---
name: switchboard
description: What the Switchboard bb plugin is, its settings and how its "open in a pane" relay works. Use when the user asks about Switchboard, the compact chat list, the small second bb window, or why a thread does or doesn't appear in it.
---

# Switchboard

Switchboard is a bb plugin page (rail icon, or Cmd+Shift+S) that lists the threads open in the
split panes of any bb window, with a state word each, and slides bb's own chat open in place
when a row is clicked. It's sized for a small second bb window (Cmd+Shift+N, about 500px
wide) and works in the main window too. There is no CLI command.

## What's listed

- Threads open in a split pane of any bb window, until the pane closes. A window showing one
  thread with no split counts. Threads started from Switchboard's own New chat button stay
  listed until that window closes.
- With `showChildren` on (the default), threads spawned by a listed thread nest under it.
- Hidden helper threads (`visibility: "hidden"`) and archived threads never show.
- The "All threads" toggle at the top lists every active thread instead. It's a per-browser
  choice, kept in localStorage.

The state words are Needs you (pending interaction, `waiting-for-input` or `queued-failed`
indicator, or `error` status), Working (`active`, `starting`, `stopping`, or a runtime status
of `provisioning` or `host-reconnecting`), Done (bb's unread flag, or it went from working to
idle while it wasn't the chat open in the slide) and Idle. Order is Needs you, Working, Done,
then the rest by most recent attention.

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

## How panes cross windows

An overlay in every bb window reports that window's panes to the plugin server over RPC
(`reportPanes`), keyed by a per-window id kept in sessionStorage. The server keeps the union in
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
  (`bb plugin list` shows switchboard running), or use the All threads toggle.
- The rail has no Switchboard icon: `bb settings ui get sidebar.visiblePluginPanels` must
  include `switchboard/switchboard`, or be null.
- `bb plugin logs switchboard` shows window goodbyes and open-in-pane relays.
