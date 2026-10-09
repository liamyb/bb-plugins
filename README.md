# bb plugins and the Sandbar theme

Three small [bb](https://getbb.app) plugins and a theme, built for working in lots of split panes,
mostly on a laptop screen. I'm not an engineer: all of it was written by Claude in bb threads, from
plain-English asks, and it's what I run every day.

| | What it does |
|---|---|
| [Pane Keeper](plugins/pane-keeper/) | Cmd+N and notification clicks open a new pane to the right of the one you're in, instead of replacing it. At bb's limit of 8 panes it swaps out the one you used least recently |
| [Pane Attention](plugins/pane-attention/) | Marks an unfocused pane when its thread has finished (teal) or is waiting on you (amber), and plays the "blade" slide between folded panes, like the Xbox 360 dashboard |
| [Message Times](plugins/message-times/) | Shows the time you sent each of your messages beside its bubble, with the full date on hover |
| [Sandbar theme](themes/sandbar/) | A sand-and-sea palette, plus the layout that makes the above work: a taller top bar, sliding panes, the attention colours and the blade slide |

Built on bb 0.44 and running on 0.45, on a Mac.

## Install

bb builds each plugin itself, so there's no `npm install`:

```sh
bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin message-times --tag-prefix message-times/
bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.2.0 --plugin pane-attention --tag-prefix pane-attention/
bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin pane-keeper --tag-prefix pane-keeper/
```

**Message Times** works on its own, with any theme.

**Pane Attention draws nothing by itself.** It only sets attributes on the panes, and the theme
does the drawing. Use the Sandbar theme below, or copy its "Pane attention" and "Sliding panes"
blocks into your own.

**Pane Keeper needs two settings** before Cmd+N is its own:

```sh
bb settings ui set sidebar.headerProvider pane-keeper/bridge
bb settings keyboard set thread.new disabled
```

The first gives it a hidden sidebar header, which is the only place bb lets a plugin open a blank
New thread pane in a split. The second frees Cmd+N and Cmd+Shift+O from bb's own New thread so
Pane Keeper can pick them up. The [Pane Keeper README](plugins/pane-keeper/) explains both, and
how to undo them.

For notification clicks to open beside you as well, Notifications Pro needs a small hook. See
[Patches](#patches) below.

## The Sandbar theme

```sh
mkdir -p "$(bb theme dir)/sandbar"
curl -fsSL https://raw.githubusercontent.com/liamyb/bb-plugins/main/themes/sandbar/theme.css \
  -o "$(bb theme dir)/sandbar/theme.css"
bb theme set sandbar
```

The file has two halves. The palette at the top is sampled from my desktop wallpaper. Everything
below it is layout, in blocks that each start with a comment saying what they do and how to undo
them:

- **Taller top bar.** Double bb's height, so pane titles wrap onto two lines instead of cutting
  off, and the thread buttons stack.
- **Pane attention.** The teal and amber bars, tints and dots for Pane Attention.
- **Usage ring by the sidebar toggle.** With the sidebar hidden, the
  [Usage Meter](https://github.com/xMinor-1/bb-plugins) ring moves up beside the toggle.
  Harmless without Usage Meter.
- **Sliding panes.** Below 1900px wide, with three or more panes in a row, every pane but the
  focused one folds into a narrow strip with its title running down it. The blade slide between
  them is in the same block, with its speed in `--bb-blade-duration` (360ms, `0ms` turns it off).

If you'd rather keep your own colours, copy everything from the "Taller top bar" comment down into
your own theme's `theme.css`.

## Patches

[`patches/notifications-pro-pane-keeper.patch`](patches/notifications-pro-pane-keeper.patch) adds
the hook to [Notifications Pro](https://github.com/kr3t3n/bb-plugin-notifications-pro). A click on
a thread notification fires a cancelable `pane-keeper:open-thread` event first, and only navigates
if nothing claims it, so without Pane Keeper nothing changes. It's made against Notifications Pro's
main at `7189cee` (30 Sep 2026), and its 57 tests pass with it.

## Known quirk

If bb restarts Pane Keeper (safe mode on and off, a disable and enable), Cmd+N can go dead because
the window doesn't remount its hidden header. Setting the header afresh fixes it:

```sh
bb settings ui set sidebar.headerProvider __builtin__
bb settings ui set sidebar.headerProvider pane-keeper/bridge
```

## The rest of my setup

These are other people's, and they're what the plugins above were built alongside:

- Georgi's [Sidebar Pro](https://github.com/kr3t3n/bb-plugin-sidebar-pro),
  [Labels Pro](https://github.com/kr3t3n/bb-plugin-labels-pro),
  [Notifications Pro](https://github.com/kr3t3n/bb-plugin-notifications-pro) and
  [File Explorer](https://github.com/kr3t3n/bb-plugin-file-explorer)
- [Thread Namer](https://github.com/suiramdev/bb-plugin-thread-namer), which titles threads
  automatically (I run it on Claude Haiku)
- [Usage Meter](https://github.com/xMinor-1/bb-plugins), the Claude usage ring
- [Aura](https://github.com/MateoCerquetella/bb-plugins), for a wallpaper behind the threads

## Licence

MIT. See [LICENSE](LICENSE).
