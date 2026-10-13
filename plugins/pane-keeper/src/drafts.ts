/**
 * Drafts: a New thread prompt handed in from outside the app by
 * `bb pane-keeper draft`, for the app to open beside the focused pane without
 * sending it. The server keeps each draft until an app page claims it, so one
 * page gets it exactly once, even when the page loads after the command ran.
 *
 * Pure, and shared by server.ts and app.tsx, so it can be tested without bb.
 */

/** The realtime channel the server nudges open app pages on. */
export const DRAFT_CHANNEL = "draft";

/** bb's own cap on a New thread prefill (its `?initialPrompt=` param). */
export const DRAFT_PROMPT_MAX = 8_000;

/** How long a draft waits for an app page before it's dropped. */
export const DRAFT_TTL_MS = 10 * 60_000;

/** Where drafts live in the plugin's kv store. */
export const DRAFT_KEY_PREFIX = "draft:";

/** How long the app waits for New thread's composer after opening it. */
export const COMPOSER_WAIT_MS = 10_000;

/**
 * How long a hidden page (a background tab, a minimised window) holds back
 * before claiming, so a page that's on screen gets the draft first.
 */
export const HIDDEN_PAGE_DELAY_MS = 1_500;

export interface Draft {
  id: string;
  projectId: string;
  /** Reuse this environment, typically the project's checkout. */
  environmentId: string | null;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}

/** What the app did with a draft it claimed. */
export const DRAFT_OUTCOMES = [
  "inserted",
  "already-there",
  "clipboard",
  "failed",
] as const;

export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];

/** Where a draft stands, as `bb pane-keeper draft --wait` reports it. */
export type DraftStatus = "queued" | "claimed" | DraftOutcome;

export function parseDraft(value: unknown): Draft | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { id, projectId, environmentId, prompt, createdAt, expiresAt } = record;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (environmentId !== null && typeof environmentId !== "string") return null;
  if (typeof prompt !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { id, projectId, environmentId, prompt, createdAt, expiresAt };
}

/** The drafts still worth opening, oldest first. Malformed and expired ones are dropped. */
export function liveDrafts(values: readonly unknown[], now: number): Draft[] {
  return values
    .map(parseDraft)
    .filter((draft): draft is Draft => draft !== null && draft.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Whether the composer's text already holds the prompt, ignoring whitespace,
 * so the same draft handed in twice isn't pasted twice.
 */
export function holdsPrompt(text: string, prompt: string): boolean {
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  const wanted = squash(prompt);
  return wanted.length > 0 && squash(text).includes(wanted);
}

/** The parts of a composer handle that `draftComposer` reads. */
interface ScopedComposer {
  scope:
    | { kind: "new-thread"; projectId: string | null }
    | { kind: "thread" | "queued-message" };
}

/** The New thread composer showing this project, once bb has switched it there. */
export function draftComposer<T extends ScopedComposer>(
  composers: readonly T[],
  projectId: string,
): T | null {
  return (
    composers.find(
      (composer) =>
        composer.scope.kind === "new-thread" &&
        composer.scope.projectId === projectId,
    ) ?? null
  );
}

/**
 * `--environment` takes an environment id, or a checkout's path the way
 * `bb thread spawn --environment` does.
 */
export function parseEnvironmentRef(
  value: string,
): { kind: "id"; id: string } | { kind: "path"; path: string } {
  const trimmed = value.trim();
  if (/^env_[A-Za-z0-9]+$/.test(trimmed)) return { kind: "id", id: trimmed };
  return { kind: "path", path: trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed };
}
