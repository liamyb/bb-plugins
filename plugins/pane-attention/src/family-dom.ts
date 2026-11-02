import type { FamilyMark } from "./families";

/** "parent" or "child", on bb's split pane element. The theme styles it. */
export const FAMILY_ATTRIBUTE = "data-pane-family";
/** The family's hue (0 to 359), as a custom property on the same element. */
export const FAMILY_HUE_PROPERTY = "--bb-pane-family-hue";
/** On the "↳ parent" button the plugin puts in a child's header. */
export const FAMILY_LABEL_ATTRIBUTE = "data-pane-family-label";

const PANE_ID_ATTRIBUTE = "data-split-pane-id";
const FALLBACK_TITLE = "Parent thread";

/**
 * Mark exactly the panes in `marks` and unmark every other one. A child gets
 * a button after its title naming the parent; the click handler is
 * `onFamilyLabelClick`, delegated, so nothing here holds a listener. Touches
 * an element only when something changed, because a MutationObserver calls
 * this again after any change to the tree.
 */
export function applyFamilies(
  root: ParentNode,
  marks: ReadonlyMap<string, FamilyMark>,
): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${FAMILY_ATTRIBUTE}]`)) {
    const paneId = element.getAttribute(PANE_ID_ATTRIBUTE);
    if (paneId === null || !marks.has(paneId)) unmark(element);
  }
  for (const label of root.querySelectorAll(`[${FAMILY_LABEL_ATTRIBUTE}]`)) {
    const paneId = label.closest(`[${PANE_ID_ATTRIBUTE}]`)?.getAttribute(PANE_ID_ATTRIBUTE);
    if (paneId == null || marks.get(paneId)?.role !== "child") label.remove();
  }
  for (const [paneId, mark] of marks) {
    const pane = root.querySelector<HTMLElement>(
      `[${PANE_ID_ATTRIBUTE}="${CSS.escape(paneId)}"]`,
    );
    if (pane === null) continue;
    if (pane.getAttribute(FAMILY_ATTRIBUTE) !== mark.role) {
      pane.setAttribute(FAMILY_ATTRIBUTE, mark.role);
    }
    const hue = String(mark.hue);
    if (pane.style.getPropertyValue(FAMILY_HUE_PROPERTY) !== hue) {
      pane.style.setProperty(FAMILY_HUE_PROPERTY, hue);
    }
    if (mark.role === "child" && mark.parentId !== null) {
      placeLabel(pane, mark.parentId, mark.parentTitle ?? FALLBACK_TITLE);
    }
  }
}

export function clearFamilies(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${FAMILY_ATTRIBUTE}]`)) {
    unmark(element);
  }
  for (const label of root.querySelectorAll(`[${FAMILY_LABEL_ATTRIBUTE}]`)) {
    label.remove();
  }
}

function unmark(element: HTMLElement): void {
  element.removeAttribute(FAMILY_ATTRIBUTE);
  element.style.removeProperty(FAMILY_HUE_PROPERTY);
}

/**
 * The label goes in the title group, after the thread's own menu, so it
 * reads "Title ⋯ ↳ Parent". It only appears where bb draws a thread header:
 * the title group is the focus tab's parent.
 */
function placeLabel(pane: HTMLElement, parentId: string, title: string): void {
  const focusTab = pane.querySelector(
    '[data-testid="app-page-header-content-row"] [data-pane-header-focus-tab]',
  );
  const group = focusTab?.parentElement;
  if (group == null) return;

  let label = group.querySelector<HTMLButtonElement>(`:scope > [${FAMILY_LABEL_ATTRIBUTE}]`);
  if (label === null) {
    label = pane.ownerDocument.createElement("button");
    label.type = "button";
    label.setAttribute(FAMILY_LABEL_ATTRIBUTE, "");
    // bb's own utility classes, so it reads as part of the header under any
    // theme. The theme adds the family colour.
    label.className =
      "min-w-0 shrink truncate rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground cursor-pointer";
    group.append(label);
  }
  if (label.dataset.parentThreadId !== parentId) {
    label.dataset.parentThreadId = parentId;
  }
  const text = `↳ ${title}`;
  if (label.textContent !== text) label.textContent = text;
  const tooltip = `Child of ${title}. Click to open it beside this pane.`;
  if (label.title !== tooltip) {
    label.title = tooltip;
    label.setAttribute("aria-label", `Open parent thread: ${title}`);
  }
}

/**
 * The parent thread a click landed on, or null if it wasn't on a label.
 * Only a plain left click counts; the caller stops it reaching bb.
 */
export function familyLabelTarget(event: MouseEvent): string | null {
  if (event.button !== 0) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const label = target.closest<HTMLElement>(`[${FAMILY_LABEL_ATTRIBUTE}]`);
  return label?.dataset.parentThreadId ?? null;
}
