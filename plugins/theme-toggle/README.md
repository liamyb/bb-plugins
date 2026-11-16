# Theme Toggle

One button to switch bb between two themes. It's a palette in the sidebar footer, and
Cmd+Option+T does the same, from anywhere in bb. It's in the command palette too, as "Theme
Toggle: switch to the other theme".

By default it switches between [Sandbar](../../themes/sandbar/) and
[Mixtape](../../themes/mixtape/). From Mixtape it goes back to Sandbar; from Sandbar, or any other
theme, it goes to Mixtape.

bb's theme is server-wide, so switching in one window switches every window and device, the same
as picking a theme in Settings > Appearance.

## Install

```sh
bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin theme-toggle --tag-prefix theme-toggle/
```

Both themes need to be installed first (see their READMEs). If one is missing, the button says so
rather than doing nothing.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `first` | `sandbar` | The theme the toggle goes back to |
| `second` | `mixtape` | The theme the toggle switches to |

Use the ids `bb theme list` shows: a custom theme's id is its folder name, and the built-ins are
`default`, `nord`, `dracula`, `solarized`, `gruvbox` and `catppuccin`. For example:

```sh
bb plugin config theme-toggle set second nord
```

To use a different key, change "Theme Toggle: switch to the other theme" in Settings > Keyboard.
