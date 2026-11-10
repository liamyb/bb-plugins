/**
 * The usage gauge in Switchboard's title bar: how much of the session and the
 * week you've used, from bb's own plan limits (`system.usageLimits`, the same
 * windows Usage Meter shows).
 *
 * Pure, so it can be tested without bb.
 */

export interface UsageWindow {
  key: "session" | "week";
  /** 0 to 100, rounded. */
  usedPercent: number;
  /** Epoch ms; null when bb doesn't say. */
  resetsAt: number | null;
}

export type UsageTone = "warning" | "bad" | null;

const WORDS: Record<UsageWindow["key"], string> = { session: "Session", week: "Week" };

function windowKey(window: Record<string, unknown>): UsageWindow["key"] | null {
  // A model's own weekly allowance (Fable, say) isn't the plan's week.
  if (typeof window.model === "string" && window.model.length > 0) return null;
  const kind = typeof window.kind === "string" ? window.kind : "";
  const label = typeof window.label === "string" ? window.label.toLowerCase() : "";
  if (kind === "five-hour" || label.includes("session")) return "session";
  if (kind === "weekly" || label.includes("week")) return "week";
  return null;
}

/**
 * The session and week windows from a `system.usageLimits` response, for
 * `providerId` if it's signed in, else the first provider that is. Null when
 * no provider has figures.
 */
export function summariseUsage(response: unknown, providerId = "claude-code"): UsageWindow[] | null {
  if (typeof response !== "object" || response === null) return null;
  const providers = response as Record<string, unknown>;
  const ok = (value: unknown): value is { windows: unknown[] } =>
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "ok" &&
    Array.isArray((value as { windows?: unknown }).windows);
  const chosen = ok(providers[providerId])
    ? providers[providerId]
    : Object.values(providers).find(ok);
  if (chosen === undefined || !ok(chosen)) return null;
  const found = new Map<UsageWindow["key"], UsageWindow>();
  for (const raw of chosen.windows) {
    if (typeof raw !== "object" || raw === null) continue;
    const window = raw as Record<string, unknown>;
    const key = windowKey(window);
    if (key === null || found.has(key)) continue;
    const used = typeof window.usedPercent === "number" ? window.usedPercent : Number.NaN;
    if (!Number.isFinite(used)) continue;
    const resets = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
    found.set(key, {
      key,
      usedPercent: Math.max(0, Math.min(100, Math.round(used))),
      resetsAt: Number.isFinite(resets) ? resets : null,
    });
  }
  const windows = (["session", "week"] as const)
    .map((key) => found.get(key))
    .filter((window): window is UsageWindow => window !== undefined);
  return windows.length === 0 ? null : windows;
}

/** Amber from 80%, red from 95%. */
export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 95) return "bad";
  if (usedPercent >= 80) return "warning";
  return null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When a window resets, in local time: "20:40" today, "Fri 21:00" within the
 * week, otherwise "6 Nov".
 */
export function formatReset(resetsAt: number, now: number): string {
  const at = new Date(resetsAt);
  const today = new Date(now);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return clock;
  const days = (resetsAt - now) / 86_400_000;
  if (days > 0 && days < 6.5) return `${DAYS[at.getDay()]} ${clock}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/**
 * How long until a window resets: "in 2h 10m", "in 45m", "in 3d 4h", or
 * "any moment now" within the last minute.
 */
export function formatCountdown(resetsAt: number, now: number): string {
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes < 1) return "any moment now";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours > 0) return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  return `in ${mins}m`;
}

/**
 * The hover card's line for one window: "Session resets at 17:00 (in 2h 10m)",
 * "Week resets Mon 09:00 (in 6d 23h)", with how much is used ahead of it.
 */
export function resetLine(window: UsageWindow, now: number): { title: string; detail: string } {
  const title = `${WORDS[window.key]} ${window.usedPercent}% used`;
  if (window.resetsAt === null) return { title, detail: "bb doesn't say when it resets" };
  const when = formatReset(window.resetsAt, now);
  const at = /^\d/.test(when) && when.includes(":") ? `at ${when}` : when;
  const countdown = formatCountdown(window.resetsAt, now);
  return { title, detail: `Resets ${at} (${countdown})` };
}

/** The gauge's accessible name, and what its hover card says in one line. */
export function usageLabel(windows: readonly UsageWindow[], now: number): string {
  return windows
    .map((window) => {
      const resets =
        window.resetsAt === null ? "" : `, resets ${formatReset(window.resetsAt, now)}`;
      return `${WORDS[window.key]} ${window.usedPercent}%${resets}.`;
    })
    .join(" ");
}

/** The short word under each ring. */
export function usageWord(key: UsageWindow["key"]): string {
  return WORDS[key].toLowerCase();
}
