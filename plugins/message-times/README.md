# Message Times

A small bb plugin. It puts the time you sent each of your messages beside its bubble in
a thread's timeline, in the empty space to the left, level with the bubble's last line. Hovering
the time shows the full date and time.

- Today: `14:32`. Yesterday: `Yesterday 14:32`. Two to six days back: `Mon 14:32`. Older:
  `Mon 6 Oct, 14:32` (with the year if it isn't this year). Six days rather than seven, so a bare
  weekday never means both today and a week ago.
- Hover: `Tuesday 6 October 2026, 14:32:05`. A steer (a message sent mid-turn) adds "Sent mid-turn",
  and a normal message the agent took more than 30 seconds to pick up adds when it started on it.
- Local time, 24-hour. The label re-formats every minute, so "today" rolls over at midnight.
- Only your own messages. bb system notices ("thread completed") and relayed "Message from <thread>"
  messages don't get a time.

## How it works

bb renders each user row with `data-timeline-row-id="<threadId>:user-seed:<seq>"`, where `seq` is
the `client/turn/requested` event behind the row, but it doesn't draw the time. The plugin reads
those events, plus `turn/input/accepted`, through the SDK (`threads.events.list`, filtered to the
two types) and labels each row by that id, so it never counts bubbles. A steer shows its
acceptance time and everything else its request time, the same rule bb uses for the row's own
`createdAt`. A queued message shows when bb sent it on from the queue: the event log doesn't keep
the time it was queued.

It's an `experimental_appOverlay` that renders nothing, injects one `<style>`, and watches the
DOM for new rows. The time is absolutely positioned inside the bubble, so the timeline doesn't
move. The hover card measures itself and shifts sideways to stay inside a narrow pane, and drops
below the time when there's no room above. Folded sliding-pane strips don't draw the thread body,
so the time goes with it. Colours come from the theme's variables (`--subtle-foreground`,
`--muted-foreground`, `--popover`, `--border`), so it works with any theme.

Kept separate from Pane Attention so each has its own off switch.

## Install, update, turn off

It needs no `npm install`: the build only uses the SDK that bb itself provides.

- Install: `bb plugin install git:https://github.com/liamyb/bb-plugins.git@^0.1.0 --plugin message-times --tag-prefix message-times/`
  (bb builds it).
- Working from a clone: `bb plugin install <path to plugins/message-times> --yes`, then
  `bb plugin reload message-times` after each edit.
- Turn off for now: `bb plugin disable message-times`. Back on: `bb plugin enable message-times`.
- Remove: `bb plugin remove message-times --yes`.

## Tests

`npm test` runs `src/times.test.ts` on Node's own test runner (Node 23.6 or later), in
Europe/London time.
