// The switching rule, kept pure so it can be tested without bb.

export const DEFAULT_FIRST = "sandbar";
export const DEFAULT_SECOND = "mixtape";

/** A setting's theme id, or the fallback when it's missing or blank. */
export function themeSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * The theme to switch to. On the second theme, go back to the first; on the
 * first or anything else (a built-in, another custom theme), go to the
 * second. So the button always does something visible, and pressing it
 * twice from anywhere lands on the first.
 */
export function nextTheme(active: string, first: string, second: string): string {
  return active === second ? first : second;
}
