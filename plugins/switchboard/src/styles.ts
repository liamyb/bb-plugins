// Switchboard's own CSS, injected as one <style> by the page and removed when
// it unmounts, the way Message Times does. Colours come from bb's theme
// variables, so a theme switch keeps it in step. Layout is picked by a
// container query on the page, not the window: the same page is a column
// in a small window and a two-column view in the main one.

export const STYLE_ID = "bb-plugin-switchboard-style";

/** The page width at which the chat sits beside the list instead of over it. */
export const WIDE_MIN_PX = 700;

/** How long the slide takes. Instant under prefers-reduced-motion. */
export const SLIDE_MS = 240;

export const CSS = `
.sb-page {
  --sb-slide-duration: ${SLIDE_MS}ms;
  --sb-slide-easing: var(--bb-blade-easing, cubic-bezier(0.22, 1, 0.36, 1));
  --sb-list-width: 280px;
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  container-name: switchboard;
  background: var(--background, var(--canvas));
  color: var(--foreground, var(--ink));
  font-size: 0.8125rem;
}
@media (prefers-reduced-motion: reduce) {
  .sb-page {
    --sb-slide-duration: 0ms;
  }
}

/* The list column. Full width when narrow, a fixed column when wide. */
.sb-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.sb-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
}
.sb-toolbar-spacer {
  flex: 1 1 auto;
}
.sb-button {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  height: 1.75rem;
  padding: 0 0.625rem;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--card, var(--background, var(--canvas)));
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
}
.sb-button:hover {
  background: var(--accent);
}
.sb-button:focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: 1px;
}
.sb-button[data-primary] {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--primary-foreground);
}
.sb-button[data-primary]:hover {
  filter: brightness(1.06);
}
.sb-button[aria-pressed="true"] {
  background: var(--accent);
  border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
}
.sb-rows {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0.25rem 0;
  overflow-y: auto;
  list-style: none;
}
.sb-rows ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.sb-empty {
  padding: 1.5rem 1rem;
  color: var(--muted-foreground);
  text-align: center;
  line-height: 1.5;
}

/* A row: bb's status glyph, the title with mention chips, a state word and the menu. */
.sb-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin: 0 0.375rem;
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
}
.sb-row:hover {
  background: var(--accent);
}
.sb-row[data-selected] {
  background: color-mix(in oklab, var(--primary) 14%, transparent);
}
.sb-row-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  min-height: 2rem;
  padding: 0.25rem 0.375rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}
.sb-row-main:focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: -2px;
  border-radius: inherit;
}
.sb-glyph {
  display: inline-flex;
  flex: none;
  width: 1rem;
  height: 1rem;
  align-items: center;
  justify-content: center;
}
.sb-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-title > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-state {
  flex: none;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
  white-space: nowrap;
}
.sb-state[data-state="needs-you"] {
  color: var(--warning-text, var(--warning, var(--destructive)));
  font-weight: 600;
}
.sb-state[data-state="working"] {
  color: var(--foreground, var(--ink));
}
.sb-state[data-state="done"] {
  color: var(--primary);
  font-weight: 600;
}
.sb-menu {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  margin-right: 0.25rem;
  border: 0;
  border-radius: calc(var(--radius, 0.5rem) * 0.5);
  background: none;
  color: var(--muted-foreground);
  font: inherit;
  font-size: 0.875rem;
  line-height: 1;
  opacity: 0;
  cursor: default;
}
.sb-row:hover .sb-menu,
.sb-row:focus-within .sb-menu,
.sb-menu[aria-expanded="true"],
.sb-menu[data-state="open"] {
  opacity: 1;
}
.sb-menu:hover {
  background: color-mix(in oklab, var(--foreground, var(--ink)) 10%, transparent);
  color: var(--foreground, var(--ink));
}
.sb-menu:focus-visible {
  opacity: 1;
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: 1px;
}

/* The view switch: Panes, Waiting, All. */
.sb-views {
  display: inline-flex;
  flex: none;
  padding: 0.125rem;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--card, var(--background, var(--canvas)));
}
.sb-view {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  height: 1.5rem;
  padding: 0 0.5rem;
  border: 0;
  border-radius: calc(var(--radius, 0.5rem) * 0.5);
  background: none;
  color: var(--muted-foreground);
  font: inherit;
  font-size: 0.75rem;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
}
.sb-view:hover {
  color: var(--foreground, var(--ink));
}
.sb-view[aria-pressed="true"] {
  background: var(--accent);
  color: var(--foreground, var(--ink));
}
.sb-view:focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: 1px;
}
.sb-view-count {
  min-width: 1rem;
  padding: 0.0625rem 0.3125rem;
  border-radius: 999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 0.625rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.sb-view-count[data-tone="warning"] {
  background: var(--warning, var(--destructive));
  color: var(--warning-foreground, var(--primary-foreground));
}

/* Waiting: a heading per group, and rows with a second line saying why. */
.sb-group + .sb-group,
.sb-group + .sb-asks,
.sb-rows > ul + .sb-asks {
  margin-top: 0.375rem;
}
.sb-group-head {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  padding: 0.375rem 0.875rem 0.125rem;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.sb-group-count {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.sb-group[data-group="asking"] > .sb-group-head {
  color: var(--warning-text, var(--warning, var(--destructive)));
}
.sb-group[data-group="reply"] > .sb-group-head {
  color: var(--primary);
}
.sb-lines {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.0625rem;
  min-width: 0;
}
.sb-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.sb-hint {
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-wrow[data-group="fyi"] .sb-title {
  color: color-mix(in oklab, var(--foreground, var(--ink)) 80%, transparent);
}

/* Today's asks, from the front desk's ledger. */
.sb-asks > summary {
  list-style: none;
  cursor: default;
}
.sb-asks > summary::-webkit-details-marker {
  display: none;
}
.sb-asks > summary::before {
  content: "▸";
  display: inline-block;
  width: 0.625rem;
  transition: transform 120ms ease;
}
.sb-asks[open] > summary::before {
  transform: rotate(90deg);
}
.sb-ask-list {
  margin: 0;
  padding: 0 0 0.5rem;
  list-style: none;
}
.sb-ask {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: calc(100% - 0.75rem);
  min-height: 1.75rem;
  margin: 0 0.375rem;
  padding: 0.125rem 0.375rem;
  border: 0;
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: default;
}
.sb-ask:not(:disabled):hover {
  background: var(--accent);
}
.sb-ask:disabled {
  color: var(--muted-foreground);
}
.sb-ask:focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: -2px;
}
.sb-ask-time {
  flex: none;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.sb-ask-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-state[data-status="asking"] {
  color: var(--warning-text, var(--warning, var(--destructive)));
  font-weight: 600;
}
.sb-state[data-status="reply"] {
  color: var(--primary);
  font-weight: 600;
}
.sb-state[data-status="working"] {
  color: var(--foreground, var(--ink));
}

/* A workflow running in the thread above: a quieter line where a child would sit. */
.sb-run .sb-row-main {
  min-height: 1.625rem;
  padding-top: 0.125rem;
  padding-bottom: 0.125rem;
}
.sb-run .sb-title {
  color: var(--muted-foreground);
  font-size: 0.75rem;
}

/* The slide: bb's chat, or the New thread composer, sliding in from the right. */
.sb-slide {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--background, var(--canvas));
  transform: translateX(100%);
  transition: transform var(--sb-slide-duration) var(--sb-slide-easing);
  will-change: transform;
  box-shadow: -8px 0 24px -16px color-mix(in oklab, var(--foreground, var(--ink)) 40%, transparent);
  visibility: hidden;
  transition-property: transform, visibility;
}
.sb-page[data-slide-open] .sb-slide {
  transform: translateX(0);
  visibility: visible;
}
.sb-slide-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0.375rem 0.5rem 0.375rem 0.375rem;
  border-bottom: 1px solid var(--border);
}
.sb-slide-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.sb-slide-title > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-icon-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: 0;
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: none;
  color: var(--muted-foreground);
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: default;
}
.sb-icon-button:hover {
  background: var(--accent);
  color: var(--foreground, var(--ink));
}
.sb-icon-button:focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: 1px;
}
.sb-slide-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}
.sb-slide-body > * {
  flex: 1 1 auto;
  min-height: 0;
}
.sb-composer-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0.75rem;
  overflow-y: auto;
}

/* Behind the slide in the wide layout, when nothing is open. */
.sb-blank {
  display: none;
}

/* Wide: the list keeps a column on the left and the chat slides in beside it. */
@container switchboard (min-width: ${WIDE_MIN_PX}px) {
  .sb-list {
    flex: 0 0 var(--sb-list-width);
    width: var(--sb-list-width);
    border-right: 1px solid var(--border);
  }
  .sb-slide {
    position: relative;
    inset: auto;
    flex: 1 1 auto;
    box-shadow: none;
  }
  .sb-blank {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: var(--sb-list-width);
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    color: var(--muted-foreground);
    text-align: center;
    line-height: 1.5;
  }
  .sb-back[data-narrow-only] {
    display: none;
  }
}
`;
