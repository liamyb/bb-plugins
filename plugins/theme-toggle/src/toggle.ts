// The switching rule, kept pure so it can be tested without bb.

export const DEFAULT_FIRST = "sandbar";
export const DEFAULT_SECOND = "mixtape";

/** A setting's theme id, or the fallback when it's missing or blank. */
export function themeSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * The themes the toggle goes round, in order: the first, the second and,
 * when it's set, the third. Blanks are dropped and a theme named twice
 * counts once.
 */
export function themeCycle(first: string, second: string, third = ""): string[] {
  const cycle: string[] = [];
  for (const id of [first, second, third]) {
    const theme = id.trim();
    if (theme !== "" && !cycle.includes(theme)) cycle.push(theme);
  }
  return cycle;
}

/**
 * The theme to switch to. On a theme in the cycle, go to the next one, and
 * from the last back to the first. On anything else (a built-in, another
 * custom theme), go to the second, so the button always does something
 * visible. With two themes this flips between them.
 */
export function nextTheme(active: string, cycle: string[]): string {
  const at = cycle.indexOf(active);
  if (at < 0) return cycle[1] ?? cycle[0] ?? active;
  return cycle[(at + 1) % cycle.length];
}
