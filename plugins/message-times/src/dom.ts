// DOM side of Message Times: finding Liam's bubbles in bb's timeline and
// putting a time beside each. Only adds and removes its own nodes; it never
// writes attributes onto bb's elements.

export const LABEL_ATTR = "data-bb-message-time";
const TEXT_ATTR = "data-bb-message-time-text";
const CARD_ATTR = "data-bb-message-time-card";
export const STYLE_ID = "bb-plugin-message-times-style";

// bb gives every timeline row an id; user rows read
// `${threadId}:user-seed:${seq}`.
export const USER_ROW_SELECTOR = '[data-timeline-row-id*=":user-seed:"]';

// The bubble is the bordered box around the message text. Find it from the
// clipped text container inside it, falling back to its place in the row
// (a steer has a "Steer" line above the bubble, so take the last column).
export function findBubble(row: Element): HTMLElement | null {
  const clipped = row.querySelector("[data-message-column] [data-image-gallery-clipped]");
  if (clipped?.parentElement) return clipped.parentElement;
  const group = row.querySelector("[data-message-column] > div");
  const bubble = group?.lastElementChild?.firstElementChild;
  return bubble instanceof HTMLElement ? bubble : null;
}

// <span data-bb-message-time aria-label="Sent …">
//   <span data-bb-message-time-text>14:32</span>
//   <span data-bb-message-time-card aria-hidden>Tuesday 6 October 2026, 14:32:05</span>
// </span>
export function setLabel(
  doc: Document,
  bubble: HTMLElement,
  text: string,
  detail: string,
): void {
  let label = bubble.querySelector<HTMLElement>(`:scope > [${LABEL_ATTR}]`);
  if (!label) {
    label = doc.createElement("span");
    label.setAttribute(LABEL_ATTR, "");
    const textEl = doc.createElement("span");
    textEl.setAttribute(TEXT_ATTR, "");
    const card = doc.createElement("span");
    card.setAttribute(CARD_ATTR, "");
    card.setAttribute("aria-hidden", "true");
    label.append(textEl, card);
    bubble.appendChild(label);
  }
  const textEl = label.querySelector(`[${TEXT_ATTR}]`);
  const card = label.querySelector(`[${CARD_ATTR}]`);
  if (textEl && textEl.textContent !== text) textEl.textContent = text;
  if (card && card.textContent !== detail) {
    card.textContent = detail;
    label.setAttribute("aria-label", `Sent ${detail.replace(/\n/g, ". ")}`);
  }
}

export function removeLabel(row: Element): void {
  for (const label of row.querySelectorAll(`[${LABEL_ATTR}]`)) label.remove();
}

export function removeAllLabels(doc: Document): void {
  for (const label of doc.querySelectorAll(`[${LABEL_ATTR}]`)) label.remove();
}

// True when a mutation batch only touched our own labels, so the observer
// can ignore the echo of its own writes.
export function onlyOurNodes(mutations: readonly MutationRecord[]): boolean {
  const ours = (node: Node | null) =>
    node instanceof Element
      ? node.closest(`[${LABEL_ATTR}]`) !== null
      : node?.parentElement?.closest(`[${LABEL_ATTR}]`) != null;
  for (const mutation of mutations) {
    if (ours(mutation.target)) continue;
    for (const node of mutation.addedNodes) if (!ours(node)) return false;
    for (const node of mutation.removedNodes) if (!ours(node)) return false;
  }
  return true;
}

function clippingBox(el: Element): DOMRect {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      return node.getBoundingClientRect();
    }
  }
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

// The card opens above the time, starting at its left edge and running over
// the bubble. Before it shows, move it sideways to stay inside whatever clips
// the timeline (a narrow pane, a short bubble near the edge), and drop it
// below the time if there's no room above.
export function placeCard(label: Element): void {
  const card = label.querySelector<HTMLElement>(`[${CARD_ATTR}]`);
  if (!card) return;
  const margin = 8;
  const box = clippingBox(label);
  const at = label.getBoundingClientRect();
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  let left = 0;
  if (at.left + left + width > box.right - margin) left = box.right - margin - width - at.left;
  if (at.left + left < box.left + margin) left = box.left + margin - at.left;
  card.style.left = `${Math.round(left)}px`;
  card.toggleAttribute("data-below", at.top - height - 4 < box.top + margin);
}

export function labelFromEvent(event: Event): Element | null {
  const target = event.target;
  return target instanceof Element ? target.closest(`[${LABEL_ATTR}]`) : null;
}

// The time sits in the empty space to the left of the bubble, level with its
// last line. It's absolutely positioned, so nothing in the timeline moves.
// Hovering it shows the full date and time. The card is laid out but hidden
// until then, so it can be measured. Colours come from bb's theme variables.
// A folded sliding-pane strip doesn't draw the body, so the time goes with it.
export const CSS = `
:where([data-timeline-row-id*=":user-seed:"]) :has(> [${LABEL_ATTR}]) {
  position: relative;
}
[${LABEL_ATTR}] {
  position: absolute;
  right: calc(100% + 0.5rem);
  bottom: 0.625rem;
  height: 1.4375rem;
  display: flex;
  align-items: center;
  font-size: 0.6875rem;
  line-height: 1;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: var(--subtle-foreground, var(--muted-foreground));
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
[${LABEL_ATTR}]:hover {
  color: var(--muted-foreground);
}
[${CARD_ATTR}] {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.25rem);
  z-index: 50;
  visibility: hidden;
  padding: 0.3125rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 0.5rem) * 0.75);
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: var(--shadow-md);
  font-size: 0.75rem;
  line-height: 1.45;
  white-space: pre;
  pointer-events: none;
}
[${CARD_ATTR}][data-below] {
  top: calc(100% + 0.25rem);
  bottom: auto;
}
[${LABEL_ATTR}]:hover > [${CARD_ATTR}] {
  visibility: visible;
}
`;
