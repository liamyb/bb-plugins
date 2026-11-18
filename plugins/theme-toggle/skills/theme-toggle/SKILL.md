---
name: theme-toggle
description: "What the Theme Toggle bb plugin does: a sidebar-footer button and Cmd+Option+T that switch bb's theme, flipping between two themes (Sandbar and Mixtape by default) or going round three when a third is set (such as Palm Noir), its three settings, and why it switches every window. Use when the user asks about switching themes with one key or button, the palette button in the sidebar footer, Cmd+Option+T, or changing which themes it goes between."
---

# Theme Toggle

- **What it does:** switches bb's theme round a short list of theme ids: `first`, `second` and,
  if it's set, `third`. From one theme in the list it goes to the next, and from the last back to
  the first. From any theme not in the list it goes to `second`. With no third it simply flips
  between two.
- **Where:** a palette button in the sidebar footer ("Switch theme (⌥⌘T)"), the shortcut
  Cmd+Option+T, and the command palette entry "Theme Toggle: switch to the next theme". The
  shortcut can be changed in Settings > Keyboard.
- **Settings:** `first` (default `sandbar`), `second` (default `mixtape`) and `third` (default
  blank), any id from `bb theme list`. Set with
  `bb plugin config theme-toggle set <first|second|third> <id>`; set `third` to an empty string to
  go back to two.
- **Scope:** bb's theme is one server-wide setting, so a switch reaches every window and device,
  exactly like Settings > Appearance or `bb theme set <id>`. Light and dark mode are separate and
  per window; the plugin doesn't touch them.
- **Failure:** if a theme id isn't installed, bb rejects the switch and the plugin shows an error
  toast naming the id. Nothing changes.
- It has no backend beyond declaring the settings; the switch is `sdk.theme.get()` then
  `sdk.theme.set(id)` from the frontend.
