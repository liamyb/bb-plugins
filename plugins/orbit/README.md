# Orbit

A live map of every thread across bb, drawn from bb's own state. It starts no agent turns.

- **The map:** today's front desk sits in the middle. Every section is a system round it, with the
  section's pinned thread as its hub and its other threads on rings round the hub. A child thread
  sits beside its parent, and circles it while it works. Threads in no section share one system.
- **What moves, and what it means:** a thread that's working glows, with two arcs turning round
  it. Each tool call sends a ripple out from the thread with the tool's name. A message from one
  thread to another flies across as a comet, and leaves a line that fades over 45 minutes. A
  thread asking you pings amber, and a failed one is red. Small moons are background agents,
  commands and workflows still running. With nothing working or asking, nothing moves.
- **The ring round a thread** is its context window filling up, clockwise from the top. It turns
  amber from 70% and red from 88%.
- **Dotted lines from the desk** go to each thread one of today's asks was routed to, from the
  front desk's ledger. A new ask flies out along its line.
- **Beside the map:** Now lists the threads at work, asking you or failed, each with its model, who
  the turn is for, how long it's run, its context and what it's doing this second. Feed is the tool
  calls and hand-offs as they happen. Under the map are tool calls a minute for the last hour.

Hover a thread for its card. Click to open it, Cmd-click to open it in a split. Clicking a row in
Now or Feed does the same.

## Themes

The map draws itself from the theme. In [Mixtape](../../themes/mixtape/) it's a black LCD with
green ink and scan lines; in [Sandbar](../../themes/sandbar/), or any other theme, it's a card in
the theme's own colours, light or dark. A theme can set any of `--orbit-surface`, `--orbit-ink`,
`--orbit-dim`, `--orbit-text`, `--orbit-ask`, `--orbit-error`, `--orbit-accent` and `--orbit-font`
to restyle it, and `--orbit-lcd` (to any value) for the LCD look.

## Settings

```sh
bb plugin config orbit set frontDesk "Front desk"
bb plugin config orbit set ledgerFolder automation/front-desk/ledger
bb plugin config orbit set motion false
```

- `frontDesk`: the section (name or id) whose pinned thread goes in the middle. With no pin, the
  section's newest thread. Empty: nothing in the middle.
- `ledgerFolder`: where the front desk keeps its daily ledger (`2026-11-03.jsonl`, one ask a
  line). A relative path is read from the desk thread's checkout. Empty: no dotted lines.
- `motion`: off draws the map still. It still follows bb live. Your system's Reduce motion
  setting does the same.

## What it reads, and when

- The threads, their sections, parents and states come from bb's live thread list, which costs
  no extra requests.
- What a thread is doing comes from its event log. bb tells the plugin's server when a thread
  has new events, at most once a second for each thread. While an Orbit page is showing, the
  server reads only those new events, and only the kinds the map draws, then sends them to the
  page. It stops reading within a minute of the last page going, and catches up when one opens.
- The ledger file is read every 20 seconds while the page shows.
- The drawing loop runs only while something on the map is moving and the window is visible.

## Agrees with Switchboard

Orbit uses Switchboard's own rules for who started a turn (you, a child reporting back, another
thread, an automation, or upkeep such as a compact), for which threads count as working or
waiting on you, for finding today's front desk and for reading its ledger. bb won't build a plugin
that imports from outside its own folder, so they're copied into `src/rules.ts`, word for word.
`npm test` runs both copies over the same inputs and fails if they've drifted apart.

## Install

```sh
bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin orbit --tag-prefix orbit/
```

It needs bb 0.49 or later. The middle of the map is the pinned thread of a section called
Front desk, and the dotted lines come from that desk's ledger file. Both are settings (above). With
no such section the map still draws, with nothing in the middle and no dotted lines.
