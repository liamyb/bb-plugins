/**
 * The Commit button in Switchboard's slide.
 *
 * bb 0.48 put its own Commit button in the thread header only, and the slide
 * shows bb's chat without that header, so a chat opened from Switchboard had
 * no way to commit. When the open chat's checkout has uncommitted changes,
 * the slide's header shows Commit with the count; it asks first, listing the
 * changes, then makes the same call bb's button does
 * (`environments.commit`), which stages everything (`git add -A`, so new
 * files too, and nothing `.gitignore` leaves out) and has bb write the
 * message.
 *
 * Pure, so it can be tested without bb: reading `git status` and wording
 * what the button and its confirm say.
 */

/** What the server reads from `git status` for a checkout. */
export interface CheckoutChanges {
  /** The branch checked out, or null when detached or unknown. */
  branch: string | null;
  /** How many paths have changes, staged or not, new files counted one by one. */
  count: number;
  /** The first few changed paths, in git's order. */
  paths: string[];
}

/** How many paths the confirm lists before "and N more". */
export const LISTED_PATHS = 8;

/** How many paths the server sends at most. */
export const SENT_PATHS = 12;

/**
 * Reads `git status --porcelain=v1 -z --branch --untracked-files=all`.
 * Entries are NUL-separated; a rename or copy carries its old path as the
 * next entry, which isn't a change of its own. The `##` line names the
 * branch: `## main...origin/main [ahead 1]`, `## No commits yet on main`,
 * or `## HEAD (no branch)` when detached.
 */
export function parseStatus(output: string, sent = SENT_PATHS): CheckoutChanges {
  const entries = output.split("\0");
  let branch: string | null = null;
  const paths: string[] = [];
  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length === 0) continue;
    if (entry.startsWith("## ")) {
      branch = branchFromHeader(entry.slice(3));
      continue;
    }
    if (entry.length < 4 || entry[2] !== " ") continue;
    const code = entry.slice(0, 2);
    if (code === "!!") continue;
    count += 1;
    if (paths.length < sent) paths.push(entry.slice(3));
    // A rename or copy: the old path follows as its own entry.
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") index += 1;
  }
  return { branch, count, paths };
}

/** The branch from the text after `## `, or null when detached. */
export function branchFromHeader(header: string): string | null {
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(header);
  if (unborn?.[1] !== undefined) return unborn[1].trim() || null;
  if (header.startsWith("HEAD (no branch)")) return null;
  const name = header.split("...")[0]?.split(" ")[0]?.trim();
  return name !== undefined && name.length > 0 ? name : null;
}

/** The button's label: "Commit" and the count. */
export function commitLabel(count: number): string {
  return `Commit ${count} ${count === 1 ? "change" : "changes"}`;
}

/** The confirm's question. */
export function confirmQuestion(changes: CheckoutChanges, checkout: string | null): string {
  const what = `${changes.count} ${changes.count === 1 ? "change" : "changes"}`;
  const where = [
    checkout === null || checkout.length === 0 ? null : `in ${checkout}`,
    changes.branch === null ? null : `on ${changes.branch}`,
  ].filter((part): part is string => part !== null);
  return `Commit ${[what, ...where].join(" ")}?`;
}

/** The paths the confirm lists, and how many more there are. */
export function listedPaths(changes: CheckoutChanges, listed = LISTED_PATHS): { paths: string[]; more: number } {
  const paths = changes.paths.slice(0, listed);
  return { paths, more: Math.max(0, changes.count - paths.length) };
}

/** Whether a failed commit failed only because there was nothing to commit. */
export function isNothingToCommit(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { code?: unknown }).code ?? ""}`
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "");
  return /no[ _]changes|nothing to commit/i.test(text);
}

/** A failed commit's reason, short enough for a toast. */
export function commitFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line = message.split("\n").find((part) => part.trim().length > 0)?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
