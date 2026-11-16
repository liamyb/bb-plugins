// The status strip's rules, kept pure so they can be tested without bb.

/** The fields of a sidebar thread these rules read. */
export interface ThreadLike {
  id: string;
  displayTitle: string;
  status: string;
  runtimeStatus: string;
  activity?: { workflows: number; backgroundAgents: number; backgroundCommands: number };
}

export interface WorkingThread {
  id: string;
  title: string;
}

export interface ContextUsage {
  usedTokens: number | null;
  modelContextWindow: number | null;
  estimated?: boolean;
}

// bb's own lists of execution and runtime statuses that count as working,
// the same as Pane Attention's.
const BUSY_STATUS = new Set(["active", "starting", "stopping"]);
const BUSY_RUNTIME = new Set(["active", "host-reconnecting", "provisioning", "starting"]);

/**
 * A thread is working while its turn runs, or while background work it
 * started (workflows, background agents, background commands) is still
 * going after the turn ended. Plan mode and goals don't count: a thread can
 * sit idle in them.
 */
export function isWorking(thread: ThreadLike): boolean {
  const activity = thread.activity;
  const background =
    activity !== undefined &&
    (activity.workflows > 0 || activity.backgroundAgents > 0 || activity.backgroundCommands > 0);
  return BUSY_STATUS.has(thread.status) || BUSY_RUNTIME.has(thread.runtimeStatus) || background;
}

/** The working threads, in the order given, as id and title. */
export function workingThreads(threads: readonly ThreadLike[]): WorkingThread[] {
  return threads.filter(isWorking).map((thread) => ({ id: thread.id, title: thread.displayTitle }));
}

/** True when two working lists show the same threads with the same titles. */
export function sameWorking(a: readonly WorkingThread[], b: readonly WorkingThread[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.title === b[i].title);
}

/** The share of the context window used, 0 to 100, or null when bb doesn't know. */
export function contextPercent(usage: ContextUsage | null | undefined): number | null {
  if (!usage) return null;
  const { usedTokens, modelContextWindow } = usage;
  if (usedTokens === null || modelContextWindow === null || !(modelContextWindow > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((usedTokens / modelContextWindow) * 100)));
}

/** How many of the bar's LEDs to light: at least one once anything is used. */
export function litLeds(percent: number, leds = 10): number {
  if (percent <= 0) return 0;
  return Math.min(leds, Math.max(1, Math.round((percent / 100) * leds)));
}

/** Green below 70%, amber from 70%, red from 90%. */
export function contextLevel(percent: number): "ok" | "high" | "full" {
  if (percent >= 90) return "full";
  if (percent >= 70) return "high";
  return "ok";
}

/** "1 running", "3 running", or "Idle" when nothing is. */
export function runningLabel(count: number): string {
  return count === 0 ? "Idle" : `${count} running`;
}

/** "546,014 of 1,000,000 tokens", with "about" when bb's figure is an estimate. */
export function tokensLabel(usage: ContextUsage): string | null {
  if (usage.usedTokens === null || usage.modelContextWindow === null) return null;
  const n = (v: number) => v.toLocaleString("en-GB");
  return `${usage.estimated ? "About " : ""}${n(usage.usedTokens)} of ${n(usage.modelContextWindow)} tokens`;
}

/**
 * Whether the active theme asks for the strip. A theme opts in by setting
 * --status-strip to on (Mixtape does); the "everyTheme" setting shows it
 * whatever the theme.
 */
export function themeWantsStrip(cssValue: string): boolean {
  return cssValue.trim().toLowerCase() === "on";
}
