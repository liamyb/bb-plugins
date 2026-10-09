# Pane Attention

A small bb plugin for working in split panes. When a thread finishes a turn in a pane you're not
focused on, the pane gets `data-pane-attention="done"`. When it's waiting on you (a question, an
approval, a failed queued message) or the turn failed, it gets `data-pane-attention="needs-you"`.
Focusing the pane clears "done" and a failure. A pending question stays marked on an unfocused
pane until it's answered, the same as the question mark in the sidebar.

The plugin draws nothing. The Sandbar theme in this repo ([`themes/sandbar/theme.css`](../../themes/sandbar/theme.css))
styles the attribute next to its sliding-panes block, so all pane chrome lives in one file. With any other
theme the attribute is there but nothing shows.

## Why it keeps its own memory

bb's unread flag can't be used. Every thread rendered in a split pane, focused or not, marks
itself read as soon as its attention time moves. And a child thread's attention time doesn't
move when it goes idle at all. So the plugin watches each pane's thread through
`experimental_useSidebarThreads()` and `useSidebarSplitLayout()`, and flags an unfocused pane
when its thread goes from working to idle, or when bb moves its attention time on. The memory
lives in `sessionStorage`, so a window reload keeps a flag.

## Blade slide

Since 0.2.0 it also animates switching between folded panes (`src/blades.ts`, a content script).
When the focused pane changes in a row the Sandbar theme has folded, the layout snaps to its final
state and the plugin plays the move back on transforms with the Web Animations API: the pane
you open and the pane you leave slide as one solid sheet with the strips between them, each at
full width, so no text re-wraps on the way. The opening strip's title fades out as it leaves, and
the closing pane's title fades into its new strip. A switch in the middle of another carries on
from where everything is on screen. Clicking a strip, Cmd+1 to Cmd+8 and Cmd+Shift and an arrow
all work, because the plugin watches `data-focused` rather than the input.

The plugin only sets attributes (`data-blade`, `data-blade-edge`, `data-blade-title`,
`--bb-blade-width`, and `data-pane-blades` on `<html>`). The theme draws the rest, and its
sliding-panes block holds the two settings:

- `--bb-blade-duration` (360ms) and `--bb-blade-easing` (a decelerating curve). Change them in the
  theme and run `bb theme set sandbar`; the plugin picks the new values up.
- `0ms` turns the slide off and switching is instant. macOS Reduce motion does the same.

Without the theme nothing folds, so nothing slides. Without the plugin the theme falls back to
easing the strips between widths.

`npm test` covers the geometry in `src/blade-geometry.ts`, including going back half way through
a switch.

## Install, update, turn off

It needs no `npm install`: the build only uses the SDK that bb itself provides.

- Install: `bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.2.0 --plugin pane-attention --tag-prefix pane-attention/`
  (bb builds it).
- Working from a clone: `bb plugin install <path to plugins/pane-attention> --yes`, then
  `bb plugin reload pane-attention` after each edit.
- Turn off for now: `bb plugin disable pane-attention`. Back on: `bb plugin enable pane-attention`.
- Remove: `bb plugin remove pane-attention --yes`.

## Tests

`npm test` runs `src/attention.test.ts` and `src/blade-geometry.test.ts` on Node's own test runner
(Node 23.6 or later).
