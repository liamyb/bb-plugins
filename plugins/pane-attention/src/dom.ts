import type { Attention } from "./attention";

/** The attribute the theme styles. Set on bb's split pane element. */
export const ATTENTION_ATTRIBUTE = "data-pane-attention";

const PANE_ID_ATTRIBUTE = "data-split-pane-id";

/**
 * Put `data-pane-attention` on exactly the panes in `attention`, and take it
 * off every other element. Touches an element only when its value changes.
 */
export function applyAttention(
  root: ParentNode,
  attention: ReadonlyMap<string, Attention>,
): void {
  for (const element of root.querySelectorAll(`[${ATTENTION_ATTRIBUTE}]`)) {
    const paneId = element.getAttribute(PANE_ID_ATTRIBUTE);
    if (paneId === null || !attention.has(paneId)) {
      element.removeAttribute(ATTENTION_ATTRIBUTE);
    }
  }
  for (const [paneId, value] of attention) {
    const pane = root.querySelector(
      `[${PANE_ID_ATTRIBUTE}="${CSS.escape(paneId)}"]`,
    );
    if (pane !== null && pane.getAttribute(ATTENTION_ATTRIBUTE) !== value) {
      pane.setAttribute(ATTENTION_ATTRIBUTE, value);
    }
  }
}

export function clearAttention(root: ParentNode): void {
  for (const element of root.querySelectorAll(`[${ATTENTION_ATTRIBUTE}]`)) {
    element.removeAttribute(ATTENTION_ATTRIBUTE);
  }
}
