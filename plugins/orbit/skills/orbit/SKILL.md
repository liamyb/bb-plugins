---
name: orbit
description: "What the Orbit bb plugin is: a page with a live map of every bb thread (front desk in the middle, each section a system round it with its pinned hub, children beside their parents), what its ripples, comets, rings and colours mean, the Now and Feed lists and the tool-calls chart beside it, its settings, and what it reads. Use when the user asks about Orbit, the agent map or activity visualisation, what something on the map means, why a thread is or isn't on it, why the map isn't moving, or how much it costs to run."
---

# Orbit

A nav panel (rail icon, `/plugins/orbit/orbit`) that draws bb's own state. It starts no agent
turns and spends no tokens.

- **Layout:** today's front desk (the pinned thread of the `frontDesk` section, else its newest)
  is in the middle. Each other section is a system on a path round it: the section's newest
  pinned thread is the hub at its centre, its other top-level threads sit on rings, oldest first.
  A child sits beside its parent, in its parent's system whatever its own section, three
  generations deep. Unsectioned threads share "No section". Archived and hidden threads aren't
  drawn. The layout is worked out from the threads alone, so a thread only moves when the set
  of threads changes.
- **States** (Switchboard's rules): asking you (a question, an approval, a queued message that
  failed) is amber and pings; a failed turn is red; working (a running turn, or background
  agents, commands or workflows after it) glows with two turning arcs; an unread reply is
  half-lit; idle is hollow.
- **Movement:** a ripple with a word is a tool call on that thread (a smaller one is a
  sub-agent's). A comet is a turn one thread started on another: purple for a message or
  hand-off, which leaves a line fading over 45 minutes; green for a child reporting to its
  parent. "you" and "automation" ripples are turns you or an automation started; "done" is a
  turn ending. A family of children turns round its parent while any of them works. Moons are
  background agents, commands and workflows (up to five drawn).
- **Ring round a thread:** context window used, clockwise from the top; amber from 70%, red
  from 88%. Not drawn on children.
- **Dotted lines from the desk:** today's ledger asks (`ledgerFolder`, read from the desk
  thread's checkout), one line to each thread an ask went to, heavier with more asks.
- **Beside the map:** six readouts (working, asking you, tool calls a minute over five minutes,
  context tokens held by working threads, hand-offs today, desk asks today); Now (threads
  working, asking or failed, with model, who the turn is for, elapsed time, context bar and the
  current tool); Feed (the last 60 tool calls, turn requests and turn ends); tool calls a minute
  for the last hour. Rows open their thread; Cmd-click opens a split.
- **Why the map is still:** nothing is working or asking, or `motion` is off, or the system's
  Reduce motion is on. It still updates.
- **Why the history is short after opening:** the server reads the event log only while a page
  shows. On opening it reads the recent turns of every active thread and the recent tool calls
  of those lately at work, so the hour chart fills in from then.
- **Cost:** the thread list is bb's live one. The server reads a thread's new events at most
  once a second, only while a page is visible and heartbeating (every 20s; it stops 50s after
  the last). The ledger is read every 20s. The canvas loop runs only while something moves.
- **Settings:** `bb plugin config orbit set frontDesk <section>`, `ledgerFolder <path>`,
  `motion true|false`.
- **Themes:** colours come from `--orbit-*` variables, falling back to Mixtape's `--mx-lcd*`
  (a black LCD) and then bb's tokens. `--orbit-lcd` set to anything turns on the LCD look.
- **Code:** the event rules are in `src/model.ts`, the layout in `src/layout.ts`, the drawing in
  `src/scene.ts`. Switchboard's turn-origin, busy, front-desk and ledger rules are copied into
  `src/rules.ts` (bb won't build an import from outside the plugin's folder); `rules.test.ts`
  fails when the copy and Switchboard's source disagree.
