# Switchboard

A compact view of the chats you've got going in bb. It lists the threads open in your split
panes, in any bb window, with a state word against each one (Needs you, Working, Done, Idle),
and clicking a row slides bb's own chat open in place so you can read and reply without leaving
the view. A New chat button starts one on your project checkout.

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
  turn), Working, Done (it finished a turn while it wasn't the one you had open, or bb marks it
  unread) and Idle. Done clears when you open the chat, or when it starts working again. The
  rules are Pane Attention's, so the two never disagree.
- **The order.** Needs you first, then Working, then Done, then the rest by most recent
  attention. Children sort the same way under their parent.
- **All threads.** The toggle at the top shows every active thread instead, for when nothing's
  open or the main window is closed.

Hidden helper threads never show, and neither do archived ones.

## The slide

Click a row and bb's complete chat slides in: timeline, streaming, composer, attachments,
approvals and questions, with its own permission mode picker. Click another row to swap.
Escape, or the back control, slides it away.

- **Narrow page** (a 500px window): the chat slides over the whole list, with a back control
  in its header.
- **Wide page** (about 700px or more): the list keeps a 280px column on the left and the chat
  slides in beside it. The list never hides, so you can watch the states change while you
  read.

The layout follows the page's own width, not the window's, so the same page works in both
places.

The composer gets focus when the slide finishes. The motion is 240ms with bb's blade easing,
and instant under "reduce motion".

## New chat

The New chat button slides open bb's own New thread composer, seeded with the project and
environment from the settings below, so a chat started here lands where your other threads do
rather than in a fresh worktree. Change either in the composer before sending. The thread
opens in the slide as soon as it's created.

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

## Settings

| Setting | Default | What it does |
|---|---|---|
| `showChildren` | `true` | Children of an open chat show nested under it |
| `newChatProjectId` | `proj_m7g3w6c5r8` | The project the New chat composer starts on. Set it to yours (`bb project list`), or empty for the composer's own choice |
| `newChatEnvironmentId` | `env_82jgfihfwx` | The environment the New chat composer starts on, normally your project checkout (`bb environment list --project <id>`). Empty for the composer's own choice |
| `paneReportTtlSeconds` | `120` | How long a window's pane report counts after its last heartbeat (10 to 600) |

`bb plugin config switchboard set <key> <value>` sets one; they're also on the plugin's page
in Settings.

## Setup

- Install from a clone: `bb plugin install <path to plugins/switchboard> --yes`, then
  `bb plugin reload switchboard` after each edit. bb builds it itself, and the path install ran
  here with no `npm install` in the folder (its one dependency, zod, resolves from bb). A git
  install installs zod itself. Needs bb 0.46 or later.
- The rail icon: bb's rail only shows the panels in `sidebar.visiblePluginPanels`. If
  Switchboard isn't there, add `switchboard/switchboard` to that list with
  `bb settings ui set sidebar.visiblePluginPanels '[...]'`, or reset the setting to show every
  entry.
- Cmd+Shift+S is the default shortcut for "Switchboard: open, or go back". Rebind it in
  Settings if something else has it.

## Tests

`npm test` runs `src/panes.test.ts` and `src/current.test.ts` on Node's own test runner (Node
23.6 or later). The pane and list rules are pure; `app.tsx` and `server.ts` are the bb glue.
`npm run typecheck` needs `npm install` first.
