# Switchboard

A compact view of the chats you've got going in bb. It lists the threads open in your split
panes, in any bb window, with a state word against each one (Needs you, Working, Done, Idle),
and clicking a row slides bb's own chat open in place so you can read and reply without leaving
the view. A Waiting view gathers every thread that's waiting on you, in every section, and the
rail icon counts the ones asking you or with a reply. An Ask the desk button opens today's
front desk thread, and the + beside it starts a blank chat on your project checkout. The title
bar shows how much of your plan's session and week you've used. In the small window, bb's side
panel slides out beside the list rather than covering it, links to other threads open in
the slide, and a Commit button at the top of the slide commits the chat's checkout when it has
changes.

It's made for a small second bb window: Cmd+Shift+N for a new window, click the Switchboard
icon in the rail, and size it to about 500 by 800. It works as a page in the main window too,
where the chat slides in beside the list instead of over it. Cmd+Shift+S opens it, and goes
back, from anywhere.

## What it shows

- **The chats open in panes.** Every thread open in a split pane of any bb window, until the
  pane is closed. There's no recency rule: a chat you keep open stays listed. A window showing
  one thread with no split counts too. Threads you start from Switchboard itself stay listed
  until you close that window, since they're open nowhere else.
- **Their children.** A thread spawned by an open chat shows nested under it, so a thread
  that's off working on its own is visible from the chat that started it. Setting
  `showChildren` turns that off.
- **A state word.** Needs you (a question, an approval, a failed queued message or a failed
  turn), Working (including a turn that's ended with background agents, commands or workflows
  still running), Done (it finished a turn while it wasn't the one you had open, or bb marks it
  unread) and Idle. Done clears when you open the chat, or when it starts working again. The
  rules are Pane Attention's, so the two never disagree.
- **Running workflows.** Each workflow a listed thread has running shows as its own line under
  it, where a child would sit: the workflow's name on the left, and where it's got to and how
  long it's been going on the right. A workflow that declares phases shows the phase it's in
  and its place among them, like `Refute · 3 of 5 · 6m`. Where phases overlap, which happens in
  a pipeline, that's the earliest one with an agent still queued or running, so the line never
  reads further along than the run is. A workflow without phases shows its agents instead, like
  `11/13 agents · 6m`: the ones that have finished out of the ones it has spawned so far, so the
  total grows as it fans out. Failures are added to either when there are any
  (`Refute · 3 of 5, 1 failed · 6m`), and hovering shows the whole line. The lines refresh every
  10 seconds while anything runs and go when the workflow ends. A workflow has no chat of its
  own, so clicking its line opens the thread that started it.
- **The order.** Needs you first, then Working, then Done, then the rest by most recent
  attention. Children sort the same way under their parent.
- **Three views.** The switch at the top picks Panes (the chats open in panes, as above),
  Waiting (below) or All (every active thread, for when nothing's open or the main window is
  closed). The choice is kept for every window.

Hidden helper threads never show, and neither do archived ones.

## Waiting

When work gets routed to the thread that owns it, replies land all over the sidebar, and bb's
unread dots are easy to miss across dozens of threads. The Waiting view lists every top-level
thread that needs a look, from bb's own state, with no agent turns:

- **Asking you:** a pending question or approval, a queued message that didn't send, or a
  failed turn. A child thread shows here, under its parent's name, while it's waiting for an
  answer. Children show nowhere else, since their parent passes on what they find.
- **Replies:** a thread with a finished turn you haven't read, where at least one of those
  turns was yours: you sent the message, a child reported back, or another thread handed it on
  while working for you. A thread is working for you when it's in one of the `relaySections`
  (the front desk forwards your messages word for word), or when the turn it sent the hand-off
  from was itself yours by the same rule. That's followed back up to three threads, so when the
  desk starts a thread for your ask and that thread hands part of it to another, the other
  thread's answer is a Reply too.
- **FYI:** the same, but every one of those turns came from an automation, or from a thread
  that wasn't working for you, like a hub's note on an automation's run. The second line says
  who sent it. FYI is never hidden, because a hand-off can still turn up something you need.

A `/compact` (including the one `bb thread tell --compact-first` sends ahead of a message) and
the "Please continue." bb sends when it retries after a usage limit don't count either way.
- **Working:** a thread that's busy, with its workflow lines under it. The second line says
  who it's working for when that's another thread.

Each row has the thread's section on its second line, and how long ago it last finished.
Clicking a row opens it in the slide and marks it read; it keeps its place until you close the
slide. "Open in a pane" from the row menu works as everywhere else.

**What "haven't read" means.** bb's own unread state, plus one case bb can't see: bb marks any
thread showing in a split pane read the moment it finishes, focused or not. So each window's
overlay remembers what the threads in its panes were doing, and a thread that finishes while
you aren't looking at its pane (it's not the focused pane, or the window itself isn't focused)
is reported to the server as finished. Focusing that pane, or opening the thread from
Switchboard, clears it. These are Pane Attention's rules, with the window's own focus added.

**Who started a turn** comes from the thread's event log: bb records each message's initiator
(you, another thread with its id, or a child's "completed" notice), and an automation's run
starts with a `[bb automation` envelope. Which turns you haven't read comes from the same log's
`turn/completed` events against the time you last read the thread. The page reads up to 24 of
those events per thread, only for threads that are unread or busy, and again only when the
thread's attention time moves or it starts or stops working.

**Today's asks.** Under the groups, a fold-away list headed by today's front desk thread (see
Ask the desk below), with its own state, so it's one click away. Below it, if the front desk's
ledger for today exists (`askLedgerFolder`, one JSON line per ask with `time`, `ask` and
`thread`), what it was asked today, newest first, with where each ask's thread is now: Asking
you, Reply, FYI, Working, Read or Archived. It's re-read every minute while the view shows.

**The rail badge.** Switchboard's rail icon shows the number of threads asking you plus
replies, amber while any is asking, with the breakdown in its tooltip. It's worked out in every
window from the same rules, so it's there whether or not the page is open. `railBadge` turns
it off.

## The slide

Click a row and bb's complete chat slides in: timeline, streaming, composer, attachments,
approvals and questions, with its own permission mode picker. Click another row to swap.
Escape, or the back control, slides it away.

A link to another thread in that chat opens the linked thread in the slide too, rather than
taking the window off Switchboard, and so does a row of a Threads card (the live status card an
agent puts in a reply, such as the front desk's when it routes something). ← then reads "Back to <the chat you came from>" and steps back
one chat at a time, then to the list; Escape still goes straight to the list. Cmd-click a link
to open it the way bb does. `threadLinksInSlide` turns this off.

A link to a file in the chat's workspace opens the file in the side panel, as it does in a
thread's own view. The link can be relative (`current-projects/notes.md`), an absolute path
inside the workspace, or a `file://` URL. bb's chat only gets a file opener when it sits inside
a thread view, so without this a relative link resolved against Switchboard's own address and
showed "This plugin panel is not available".

**Commit.** bb 0.48 moved its Commit button into the thread header, and hid it unless the Git
plugin's "Show Commit button" is on. The slide shows bb's chat without that header, so a chat
opened here had no way to commit. When the open chat's checkout has uncommitted changes, the
slide's header shows **Commit** with the count. A click lists the changes and asks; Commit then
makes the same call bb's button does, which stages everything in the checkout (new files too,
nothing `.gitignore` leaves out) and has bb write the message ("bb: automated commit" when its
commit-message service is off). A toast gives the commit. The count is read when the chat opens,
whenever its state changes, when the window comes back, and once a minute while it shows.
Switchboard's server reads it with `git status`; a checkout on another machine shows no button.
`commitButton` turns it off.

- **Narrow page** (a 500px window): the chat slides over the whole list, with a back control
  in its header.
- **Wide page** (about 700px or more): the list keeps a 352px column on the left and the chat
  slides in beside it. The list never hides, so you can watch the states change while you
  read.

The layout follows the page's own width, not the window's, so the same page works in both
places.

The composer gets focus when the slide finishes. The motion is 240ms with bb's blade easing,
and instant under "reduce motion".

**When an agent opens something.** An agent puts a file in its side panel with
`bb thread open <thread> <file> --split right`, and bb sends that to every open window, each of
which goes to that thread. A wide window takes it as a split, which is the point. The small
window would lose Switchboard to it, so a window narrower than 768px that's showing Switchboard
goes straight back, with a bar naming the thread. A chat that was open in the slide reopens
where you were reading it, however far up. Nothing an agent does changes what you're looking
at: the bar is all it gets, and you decide with **Show**. Anything you started yourself (a click, a key press, or bringing the window into focus in the
second and a half before) is left alone, and `stayOnSwitchboard` turns it off. You may see the
thread for a frame before the window comes back.

The bar names the file the agent opened ("An agent opened <file>. Show opens it here."), and
nothing else moves: the slide, the side panel and the window stay as they were. **Show** opens
that thread in the slide and the file in Switchboard's own side panel beside it, which slides
out (below), and × dismisses the bar. When there's no file to name, **Show** goes to the thread
itself, where bb has the file open in its panel (Cmd+J hides it, Cmd+Shift+S comes back). Switchboard finds the file in bb's own record of the files each thread has opened
(localStorage `bb.thread.recentItems-<thread>-1`), which isn't part of the plugin SDK: if bb
changes it, the bar simply offers the thread as before.

## The side panel slides out

Under 768px bb's side panel covers the whole window. When it opens on Switchboard in a window
that narrow (a file from the slide's chat, an agent's file you chose to show, the panel button
or Cmd+J), the
window widens to the right instead, so the panel docks beside the list. The panel button and
Cmd+J are handled by Switchboard there, so bb never shows the panel full-window first, and the
list keeps its width the whole time the window widens or shrinks: only the space beside it
changes. The list stays exactly
where it was and the width it was: above 768px bb would normally show its icon rail and any
other panes the window holds (a narrow window keeps them folded behind the one it shows), so
while the panel's out Switchboard hides those with CSS, in that window only, and puts them back
when it closes. The panel takes half the widened window, the same width as the list, unless
you've dragged the divider. The window moves left if it would run off the screen.

**The panel shows the chat's documents**, the way bb's panel shows the thread you're in. A
chat's documents are the ones its thread has open in bb's own panel (Switchboard reads bb's saved
panel state, so a document the thread opened in your main window counts) and the ones opened
while it was in the slide: a link in that chat, or an agent's file you showed. That covers file
previews and file viewers' tabs, such as the PDF viewer's. Whether the panel's open is up to you.
With it open, moving to another chat (by a row, a thread link or ←) closes the last chat's
documents and opens this one's, or closes the panel, shrinking the window, when it has none.
With it closed, nothing opens. Opening it on a chat shows that chat's documents. An agent's file
waits on its bar until you press Show. With the list showing, nothing moves. Tabs already in the panel before Switchboard started
following belong to no chat and close the first time a chat's documents are shown.

Closing the panel (its button, Cmd+J or the last tab's ×) shrinks the window back to its old
width and place, unless you've resized the window by hand in the meantime, which counts as
wanting it that size. While it's widened, an agent's `bb thread open` still keeps it on
Switchboard: bb adds that thread as a split pane beside the list, so Switchboard closes the pane
with its own Close button and puts the file in its panel as another tab.

The small window's other split panes are closed the first time the panel slides out. Narrow, bb
only draws the pane in front, but once the window widens it builds every pane it holds, and a few
long chats there took seconds. The chats themselves aren't touched; they just stop being open in
that window.

It works in bb's Mac app, which lets a page resize its window (`window.resizeTo`); a web browser
won't, and there the panel behaves as bb has it. Hiding the rail, bb's sidebar button and the other panes relies on
bb's own element names (`data-sidebar`, `data-split-resize-grid-root`), which aren't part of the
plugin SDK: if bb renames them, they show again and the window widens to fit them. Reopening a
chat's files reads bb's tab keys (`workspace-file-preview:<path>:<environment>`); a tab that
isn't a workspace or thread-storage file is left where it is. The window widens in one step, not in a glide.
If bb quits while the panel's out, the window reopens at the wider size. `slideOutPanel` turns
it off. Each slide-out and shrink writes one line to the plugin log with how long its steps
took (`bb plugin logs switchboard`). bb rebuilds the page as the window crosses 768px, and
redrawing a long chat there took over three seconds in the Mac app, so the chat in the slide
steps aside while the window widens or shrinks and is drawn again once the panel's settled. A
still copy of it stays on screen meanwhile, and goes once the live chat has drawn, so the slide
never shows blank. To watch it step by step, set
localStorage `bb-plugin-switchboard:debug` to `1` in that window: each step is logged to the
console and kept in `window.__switchboardLog`.

## Ask the desk, and New chat

**Ask the desk** slides today's front desk thread open with its composer focused, so an ask
goes to the desk to route, with attachments and voice as usual. Today's desk is the pinned
thread in the `frontDesk` section (the newest pin if there's more than one, or with none pinned
the section's newest thread), so it follows the morning run's new desk each day without a fixed
id. Opening it marks it read, like any row in Waiting.

**The + beside it** is New chat: it slides open bb's own New thread composer, seeded with the
project and environment from the settings below, so a chat started here lands where your other
threads do rather than in a fresh worktree. Change either in the composer before sending. The
thread opens in the slide as soon as it's created. With no desk to find (`frontDesk` empty, or
no thread in that section), the main button is New chat instead.

## Usage gauge

On the right of the title bar, beside the close and panel buttons, two small rings show how
much of your plan's current session and week you've used, amber from 80% and red from 95%.
Hover over them for a card with when each resets and how long that is, such as "Resets at 17:00
(in 2h 10m)" and "Resets Mon 09:00 (in 5d 18h)", in your Mac's own time. It shows straight away,
and in a window that isn't the active one too, which the browser's own tooltip it replaced
didn't. The figures are bb's own plan limits
(`system.usageLimits`, the same windows Usage Meter shows), for Claude Code if it's signed in,
else the first provider that is. They're read when the page opens, once a minute while the
window is visible, and whenever it comes back into view. A model's own weekly allowance, such
as Fable's, isn't shown. `usageGauge` turns it off.

## Open in a pane

Clicking a row never opens a real pane. The row menu (bb's own: pin, archive, copy link, and
so on) has one extra item, **Open in a pane**, which hands the thread to the split layout with
bb's split rules. From the small window it lands in the window that owns the panes: the page
asks the server, and the overlay in that window opens the split there. With more than one wide
window, the one with a split showing wins, then the one you used last. With no window able to
take a split, it opens in the current one.

## How it reads panes across windows

bb only tells a plugin about the panes in the window it's running in, and the small window has
no panes of its own. So an overlay in every window reports that window's panes (thread ids and
focus) to the plugin server, keyed by a per-window id. The server keeps the union, publishes it
over realtime and the page in any window subscribes. A window re-reports every quarter of the
`paneReportTtlSeconds` lifetime (30 seconds by default) and tries to say goodbye when it
closes; one whose goodbye doesn't arrive drops out after the lifetime.

Opening a plugin page, Switchboard included, puts it in the focused pane's place, and bb puts
the thread back when you leave. So the thread it displaced stays listed until that pane shows a
thread again or closes, and a window with a single pane keeps reporting the thread it showed
before the page. Without that, the chat you'd just been in would vanish from the list the
moment you opened Switchboard.

## How it reads workflows

bb's thread list only counts a thread's running workflows. The detail is on the thread's
timeline, so while a listed thread's count is above zero, the page reads that thread's
timeline summary (`threads.timeline` with `summaryOnly`, which leaves out the chat's rows) at
once and then every 10 seconds, and stops when the count drops to zero. The count comes live
from bb, so a line goes as soon as its workflow ends rather than at the next read. Each open
Switchboard page reads for itself, and nothing reads while no page is open.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `showChildren` | `true` | Children of an open chat show nested under it |
| `newChatProjectId` | `proj_m7g3w6c5r8` | The project the New chat composer starts on. Set it to yours (`bb project list`), or empty for the composer's own choice |
| `newChatEnvironmentId` | `env_82jgfihfwx` | The environment the New chat composer starts on, normally your project checkout (`bb environment list --project <id>`). Empty for the composer's own choice |
| `paneReportTtlSeconds` | `120` | How long a window's pane report counts after its last heartbeat (10 to 600) |
| `frontDesk` | `Front desk` | The section (name or id) whose pinned thread Ask the desk opens and Today's asks starts with. Empty: a plain New chat button and no desk line |
| `relaySections` | `Front desk` | Section names or ids, comma-separated, whose threads pass on your asks: a reply to a turn one of them started counts as a reply, not FYI, and so does one from a thread whose sending turn was yours, up to three threads back |
| `askLedgerFolder` | `automation/front-desk/ledger` | Where the front desk's daily ledger lives (`<YYYY-MM-DD>.jsonl`). A relative path is read from the `newChatEnvironmentId` checkout. Empty: no Today's asks |
| `railBadge` | `true` | The count of threads asking you or with a reply on the rail icon |
| `usageGauge` | `true` | The session and week usage rings in the title bar |
| `stayOnSwitchboard` | `true` | A narrow window showing Switchboard goes straight back to it when something other than you opens a thread there, such as an agent's `bb thread open` |
| `slideOutPanel` | `true` | In a window under 768px, the side panel slides out beside the list (the window widens) instead of covering it, and the bar's Show opens an agent's file in it |
| `threadLinksInSlide` | `true` | A link to another thread in the slide's chat, or a row of a Threads card in it, opens that thread in the slide, with ← stepping back |
| `commitButton` | `true` | A Commit button with the count at the top of the slide while the open chat's checkout has uncommitted changes. It asks first, then commits everything there, as bb's own Commit does |

`bb plugin config switchboard set <key> <value>` sets one; they're also on the plugin's page
in Settings.

## Setup

- Install from a clone: `bb plugin install <path to plugins/switchboard> --yes`, then
  `bb plugin reload switchboard` after each edit. bb builds it itself, and the path install ran
  here with no `npm install` in the folder (its one dependency, zod, resolves from bb). A git
  install installs zod itself. Built and tested on bb 0.48.1; earlier versions weren't tried.
- The rail icon: bb's rail only shows the panels in `sidebar.visiblePluginPanels`. If
  Switchboard isn't there, add `switchboard/switchboard` to that list with
  `bb settings ui set sidebar.visiblePluginPanels '[...]'`, or reset the setting to show every
  entry.
- Cmd+Shift+S is the default shortcut for "Switchboard: open, or go back". Rebind it in
  Settings if something else has it.

## Tests

`npm test` runs `src/panes.test.ts`, `src/current.test.ts`, `src/waiting.test.ts`,
`src/usage.test.ts`, `src/slideout.test.ts`, `src/panelfiles.test.ts` and `src/commit.test.ts`
on Node's own test runner (Node 23.6 or later). The pane, list, Waiting, desk, usage,
slide-out, panel-files and commit rules are pure; `app.tsx` and `server.ts` are the bb glue.
`npm run typecheck` needs `npm install` first.
