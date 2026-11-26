# Mixtape theme

A late-90s desktop media player for bb. The bars and the rail are brushed silver, the buttons in
each pane's header are raised silver keys, and everything you read sits in panels set into the
metal. Pane titles are green LCD readouts, lit in the pane you're in. The thread list has bold
titles with green LCD times, and the open thread is a purple bar. A small green, amber and red level
meter sits low on the rail. It's an original look, not a copy of any player's skin.

In light mode the panels you read are a soft off-white with dark text, which is easier on the eyes
for long sessions; in dark mode they're dark navy with light text. The chrome, the LCD readouts and
the purple selection are the same in both, and `theme.json` gives code and diffs bb's matching
light or dark colours.

With the [Status Strip](../../plugins/status-strip/) plugin, each thread's composer gets an LCD
readout above it: how many threads are working, this thread's context used as an LED bar, and its
branch. Mixtape asks for the strip (`--status-strip: on`), so it only shows in this theme. The
plugin also tells the theme when anything is working, and only then does the rail's level meter
move; it rests when nothing runs, and whenever macOS has Reduce motion on.

[Switchboard](../../plugins/switchboard/)'s rows take the thread list's look: bold titles, LCD
times and states, and a purple bar for the open chat.

The side panel's row of tabs (files, web pages, terminals) is brushed silver like the pane
headers, and the tab you're on is a green LCD readout.

If you use [Aura](https://github.com/MateoCerquetella/bb-plugins), its wallpaper is hidden while Mixtape is on, so the display
stays black. Switch back to Sandbar and it returns.

It carries all of the [Sandbar](../sandbar/) theme's layout (the taller top bar, sliding panes, the
attention and family colours, the blade slide, the Mac frame fixes), so Pane Attention, Switchboard
and the rest work the same in either theme. Only the look changes.

## Install

```sh
mkdir -p "$(bb theme dir)/mixtape"
for f in theme.css theme.json; do
  curl -fsSL "https://raw.githubusercontent.com/liamyb/bb-plugins/main/themes/mixtape/$f" \
    -o "$(bb theme dir)/mixtape/$f"
done
bb theme set mixtape
```

## Switching between Sandbar and Mixtape

Any of these:

- The [Theme Toggle](../../plugins/theme-toggle/) plugin: a palette button in the sidebar footer,
  or Cmd+Option+T.
- Settings > Appearance, and pick the theme.
- `bb theme set mixtape` and `bb theme set sandbar`.

The theme is the same in every window and on every device, so switching in one switches them all.

## Changing it

`theme.css` is built, so don't edit it by hand. It's made from three files:

| File | What's in it |
|---|---|
| `palette.css` | The colours and fonts |
| `skin.css` | The chrome, the keys, the panels, the LCD readouts and the meter |
| `../sandbar/theme.css` | The layout, copied in from the "Taller top bar" block down |

After changing any of them, including a layout fix in Sandbar, rebuild and re-apply:

```sh
node build.mjs
bb theme set mixtape
```

## Fonts

[VT323](https://fonts.google.com/specimen/VT323) for the LCD readouts and
[Silkscreen](https://fonts.google.com/specimen/Silkscreen) for the name stamped on the rail, embedded
in the CSS so the theme works offline. Both are under the SIL Open Font License 1.1; the licence text and
copyright notices are in `fonts/`. The text you read is Verdana, which comes with macOS.
