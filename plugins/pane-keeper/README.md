# Pane Keeper

A small bb plugin for working in split panes. With a split showing, Cmd+N and a Notifications Pro
click open a new pane to the right of the one you're in, instead of replacing it. bb's own
rules decide everything else: something that's already open just gets its pane focused.

With one pane, or in bb's compact layout (under 768px), it stands aside and bb behaves as it
always has.

## What it does

- **Cmd+N and Cmd+Shift+O** run "Pane Keeper: New thread beside this pane". It uses the sidebar
  navigation's own "open New thread in a split" action, then selects the current project and
  focuses the prompt, exactly as bb's New thread does. If a New thread pane is already open, bb
  jumps to it.
- **Notification clicks** from Notifications Pro (OS toasts and the in-app centre) open the
  thread the way a sidebar click does (`actions.open(id, { split: true })`). This needs a small
  hook in Notifications Pro, which fires `pane-keeper:open-thread` on `window` before it
  navigates. The patch is in [`patches/`](../../patches/) at the root of this repo. Pane Keeper claims the event with `preventDefault()` when it has opened the thread.
- **At 8 panes**, bb's limit, bb would replace the pane you're in. Pane Keeper swaps out the pane
  you used least recently instead and says which one in a toast. It never picks the focused
  pane, a pane that isn't a thread, or one Pane Attention has flagged, and it takes idle threads
  before busy ones. If nothing qualifies it opens nothing and says "8 panes open, close one
  first." Set `atPaneLimit` to `notice` to always do that instead.

## Why the header slot

The only SDK route to a blank New thread pane in a split is the sidebar navigation's
`activate("__bb__/new-thread", { openInSplit: true })`, and those actions only work from a
component mounted inside the sidebar. An app overlay sits outside it and gets no-op actions.
So Pane Keeper registers an `experimental_sidebarHeader` that renders nothing and only hands
the actions to the commands. It has to be picked as the header:
`bb settings ui set sidebar.headerProvider pane-keeper/bridge`. It stays mounted while the
sidebar is hidden (bb hides it offcanvas, it doesn't unmount it).

Without the header picked, Cmd+N falls back to bb's own New thread and shows a one-off toast
saying why.

## Setup

- Install: `bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin pane-keeper --tag-prefix pane-keeper/`
  (bb builds it, no npm).
- Header: `bb settings ui set sidebar.headerProvider pane-keeper/bridge`.
- Shortcuts: `bb settings keyboard set thread.new disabled`. bb's New thread lets go of Cmd+N and
  Cmd+Shift+O, and Pane Keeper's two commands pick them up by themselves. While bb holds them,
  Pane Keeper's defaults stay unbound (bb doesn't let a plugin default take an occupied key).
- Working from a clone: `bb plugin install <path to plugins/pane-keeper> --yes`, then
  `bb plugin reload pane-keeper` after each edit.

## Turning parts off

- Cmd+N back to bb: `bb settings keyboard reset thread.new`.
- Notification clicks back to opening over the focused pane:
  `bb plugin config pane-keeper set notificationClicks false`.
- At 8 panes, open nothing rather than swap: `bb plugin config pane-keeper set atPaneLimit notice`.
- All of it: `bb plugin disable pane-keeper`, then `bb settings keyboard reset thread.new`
  (otherwise Cmd+N does nothing) and `bb settings ui reset sidebar.headerProvider`.

## Tests

`npm test` runs `src/placement.test.ts` on Node's own test runner (Node 23.6 or later). The
placement logic is pure; `src/keeper.ts` and `app.tsx` are the bb glue.
