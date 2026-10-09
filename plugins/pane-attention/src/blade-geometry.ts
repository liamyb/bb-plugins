/**
 * Where everything in a row of sliding panes starts from when the focused
 * pane changes, so the switch can play like the Xbox 360 dashboard blades:
 * the pane you open and the pane you leave move as one solid sheet with the
 * strips between them, and nothing reflows on the way.
 *
 * The layout has already snapped to its final state when this runs. Each slot
 * then plays a horizontal translate from where it was on screen to zero:
 * - the opening slot moves its content, at the final width, in from the side
 *   the sheet is travelling from, clipped by its own box;
 * - the closing slot keeps its content at the old width and slides it away
 *   the same way, clipped on the edge that doesn't move;
 * - every other slot and seam moves as a solid piece.
 *
 * Pure, so it can be tested without bb.
 */

/** A horizontal extent in viewport pixels. */
export interface Box {
  left: number;
  right: number;
}

/**
 * Which edge of a growing or shrinking slot moves. The content is pinned to
 * that edge, so it travels with the sheet.
 */
export type Edge = "left" | "right";

export type Role = "open" | "close" | "band";

/** What one slot is doing in a running switch. */
export interface SlotMotion {
  role: Role;
  /** Set for "open" and "close". */
  edge: Edge | null;
  /** The translate to start from, in px. The animation runs it to zero. */
  dx: number;
}

/**
 * The part of a slot that's on screen while a switch runs, given its final
 * box, its role and how far its translate still has to go (`tx`).
 */
export function visibleBox(
  box: Box,
  motion: Pick<SlotMotion, "role" | "edge">,
  tx: number,
): Box {
  if (motion.role === "band" || motion.edge === null) {
    return { left: box.left + tx, right: box.right + tx };
  }
  // An opening slot clips its content to its own box; a closing slot clips
  // only the edge that stays still. Either way the moving edge is where the
  // content's leading edge is now.
  return motion.edge === "left"
    ? { left: box.left + tx, right: box.right }
    : { left: box.left, right: box.right + tx };
}

/**
 * Plan a switch from `fromIndex` to `toIndex`, given where each slot is on
 * screen now (`visible`, which is its old box when nothing is running) and
 * its final box (`next`).
 */
export function planSwitch(
  visible: readonly Box[],
  next: readonly Box[],
  fromIndex: number,
  toIndex: number,
): SlotMotion[] {
  const towardsRight = toIndex > fromIndex;
  return next.map((box, index) => {
    const seen = visible[index] ?? box;
    if (index === toIndex) {
      // The sheet travels away from the old pane, so the new pane's edge
      // facing it is the one that moves.
      const edge: Edge = towardsRight ? "left" : "right";
      return { role: "open", edge, dx: edgeOf(seen, edge) - edgeOf(box, edge) };
    }
    if (index === fromIndex) {
      const edge: Edge = towardsRight ? "right" : "left";
      return { role: "close", edge, dx: edgeOf(seen, edge) - edgeOf(box, edge) };
    }
    return { role: "band", edge: null, dx: seen.left - box.left };
  });
}

function edgeOf(box: Box, edge: Edge): number {
  return edge === "left" ? box.left : box.right;
}

/** Nothing worth animating: every slot is within half a pixel of home. */
export function isStill(motions: readonly SlotMotion[]): boolean {
  return motions.every((motion) => Math.abs(motion.dx) < 0.5);
}
