# Status Strip

A one-line readout above each thread's composer, in bb's context row, like the display on an old
media player:

- **Running:** how many threads are working across bb right now, with a pulsing light while any
  are. Background work a thread started (workflows, background agents and commands) counts too.
- **CTX:** how much of this thread's context window is used, as a ten-LED bar and a percentage.
  It turns amber from 70% and red from 90%.
- **⎇:** the thread's branch.

Click it to see the threads that are working. Each one opens beside the pane you're in.

## Where it shows

Only in themes that ask for it, so it doesn't change how other themes look. A theme asks by setting
`--status-strip: on` on `:root`; [Mixtape](../../themes/mixtape/) does. To show it in every theme,
turn on `everyTheme`:

```sh
bb plugin config status-strip set everyTheme true
```

## For themes

While any thread is working, the plugin sets `data-agents-running="<count>"` on the page's `<html>`
element, and takes it off when nothing is. Mixtape uses it to animate its level meter only while
something runs. Turn it off with `bb plugin config status-strip set markWindow false`.

The strip draws itself from the theme's variables, with bb's as the fallback. Mixtape's `--mx-*`
variables make it a green LCD. `--status-strip-font-size` sets its size for a face that's drawn
small.

## Install

```sh
bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin status-strip --tag-prefix status-strip/
```

## How often it reads

The context figure is read every 10 seconds while the thread works and every minute while it's
idle, and the branch every minute, both only while the window is visible. The working count comes
from bb's live thread list, so it costs no extra requests.
