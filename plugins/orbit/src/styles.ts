// Orbit's own CSS, injected as one <style> by the page and removed when it
// unmounts, the way Switchboard does. Every colour is one of bb's theme
// variables, so a theme switch keeps it in step.
//
// The map takes its colours from the --orb-* variables below. Each falls back
// through a theme's own --orbit-* override, then Mixtape's LCD variables,
// then bb's tokens: in Mixtape the map is a black LCD with green ink, in
// Sandbar (or any other theme) it's a panel in the theme's own colours, a
// shade off the page so it reads as one instrument. The
// page reads --orb-lcd to know which, and sets data-skin for the few rules
// that differ. The canvas reads the same variables (app.tsx `readPalette`).

export const STYLE_ID = "bb-plugin-orbit-style";

/** The page width at which the side column sits beside the map instead of under it. */
export const WIDE_MIN_PX = 860;

export const CSS = `
.orb-page {
  --orb-surface: var(--orbit-surface, var(--mx-lcd, color-mix(in oklab, var(--foreground, var(--ink)) 4%, var(--background, var(--canvas)))));
  --orb-ink: var(--orbit-ink, var(--mx-lcd-ink, var(--primary)));
  --orb-dim: var(--orbit-dim, var(--mx-lcd-dim, var(--muted-foreground)));
  --orb-text: var(--orbit-text, var(--mx-lcd-lit, var(--foreground, var(--ink))));
  --orb-ask: var(--orbit-ask, var(--mx-led-amber, var(--attention, var(--warning))));
  --orb-error: var(--orbit-error, var(--mx-led-red, var(--destructive)));
  --orb-accent: var(--orbit-accent, var(--mx-select-bg, var(--pr-merged, var(--primary))));
  --orb-font: var(--orbit-font, var(--mx-font-lcd, var(--font-sans, ui-sans-serif, system-ui, sans-serif)));
  --orb-readout: var(--mx-readout, var(--primary));
  --orb-readout-font: var(--mx-font-lcd, var(--font-mono, ui-monospace, monospace));
  --orb-lcd: var(--orbit-lcd, var(--mx-lcd, ));
  --orb-glow: var(--mx-lcd-glow, none);
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  container-name: orbit;
  background: var(--background, var(--canvas));
  color: var(--foreground, var(--ink));
  font-size: 0.8125rem;
}
.orb-probe {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

/* Narrow: one scrolling column. Wide: the map with a side column beside it. */
.orb-frame {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0.625rem;
  overflow-y: auto;
  box-sizing: border-box;
}
.orb-main {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.625rem;
  min-width: 0;
}
.orb-side {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.625rem;
  min-width: 0;
}
@container orbit (min-width: ${WIDE_MIN_PX}px) {
  .orb-frame {
    flex-direction: row;
    overflow: hidden;
  }
  .orb-main {
    flex: 1 1 auto;
    min-height: 0;
  }
  .orb-side {
    flex: none;
    width: clamp(17rem, 28cqw, 23rem);
    min-height: 0;
  }
}

/* The readouts along the top. */
.orb-stats {
  display: grid;
  flex: none;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.375rem;
}
@container orbit (min-width: 560px) {
  .orb-stats {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}
.orb-stat {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
  padding: 0.375rem 0.625rem 0.4375rem;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--orb-surface);
}
.orb-stat-value {
  overflow: hidden;
  color: var(--orb-ink);
  font-family: var(--orb-font);
  font-size: 1.25rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  text-overflow: ellipsis;
  text-shadow: var(--orb-glow);
  white-space: nowrap;
}
.orb-stat-value[data-tone="ask"] {
  color: var(--orb-ask);
  text-shadow: none;
}
.orb-stat-value[data-tone="quiet"] {
  color: var(--orb-dim);
  text-shadow: none;
}
.orb-stat-label {
  overflow: hidden;
  color: var(--orb-dim);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.orb-page[data-skin="lcd"] .orb-stat {
  border-color: var(--mx-chrome-edge, var(--border));
  box-shadow: var(--mx-panel-inset, none);
}
.orb-page[data-skin="lcd"] .orb-stat-value {
  font-size: 1.625rem;
  font-weight: 400;
  line-height: 1;
}
.orb-page[data-skin="lcd"] .orb-stat-label {
  font-family: var(--mx-font-pixel, inherit);
  font-size: 0.5rem;
  font-weight: 400;
  letter-spacing: 0.04em;
}

/* The map. */
.orb-map {
  position: relative;
  flex: none;
  width: 100%;
  height: min(112cqw, 36rem);
  min-height: 18rem;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius, 0.5rem);
  background: var(--orb-surface);
}
@container orbit (min-width: ${WIDE_MIN_PX}px) {
  .orb-map {
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
  }
}
.orb-page[data-skin="lcd"] .orb-map {
  border-color: var(--mx-chrome-edge, var(--border));
  box-shadow: var(--mx-panel-inset, none);
}
.orb-map canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
/* An LCD has scan lines. */
.orb-page[data-skin="lcd"] .orb-map::after {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(180deg, transparent 0 2px, rgb(0 0 0 / 0.16) 2px 3px);
  content: "";
  pointer-events: none;
}
.orb-note {
  position: absolute;
  inset: auto 0 0.5rem 0;
  z-index: 2;
  padding: 0 0.75rem;
  color: var(--orb-dim);
  font-size: 0.6875rem;
  text-align: center;
  pointer-events: none;
}
.orb-note[data-centre] {
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8125rem;
}

.orb-legend {
  position: absolute;
  top: 0.4375rem;
  left: 0.5625rem;
  z-index: 2;
  display: none;
  flex-wrap: wrap;
  gap: 0.1875rem 0.75rem;
  max-width: calc(100% - 1.125rem);
  color: var(--orb-dim);
  font-size: 0.625rem;
  letter-spacing: 0.02em;
  pointer-events: none;
}
@container orbit (min-width: 560px) {
  .orb-legend {
    display: flex;
  }
}
.orb-key {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  white-space: nowrap;
}
.orb-key i {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border: 1.25px solid var(--orb-dim);
  border-radius: 50%;
  box-sizing: border-box;
}
.orb-key i[data-kind="working"] {
  border-color: var(--orb-ink);
  background: var(--orb-ink);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--orb-ink) 30%, transparent);
}
.orb-key i[data-kind="unread"] {
  border-color: var(--orb-ink);
  background: color-mix(in oklab, var(--orb-ink) 60%, var(--orb-surface));
}
.orb-key i[data-kind="asking"] {
  border-color: var(--orb-ask);
  background: var(--orb-ask);
}
.orb-key i[data-kind="error"] {
  border-color: var(--orb-error);
  background: var(--orb-error);
}
.orb-key i[data-kind="handoff"],
.orb-key i[data-kind="ask-line"] {
  width: 0.875rem;
  height: 0;
  border: 0;
  border-top: 1.5px solid var(--orb-accent);
  border-radius: 0;
}
.orb-key i[data-kind="ask-line"] {
  border-top: 1.5px dotted var(--orb-text);
}

/* What the pointer is over. */
.orb-tip {
  position: absolute;
  z-index: 3;
  display: grid;
  gap: 0.25rem;
  width: max-content;
  max-width: min(19rem, calc(100% - 1rem));
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--popover, var(--card, var(--background, var(--canvas))));
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.22);
  color: var(--popover-foreground, var(--foreground, var(--ink)));
  font-size: 0.75rem;
  line-height: 1.35;
  pointer-events: none;
}
.orb-tip-title {
  font-size: 0.8125rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.orb-tip-line {
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.orb-tip-line strong {
  color: var(--foreground, var(--ink));
  font-weight: 600;
}
.orb-tip-hint {
  margin-top: 0.125rem;
  color: var(--subtle-foreground, var(--muted-foreground));
  font-size: 0.6875rem;
}

/* A level: context used. */
.orb-level {
  display: inline-block;
  flex: none;
  width: 2.75rem;
  height: 0.3125rem;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground, var(--ink)) 14%, transparent);
  vertical-align: middle;
}
.orb-level i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--orb-readout);
}
.orb-level[data-level="high"] i {
  background: var(--warning);
}
.orb-level[data-level="full"] i {
  background: var(--destructive);
}

/* Tool calls a minute, over the last hour. */
.orb-spectrum {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.4375rem 0.625rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--orb-surface);
}
.orb-page[data-skin="lcd"] .orb-spectrum {
  border-color: var(--mx-chrome-edge, var(--border));
  box-shadow: var(--mx-panel-inset, none);
}
.orb-spectrum-head {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  color: var(--orb-dim);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.orb-spectrum-head span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
}
.orb-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 2.25rem;
}
.orb-bars i {
  display: block;
  flex: 1 1 0;
  min-width: 0;
  min-height: 1px;
  border-radius: 1px 1px 0 0;
  background: color-mix(in oklab, var(--orb-ink) 62%, var(--orb-surface));
}
.orb-bars i[data-empty] {
  background: color-mix(in oklab, var(--orb-dim) 45%, var(--orb-surface));
}
.orb-bars i[data-now] {
  background: var(--orb-ink);
  box-shadow: var(--orb-glow);
}

/* The side column: what's working now, and the feed. */
.orb-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius, 0.5rem);
  background: var(--card, var(--background, var(--canvas)));
}
.orb-panel-head {
  display: flex;
  flex: none;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4375rem 0.75rem;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.orb-panel-count {
  color: var(--orb-readout);
  font-family: var(--orb-readout-font);
  font-size: 0.8125rem;
  font-weight: 400;
  letter-spacing: 0;
}
.orb-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0.25rem 0;
  overflow-y: auto;
  list-style: none;
}
.orb-empty {
  padding: 0.875rem 0.75rem;
  color: var(--muted-foreground);
  line-height: 1.45;
}
@container orbit (min-width: ${WIDE_MIN_PX}px) {
  .orb-now {
    flex: 0 1 auto;
    max-height: 56%;
  }
  .orb-feed {
    flex: 1 1 0;
  }
}
.orb-feed .orb-panel-body {
  max-height: 22rem;
}
@container orbit (min-width: ${WIDE_MIN_PX}px) {
  .orb-feed .orb-panel-body {
    max-height: none;
  }
}

.orb-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.125rem 0.5rem;
  align-items: center;
  width: 100%;
  padding: 0.375rem 0.75rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}
.orb-row:hover,
.orb-row:focus-visible {
  background: var(--accent);
  outline: none;
}
.orb-row-title {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orb-row-time {
  color: var(--orb-readout);
  font-family: var(--orb-readout-font);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.orb-row-meta,
.orb-row-doing {
  display: flex;
  grid-column: 2 / -1;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  white-space: nowrap;
}
.orb-row-meta span,
.orb-row-doing span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.orb-row-doing b {
  flex: none;
  color: var(--orb-readout);
  font-weight: 600;
}
.orb-dot {
  width: 0.5625rem;
  height: 0.5625rem;
  border-radius: 50%;
  background: var(--orb-readout);
}
.orb-dot[data-state="working"] {
  animation: orb-breathe 1.6s ease-in-out infinite;
}
.orb-dot[data-state="asking"] {
  background: var(--attention, var(--warning));
}
.orb-dot[data-state="error"] {
  background: var(--destructive);
}
@keyframes orb-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--orb-readout) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px color-mix(in oklab, var(--orb-readout) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .orb-dot[data-state="working"] { animation: none; }
}

.orb-feed-row {
  display: grid;
  grid-template-columns: auto minmax(0, 0.8fr) minmax(0, 1.4fr);
  gap: 0.5rem;
  align-items: baseline;
  width: 100%;
  padding: 0.1875rem 0.75rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.6875rem;
  text-align: left;
  cursor: default;
}
.orb-feed-row:hover,
.orb-feed-row:focus-visible {
  background: var(--accent);
  outline: none;
}
.orb-feed-row > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.orb-feed-time {
  color: var(--orb-readout);
  font-family: var(--orb-readout-font);
  font-variant-numeric: tabular-nums;
}
.orb-feed-what {
  color: var(--muted-foreground);
}
.orb-feed-what b {
  color: var(--foreground, var(--ink));
  font-weight: 600;
}
.orb-feed-row[data-kind="ask"] .orb-feed-what b {
  color: var(--orb-accent);
}
.orb-page[data-skin="lcd"] .orb-feed-time,
.orb-page[data-skin="lcd"] .orb-row-time,
.orb-page[data-skin="lcd"] .orb-panel-count {
  font-size: 1.0625em;
  line-height: 1;
}

/* The title bar's count. */
.orb-header {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-right: 0.375rem;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  line-height: 1;
  white-space: nowrap;
}
.orb-header i {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: var(--primary);
}
.orb-header i[data-quiet] {
  background: color-mix(in oklab, var(--muted-foreground) 55%, transparent);
}
`;
