# Pane Attention

A small bb plugin for working in split panes. When a thread finishes a turn in a pane you're not
focused on, the pane gets `data-pane-attention="done"`. When it's waiting on you (a question, an
approval, a failed queued message) or the turn failed, it gets `data-pane-attention="needs-you"`.
Focusing the pane clears "done" and a failure. A pending question stays marked on an unfocused
pane until it's answered, the same as the question mark in the sidebar.

A turn that ends with background agents, background commands or workflows still running doesn't
count as finished. bb reports the thread as idle by then, so since 0.2.1 the plugin also reads the
thread's activity counts, and the pane gets "done" when that work stops.

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

## Thread families

Since 0.3.0 it also shows which split panes belong together. A child thread's pane gets
`data-pane-family="child"`, and so does a grandchild. A top-level thread gets
`data-pane-family="parent"` only while one of its descendants is open in another pane, so a
parent with nothing of its own open, and a thread with no family, look exactly as before. Each
marked pane also gets `--bb-pane-family-hue`, taken from the family's top thread with the same
hash Sidebar Pro uses for its thread discs, so the colour is the same after a reload, in every
window, and matches the disc beside that thread in the sidebar.

A child's header gets a "↳ parent title" button after the thread menu. Clicking it calls
`useBbNavigate().toThread(parent, { split: true })`: bb focuses the parent's pane if it's open,
and otherwise opens it to the right of the child (at bb's 8-pane cap, bb replaces the focused
pane). Archived threads aren't in the sidebar's list, so the plugin fetches any it needs once
through `useSdk().threads.get`.

As with the other marks, the plugin only sets attributes and the button. The Sandbar theme draws
the tint, a bar along the foot of the header (down the right edge of a folded strip, clear of the
attention bar on the left), the button's colour, and hides Sidebar Pro's parent chip in a child's
pane so the parent isn't named twice. Under another theme the button still shows, uncoloured.

Two hashes can land close together, so two families can now and then get similar colours. That's
the price of a colour that never moves. The pure rules are in `src/families.ts`, with tests.

## Install, update, turn off

It needs no `npm install`: the build only uses the SDK that bb itself provides.

- Install: `bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.3.0 --plugin pane-attention --tag-prefix pane-attention/`
  (bb builds it).
- Working from a clone: `bb plugin install <path to plugins/pane-attention> --yes`, then
  `bb plugin reload pane-attention` after each edit.
- Families only: `bb plugin config pane-attention set families false` (back on:
  `bb plugin config pane-attention unset families`). It applies to open windows straight away.
- Turn off for now: `bb plugin disable pane-attention`. Back on: `bb plugin enable pane-attention`.
- Remove: `bb plugin remove pane-attention --yes`.

## Tests

`npm test` runs `src/attention.test.ts` and `src/blade-geometry.test.ts` on Node's own test runner
(Node 23.6 or later).
