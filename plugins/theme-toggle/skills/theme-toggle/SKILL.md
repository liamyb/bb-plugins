---
name: theme-toggle
description: "What the Theme Toggle bb plugin does: a sidebar-footer button and Cmd+Option+T that switch bb between two themes (Sandbar and Mixtape by default), its two settings, and why it switches every window. Use when the user asks about switching themes with one key or button, the palette button in the sidebar footer, Cmd+Option+T, or changing which two themes it flips between."
---

# Theme Toggle

- **What it does:** switches bb's theme between two theme ids. From the second it goes back to
  the first; from the first or any other theme it goes to the second.
- **Where:** a palette button in the sidebar footer ("Switch theme (⌥⌘T)"), the shortcut
  Cmd+Option+T, and the command palette entry "Theme Toggle: switch to the other theme". The
  shortcut can be changed in Settings > Keyboard.
- **Settings:** `first` (default `sandbar`) and `second` (default `mixtape`), any id from
  `bb theme list`. Set with `bb plugin config theme-toggle set <first|second> <id>`.
- **Scope:** bb's theme is one server-wide setting, so a switch reaches every window and device,
  exactly like Settings > Appearance or `bb theme set <id>`. Light and dark mode are separate and
  per window; the plugin doesn't touch them.
- **Failure:** if a theme id isn't installed, bb rejects the switch and the plugin shows an error
  toast naming the id. Nothing changes.
- It has no backend beyond declaring the settings; the switch is `sdk.theme.get()` then
  `sdk.theme.set(id)` from the frontend.
