# Palm Noir theme

A coast at dusk for bb. The bars are the night sky, with the sunset glowing along their foot and a
neon horizon line under them. Pane titles are lit like signs on the strip, white-hot with a pink
halo, and they go dark in a pane you're not in. The rail runs down through the sunset to a striped
sun going into the sea, with a few towers on the shore and two palms in front. The open thread is a
slice of the sunset. It's an original look with its own name: palms for the coast, noir for the
late-night crime drama.

In light mode the panels you read are a warm shell-white with dark type; in dark mode they're deep
violet night. The bars, the rail and the titles are the same in both. Times and things that are on
are teal, pink is the accent, and code uses bb's bundled `rose-pine-dawn` (light) and `laserwave`
(dark) colours, set in `theme.json`.

With the [Status Strip](../../plugins/status-strip/) plugin installed, the scene at the foot of the
rail moves while anything is working: the sun's stripes drift down, the light on the water
shimmers and a few windows blink. It's still when nothing runs, and whenever macOS has Reduce
motion on. Palm Noir doesn't turn on the strip itself.

[Switchboard](../../plugins/switchboard/)'s rows take the thread list's look: bold titles, teal
times and states, and a slice of the sunset for the open chat. Its slide, where chats open, has the
wallpaper too.

Behind the threads, and filling New thread, is the same coast as a wallpaper: a striped sun going
into the sea between two clusters of palms, with towers on the shore. It's a neon night with stars
in both light and dark mode; for a golden-hour dusk in light mode instead, set
`LIGHT_MODE_WALLPAPER` to `"light"` in `build.mjs` and rebuild. The light on the water shimmers and
the windows blink, gently, unless macOS has Reduce motion on. The messages you read stay on a calm
panel down the middle. If you use [Aura](https://github.com/MateoCerquetella/bb-plugins), its
wallpaper is hidden while Palm Noir is on, and it returns when you switch back to Sandbar.

It carries all of the [Sandbar](../sandbar/) theme's layout (the taller top bar, sliding panes, the
attention and family colours, the blade slide, the Mac frame fixes), so Pane Attention, Switchboard
and the rest work the same in any of the three themes. Only the look changes.

## Install

```sh
mkdir -p "$(bb theme dir)/palm-noir"
for f in theme.css theme.json; do
  curl -fsSL "https://raw.githubusercontent.com/liamyb/bb-plugins/main/themes/palm-noir/$f" \
    -o "$(bb theme dir)/palm-noir/$f"
done
bb theme set palm-noir
```

## Switching themes

Any of these:

- Settings > Appearance, and pick the theme. Hovering one previews it without saving.
- `bb theme set palm-noir`, and `bb theme set sandbar` to go back.
- The [Theme Toggle](../../plugins/theme-toggle/) plugin, with `palm-noir` as one of its themes.

The theme is the same in every window and on every device, so switching in one switches them all.

## Changing it

`theme.css` is built, so don't edit it by hand. It's made from five files:

| File | What's in it |
|---|---|
| `palette.css` | The colours and type |
| `skin.css` | The sky, the neon, the panels and the rail |
| `scene.mjs` | The sun, the sea, the towers and the palms at the foot of the rail, drawn as SVG |
| `wallpaper.mjs` | The same coast, full size, as the wallpaper behind the threads |
| `../sandbar/theme.css` | The layout, copied in from the "Taller top bar" block down |

After changing any of them, including a layout fix in Sandbar, rebuild and re-apply:

```sh
node build.mjs
bb theme set palm-noir
```

## Type

Titles use Avenir Next Condensed, Heavy Italic, which comes with macOS. Where it's missing, they
fall back to Futura or a narrow sans. Everything you read stays in bb's own font. Nothing is
downloaded.
