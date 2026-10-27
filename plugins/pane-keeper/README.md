# Pane Keeper

A small bb plugin for working in split panes. With a split showing, Cmd+N, a plain click on the
sidebar's New thread button and a Notifications Pro click open a new pane to the right of the one
you're in, instead of replacing it. bb's own rules decide everything else: something that's
already open just gets its pane focused.

With one pane, or in bb's compact layout (under 768px), it stands aside and bb behaves as it
always has. The exception is a draft from `bb pane-keeper draft`, below, which opens beside a
single pane too.

## What it does

- **Cmd+N and Cmd+Shift+O** run "Pane Keeper: New thread beside this pane". It uses bb's own
  "open New thread in a split", the one behind a Cmd+click on the sidebar's New thread button, then
  selects the current project and focuses the prompt, exactly as bb's New thread does. If a New
  thread pane is already open, bb jumps to it.
- **The sidebar's New thread button** (new in 0.3.0). bb 0.47 opens New thread over the pane
  you're in on a plain click and beside it on a Cmd+click. With a split showing, Pane Keeper
  swaps those round: a plain click opens New thread beside the focused pane, exactly as Cmd+N
  does (8-pane handling included), and a Cmd+click (Ctrl+click off the Mac) opens it over the
  focused pane, which is bb's plain click. If a New thread pane is already open, both jump to it.
  It catches the click on `window` before bb sees it, and only a click you make yourself, so its
  own hidden-link click (below) goes straight through. Set `newThreadButton` to `false` to keep
  bb's clicks.
- **Notification clicks** from Notifications Pro (OS toasts and the in-app centre) open the
  thread with bb's split rules (`useBbNavigate().toThread(id, { split: true })`). This needs a small
  hook in Notifications Pro, which fires `pane-keeper:open-thread` on `window` before it
  navigates. The patch is in [`patches/`](../../patches/) at the root of this repo. Pane Keeper claims the event with `preventDefault()` when it has opened the thread.
- **At 8 panes**, bb's limit, bb would replace the pane you're in. Pane Keeper swaps out the pane
  you used least recently instead and says which one in a toast. It never picks the focused
  pane, a pane that isn't a thread, or one Pane Attention has flagged, and it takes idle threads
  before busy ones. If nothing qualifies it opens nothing and says "8 panes open, close one
  first." Set `atPaneLimit` to `notice` to always do that instead.
- **`bb pane-keeper draft`** (new in 0.2.0) opens New thread beside the focused pane with a
  prompt typed in and nothing sent, so you can add to it, pick the mode and send it yourself.
  `bb thread spawn` always sends, and bb registers no URL scheme, so nothing outside the app
  could prefill the app's own New thread. My task list's menu bar item uses it for "Work on this in bb". See [Drafts](#drafts).

## Drafts

```sh
bb pane-keeper draft --project <project id> --environment <env id or checkout path> \
  --wait 20s --json --prompt "$(cat prompt.txt)"
```

- `--project` defaults to the calling thread's project when an agent runs it. `--environment`
  takes an environment id or a checkout path, as `bb thread spawn --environment` does, so a draft
  can land on the project checkout rather than a fresh worktree. Without it New thread keeps its
  own choice.
- The prompt goes in after anything you'd already typed in New thread, as its own paragraph, and
  isn't added twice if it's already there. It's capped at 8,000 characters, bb's own limit for
  prefilling New thread. It's an argument rather than stdin because bb's `--<option>-stdin` only
  takes a single line.
- It opens like Cmd+N, with the 8-pane handling, except that it also opens beside a single pane.
  If a New thread pane is already open, that's the one it uses.
- If New thread can't take it (8 panes with nothing safe to swap, or New thread doesn't appear
  within 10 seconds), the prompt goes on the clipboard and a toast says so.
- `--wait` (up to 60 seconds) says what happened: `inserted`, `already-there`, `clipboard` or
  `failed`. `queued` means no bb window had taken it yet, and `claimed` means one took it but
  hadn't reported back.

How it gets there: the command stores the draft on the server for up to 10 minutes and sends the
app a realtime nudge. The overlay claims it over RPC when nudged, when a page loads and after a
reconnect, so a draft sent while bb is still starting turns up once the window loads. Claims run
one at a time on the server, so with two windows open exactly one gets it, and a window that's on
screen gets first go. The overlay then opens New thread with `useBbNavigate().toCompose()` on the
draft's project and environment, waits for that project's New thread composer in
`useComposers()`, and calls its `insert(prompt, { at: "end", block: true })`. It doesn't pass
`toCompose`'s `initialPrompt`, because bb only applies that to an empty composer and would
otherwise drop the prompt without saying so.

## How it opens the split

The SDK has no call that opens a blank New thread pane in a split. Up to 0.1.0 Pane Keeper borrowed
the sidebar navigation's `activate("__bb__/new-thread", { openInSplit: true })` through a hidden
sidebar header, and bb 0.46 removed both the header slot and that hook, so 0.1.0 doesn't load on
0.46.

Since 0.1.1 it uses bb's link handling instead. bb wraps every plugin's UI in a click handler that
treats a Cmd- or Ctrl-click on an in-app link as "open in split", and `/` is the New thread route.
So the overlay renders a hidden link to `/`, and the command clicks it with Cmd held. That reaches
the same split-open as a Cmd+click on the sidebar's New thread button, whether the sidebar is shown
or hidden. If bb ever stops taking that click, Cmd+N falls back to bb's own New thread and shows a
one-off toast saying so.

## Setup

- Install: `bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.3.0 --plugin pane-keeper --tag-prefix pane-keeper/`
  (bb builds it and installs its one dependency, zod, itself). Needs bb 0.46 or later, for the
  SDK's `useBbNavigate()` split rules. The New thread button handling is for bb 0.47's button and
  does nothing on 0.46. A `^0.2.0` install won't update to 0.3.0, because a caret range on 0.x
  stops at the next minor version, and bb won't install over a plugin that's already there. Run
  `bb plugin remove pane-keeper`, then the install line with `^0.3.0`. Removing it resets the
  settings below to their defaults.
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
- The New thread button back to bb's clicks:
  `bb plugin config pane-keeper set newThreadButton false`.
- All of it: `bb plugin disable pane-keeper`, then `bb settings keyboard reset thread.new`
  (otherwise Cmd+N does nothing).

## Tests

`npm test` runs `src/placement.test.ts` and `src/drafts.test.ts` on Node's own test runner
(Node 23.6 or later). The placement and draft rules are pure; `src/keeper.ts`, `app.tsx` and
`server.ts` are the bb glue. `npm run typecheck` needs `npm install` first.
