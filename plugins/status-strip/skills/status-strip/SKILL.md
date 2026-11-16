---
name: status-strip
description: "What the Status Strip bb plugin does: the one-line readout above a thread's composer (threads running, context used with an LED bar, branch), when it shows (themes that set --status-strip: on, such as Mixtape, or the everyTheme setting), the data-agents-running page mark themes react to, and its settings. Use when the user asks about the strip or readout above the composer, the running count, the context LED bar, the list of working threads it opens, or why the Mixtape level meter moves."
---

# Status Strip

- **What it shows:** in bb's context row above each thread's composer, "N running" (threads
  working across bb, background work included, by the same rule as Pane Attention), "CTX" with a
  ten-LED bar and percentage of this thread's context window (amber from 70%, red from 90%), and
  the thread's branch. The tooltip spells out the token counts.
- **Click:** expands a list of working threads below the row; each opens beside the pane
  (`toThread(id, { split: true })`). The current thread shows as "This thread".
- **When it shows:** only when the active theme sets `--status-strip: on` (Mixtape does), unless
  the `everyTheme` setting is on. It re-reads the flag when bb swaps the theme's stylesheet.
- **Page mark:** while anything works it sets `data-agents-running="<count>"` on `<html>`;
  Mixtape animates its rail meter only then. Setting `markWindow` turns it off.
- **Reads:** `sdk.threads.context` every 10s while the thread works and every 60s idle,
  `sdk.environments.get` every 60s, both only while the page is visible. The count comes from
  `experimental_useSidebarThreads`, with no extra requests.
- **Settings:** `bb plugin config status-strip set everyTheme true|false`,
  `bb plugin config status-strip set markWindow true|false`.
