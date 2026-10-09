/**
 * Blade slide: when the focused pane changes in a row of folded panes, play
 * the move on transforms instead of letting the slots squash between widths.
 *
 * The Sandbar theme folds the panes and owns the look. This watches
 * `data-focused`, lets the layout snap to its final state, then translates
 * each slot (or the opening and closing panes' content) from where it was on
 * screen back to zero with the Web Animations API, so the browser's
 * compositor does the motion and nothing lays out again until it ends.
 *
 * While a switch runs it sets, for the theme:
 * - `data-blade="open" | "close"` and `data-blade-edge` on the two slots
 *   that change width, and `--bb-blade-width` on the closing one (its pane
 *   stays that wide while it slides away);
 * - `data-blade-title` on their panes, for the strip title that fades out
 *   of the opening pane and into the closing one;
 * - `data-blade="settle"` on the closing slot for a moment afterwards, while
 *   that title fades off the real strip.
 * `data-pane-blades` on <html> tells the theme the plugin is running, so it
 * drops its own fallback transition.
 *
 * Duration and easing come from `--bb-blade-duration` and
 * `--bb-blade-easing` on :root. A duration of 0, or reduced motion, switches
 * straight away.
 */
import {
  isStill,
  planSwitch,
  visibleBox,
  type Box,
  type SlotMotion,
} from "./blade-geometry";

const ROW_GRID = "[data-split-resize-grid-root].flex-row";
const PANE = "[data-split-pane-id]";
const SEAM = '[role="separator"]';
const RUNNING = "data-pane-blades";
const SETTLE_MS = 160;
const DEFAULT_DURATION = 360;
const DEFAULT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

interface Timing {
  duration: number;
  easing: string;
}

interface Run {
  next: Box[];
  seamNext: number[];
  motions: SlotMotion[];
  seamDx: number[];
  /** How far through the slide it is, 0 to 1, after easing. */
  progress: () => number;
  stop: () => void;
}

export function installBlades(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win || typeof win.Element.prototype.animate !== "function") {
    return () => {};
  }
  const html = doc.documentElement;
  html.setAttribute(RUNNING, "");

  const runs = new WeakMap<Element, Run>();

  // Read between switches, never during one: reading a style forces the
  // browser to restyle the page before the switch's attributes are in place.
  let timing = readTiming(win, html);
  const refreshTiming = () => {
    timing = readTiming(win, html);
  };
  const reducedMotion = win.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.addEventListener("change", refreshTiming);
  // `bb theme set` replaces the theme's <style>, so pick up a new speed then.
  const themeWatch = new win.MutationObserver(refreshTiming);
  const themeStyle = doc.getElementById("bb-app-theme");
  if (themeStyle) {
    themeWatch.observe(themeStyle, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // The width each slot last reported, so a switch can tell whether its row
  // was folded, and how wide the closing pane was, without a layout.
  const widths = new WeakMap<Element, number>();
  const sizes = new win.ResizeObserver((entries) => {
    for (const entry of entries) {
      widths.set(entry.target, entry.borderBoxSize[0]?.inlineSize ?? 0);
    }
  });
  const observed = new WeakSet<Element>();
  function observeSlots(grid: Element): void {
    for (const slot of slotsOf(grid)) {
      if (observed.has(slot)) continue;
      observed.add(slot);
      sizes.observe(slot);
    }
  }
  for (const grid of doc.querySelectorAll(ROW_GRID)) observeSlots(grid);

  const focus = new win.MutationObserver((records) => {
    // A pane loses focus and another gains it in the same batch. Pair them
    // up per row.
    const changes = new Map<Element, { from: Element | null; to: Element | null }>();
    for (const record of records) {
      const pane = record.target as Element;
      const grid = pane.closest(ROW_GRID);
      if (!grid) continue;
      const change = changes.get(grid) ?? { from: null, to: null };
      const focused = pane.getAttribute("data-focused") === "true";
      if (record.oldValue === "true" && !focused) change.from = pane;
      if (focused) change.to = pane;
      changes.set(grid, change);
    }
    for (const [grid, { from, to }] of changes) {
      observeSlots(grid);
      if (from && to) switchPanes(grid, from, to);
    }
  });
  focus.observe(doc.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-focused"],
    attributeOldValue: true,
  });

  function switchPanes(grid: Element, fromPane: Element, toPane: Element): void {
    const running = runs.get(grid);
    const slots = slotsOf(grid);
    const fromIndex = slots.findIndex((slot) => slot.contains(fromPane));
    const toIndex = slots.findIndex((slot) => slot.contains(toPane));
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    // Where things are on screen now. With a switch already running, that's
    // part way through it; otherwise it's worked out from the new layout
    // below, because the old one is already gone from the DOM.
    let seen: Box[] | null = null;
    let seamSeen: number[] | null = null;
    if (running) {
      const left = 1 - running.progress();
      seen = running.next.map((box, index) =>
        visibleBox(box, running.motions[index], running.motions[index].dx * left),
      );
      seamSeen = running.seamNext.map((x, index) => x + running.seamDx[index] * left);
      running.stop();
    }
    if (timing.duration <= 0) return;
    // Nothing folds while a pane is maximised.
    if (grid.querySelector("[data-maximized]")) return;

    const closing = slots[fromIndex];
    const opening = slots[toIndex];
    // The closing pane keeps the open width while it slides away. Work that
    // out without a layout if possible: from the switch this one interrupts,
    // or from the sizes the slots last reported.
    let width: number | null = null;
    if (running) {
      width = running.next[fromIndex].right - running.next[fromIndex].left;
    } else {
      const known = slots.map((slot) => widths.get(slot));
      if (known.every((value) => value !== undefined)) {
        const open = known[fromIndex]!;
        // Before the switch the closing slot was the open one. If any other
        // slot was more than a strip, this row wasn't folded: leave it alone.
        if (known.some((value, index) => index !== fromIndex && value! > open / 4)) {
          return;
        }
        width = open;
      }
    }

    const towardsRight = toIndex > fromIndex;
    const mark = (openWidth: number) => {
      closing.setAttribute("data-blade", "close");
      closing.setAttribute("data-blade-edge", towardsRight ? "right" : "left");
      (closing as HTMLElement).style.setProperty("--bb-blade-width", `${openWidth}px`);
      opening.setAttribute("data-blade", "open");
      opening.setAttribute("data-blade-edge", towardsRight ? "left" : "right");
      for (const pane of [...panesOf(closing), ...panesOf(opening)]) {
        const title = titleOf(pane);
        pane.setAttribute("data-blade-title", title);
        pane.firstElementChild?.setAttribute("data-blade-title", title);
      }
    };
    const clear = () => {
      for (const slot of [closing, opening]) {
        slot.removeAttribute("data-blade");
        slot.removeAttribute("data-blade-edge");
        (slot as HTMLElement).style.removeProperty("--bb-blade-width");
        for (const pane of panesOf(slot)) {
          pane.removeAttribute("data-blade-title");
          pane.firstElementChild?.removeAttribute("data-blade-title");
        }
      }
    };
    // Mark the slots before the layout, so the browser lays the closing pane
    // out once, at its old width, rather than folding it and unfolding it.
    if (width) mark(width);

    // One layout, which the browser was about to do anyway.
    const seams = [...grid.children].filter((child) => child.matches(SEAM));
    let next = slots.map(boxOf);
    if (!isFolded(win!, grid, next, toIndex)) {
      if (width) clear();
      return;
    }
    if (!width) {
      // A row this hasn't seen switch yet: now the layout says how wide.
      mark(next[toIndex].right - next[toIndex].left);
      next = slots.map(boxOf);
    }
    const seamNext = seams.map((seam) => seam.getBoundingClientRect().left);
    if (!seen || !seamSeen) {
      const before = settledBefore(next, fromIndex, toIndex);
      seen = before;
      seamSeen = seams.map((seam, index) => {
        const after = slotBefore(grid, seam, slots);
        if (after < 0) return seamNext[index];
        return seamNext[index] + (before[after].right - next[after].right);
      });
    }
    const motions = planSwitch(seen, next, fromIndex, toIndex);
    const seamDx = seamNext.map((x, index) => seamSeen![index] - x);
    if (isStill(motions)) {
      clear();
      return;
    }

    const duration = timing.duration;
    const options: KeyframeAnimationOptions = { duration, easing: timing.easing };
    const animations: Animation[] = [];
    let lead: Animation | null = null;
    const slide = (element: Element, dx: number) => {
      if (Math.abs(dx) < 0.5) return;
      const animation = element.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
        options,
      );
      lead ??= animation;
      animations.push(animation);
    };
    motions.forEach((motion, index) => {
      const slot = slots[index];
      if (motion.role === "band") {
        slide(slot, motion.dx);
        return;
      }
      // A top/bottom pair has a seam of its own, already at its final width.
      if (motion.role === "open") {
        for (const seam of slot.querySelectorAll(SEAM)) slide(seam, motion.dx);
      }
      for (const pane of panesOf(slot)) {
        const sheet = pane.firstElementChild;
        if (sheet) slide(sheet, motion.dx);
        // The strip title fades out of the opening pane as it leaves the
        // strip, and into the closing pane's strip as it arrives.
        if (motion.role === "open" && sheet) {
          animations.push(
            sheet.animate([{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], {
              ...options,
              easing: "linear",
              pseudoElement: "::before",
            }),
          );
        } else if (motion.role === "close") {
          animations.push(
            pane.animate(
              [
                { opacity: 0 },
                { opacity: 0, offset: 0.2 },
                { opacity: 1, offset: 0.85 },
                { opacity: 1 },
              ],
              { ...options, easing: "linear", pseudoElement: "::after" },
            ),
          );
        }
      }
    });
    seams.forEach((seam, index) => slide(seam, seamDx[index]));

    const started = win!.performance.now();
    let stopped = false;
    const run: Run = {
      next,
      seamNext,
      motions,
      seamDx,
      progress() {
        if (!lead || !animations.includes(lead)) return 1;
        const value = lead.effect?.getComputedTiming().progress;
        if (typeof value === "number") return value;
        return Math.min(1, (win!.performance.now() - started) / duration);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        for (const animation of animations) animation.cancel();
        clear();
        if (runs.get(grid) === run) runs.delete(grid);
      },
    };
    runs.set(grid, run);
    Promise.all(animations.map((animation) => animation.finished)).then(settle, () => {});

    // The closing pane is a real strip again, but Sidebar Pro's chip and any
    // attention mark aren't in the ghost title, so fade the ghost off the top
    // of it rather than swapping in one frame.
    function settle(): void {
      if (stopped) return;
      for (const animation of animations) animation.cancel();
      animations.length = 0;
      opening.removeAttribute("data-blade");
      opening.removeAttribute("data-blade-edge");
      closing.setAttribute("data-blade", "settle");
      (closing as HTMLElement).style.removeProperty("--bb-blade-width");
      for (const pane of panesOf(closing)) {
        animations.push(
          pane.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: SETTLE_MS,
            easing: "linear",
            pseudoElement: "::after",
          }),
        );
      }
      Promise.all(animations.map((animation) => animation.finished)).then(
        () => run.stop(),
        () => {},
      );
    }
  }

  return () => {
    focus.disconnect();
    sizes.disconnect();
    themeWatch.disconnect();
    reducedMotion.removeEventListener("change", refreshTiming);
    for (const grid of doc.querySelectorAll(ROW_GRID)) runs.get(grid)?.stop();
    html.removeAttribute(RUNNING);
  };
}

function slotsOf(grid: Element): Element[] {
  return [...grid.children].filter((child) => !child.matches(SEAM));
}

function panesOf(slot: Element): Element[] {
  return slot.matches(PANE) ? [slot] : [...slot.querySelectorAll(PANE)];
}

function titleOf(pane: Element): string {
  const title = pane.querySelector(
    '[data-testid="app-page-header-content-row"] .bb-thread-title',
  );
  return (title?.textContent ?? "").trim();
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right };
}

/** The index of the slot just before a seam, or -1. */
function slotBefore(grid: Element, seam: Element, slots: Element[]): number {
  const before = seam.previousElementSibling;
  return before && before.parentElement === grid ? slots.indexOf(before) : -1;
}

/**
 * The boxes before a switch, when nothing was running: the same row with the
 * open width at `fromIndex` instead of `toIndex`.
 */
function settledBefore(next: Box[], fromIndex: number, toIndex: number): Box[] {
  const openWidth = next[toIndex].right - next[toIndex].left;
  const stripWidth = next[fromIndex].right - next[fromIndex].left;
  const boxes: Box[] = [];
  let x = next[0].left;
  next.forEach((box, index) => {
    let width = box.right - box.left;
    if (index === fromIndex) width = openWidth;
    if (index === toIndex) width = stripWidth;
    boxes.push({ left: x, right: x + width });
    const gap = index + 1 < next.length ? next[index + 1].left - box.right : 0;
    x += width + gap;
  });
  return boxes;
}

/** The theme folded this row: it set the strip width and every other slot is a strip. */
function isFolded(win: Window, grid: Element, next: Box[], toIndex: number): boolean {
  if (!win.getComputedStyle(grid).getPropertyValue("--bb-slide-strip").trim()) {
    return false;
  }
  const open = next[toIndex].right - next[toIndex].left;
  return next.every((box, index) => index === toIndex || box.right - box.left < open / 4);
}

function readTiming(win: Window, html: Element): Timing {
  const style = win.getComputedStyle(html);
  const raw = style.getPropertyValue("--bb-blade-duration").trim();
  const value = parseFloat(raw);
  // "360ms" or a bare number is milliseconds; "0.36s" is seconds.
  let duration = raw.endsWith("ms") || !raw.endsWith("s") ? value : value * 1000;
  if (!Number.isFinite(duration)) duration = DEFAULT_DURATION;
  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) duration = 0;
  const easing = style.getPropertyValue("--bb-blade-easing").trim() || DEFAULT_EASING;
  return { duration, easing };
}
