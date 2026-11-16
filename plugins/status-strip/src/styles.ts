// The strip's CSS, injected once per window. Everything reads the theme's
// variables with bb's as the fallback, so it suits any theme: Mixtape's --mx-*
// variables make it a green LCD, and elsewhere it's a quiet monospace line.
// A theme can set --status-strip-font-size for a face that's drawn small.
export const STYLE = `
.bss-strip {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  height: 1.5rem;
  margin: 0;
  padding: 0 0.375rem;
  border: 0;
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--mx-lcd, color-mix(in oklab, var(--foreground, #000) 5%, transparent));
  box-shadow: var(--mx-well, none);
  color: var(--mx-lcd-ink, var(--muted-foreground, currentColor));
  font-family: var(--mx-font-lcd, var(--font-mono, ui-monospace, monospace));
  font-size: var(--status-strip-font-size, 0.6875rem);
  line-height: 1;
  white-space: nowrap;
  text-shadow: var(--mx-lcd-glow, none);
  overflow: hidden;
  cursor: pointer;
}
.bss-strip:focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: 1px;
}
.bss-cell {
  display: inline-flex;
  align-items: center;
  gap: 0.375em;
  min-width: 0;
  padding: 0 0.625em;
}
.bss-cell + .bss-cell {
  border-left: 1px solid color-mix(in oklab, currentColor 30%, transparent);
}
.bss-cell:first-child {
  padding-left: 0.125em;
}
.bss-label {
  opacity: 0.7;
}
.bss-dot {
  flex: none;
  width: 0.5em;
  height: 0.5em;
  border-radius: 9999px;
  background: color-mix(in oklab, currentColor 30%, transparent);
}
.bss-cell[data-busy] .bss-dot {
  background: var(--mx-led-green, var(--success, currentColor));
  box-shadow: 0 0 4px var(--mx-led-green, var(--success, currentColor));
  animation: bss-pulse 1.4s ease-in-out infinite;
}
@keyframes bss-pulse {
  50% { opacity: 0.35; }
}
.bss-leds {
  display: inline-flex;
  gap: 1px;
}
.bss-led {
  width: 0.3em;
  height: 0.75em;
  background: color-mix(in oklab, currentColor 16%, transparent);
}
.bss-led[data-on] {
  background: var(--mx-led-green, var(--success, currentColor));
  box-shadow: 0 0 3px color-mix(in oklab, var(--mx-led-green, var(--success, currentColor)) 70%, transparent);
}
.bss-led[data-on][data-level="high"] {
  background: var(--mx-led-amber, var(--warning, currentColor));
  box-shadow: 0 0 3px color-mix(in oklab, var(--mx-led-amber, var(--warning, currentColor)) 70%, transparent);
}
.bss-led[data-on][data-level="full"] {
  background: var(--mx-led-red, var(--destructive, currentColor));
  box-shadow: 0 0 3px color-mix(in oklab, var(--mx-led-red, var(--destructive, currentColor)) 70%, transparent);
}
.bss-branch-name {
  min-width: 0;
  max-width: 16ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bss-details {
  padding: 0.5rem 0.75rem 0.625rem;
  font-size: 0.75rem;
  color: var(--foreground, currentColor);
}
.bss-details-head {
  margin: 0 0 0.25rem;
  font-weight: 700;
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground, currentColor);
}
.bss-details ol {
  margin: 0 0 0.5rem;
  padding: 0;
  list-style: none;
}
.bss-details li + li {
  margin-top: 0.125rem;
}
.bss-open {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-width: 0;
  padding: 0.25rem 0.375rem;
  border: 0;
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bss-open:hover {
  background: var(--state-hover, color-mix(in oklab, currentColor 8%, transparent));
}
.bss-open-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bss-open .bss-dot {
  background: var(--mx-led-green, var(--success, currentColor));
}
.bss-note {
  color: var(--muted-foreground, currentColor);
}
@media (prefers-reduced-motion: reduce) {
  .bss-cell[data-busy] .bss-dot {
    animation: none;
  }
}
`;
