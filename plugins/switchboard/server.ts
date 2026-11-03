// Switchboard's server side: settings, and the pane registry that lets the
// page in one bb window list the panes of another. Each window's overlay
// (app.tsx) reports its panes here; the server keeps the union of the live
// reports in kv, publishes it over realtime when it changes, and relays
// "Open in a pane" to the window that owns the panes. The rules are pure in
// src/panes.ts.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  OPEN_CHANNEL,
  PANES_CHANNEL,
  REPORT_KEY_PREFIX,
  clampTtlSeconds,
  liveReports,
  paneOwner,
  sameSummary,
  summarize,
  type PanesSummary,
  type StoredReport,
} from "./src/panes";

const paneRefSchema = z
  .object({
    paneId: z.string().min(1).max(100),
    threadId: z.string().min(1).max(100).nullable(),
    isFocused: z.boolean(),
  })
  .strict();

const windowIdSchema = z.string().min(1).max(100);

const summarySchema = z.object({
  openThreadIds: z.array(z.string()),
  ownerWindowId: z.string().nullable(),
  windows: z.number(),
  finishedThreadIds: z.array(z.string()),
});

export const rpcContract = defineRpcContract({
  /** A window saying which panes it has. Sent on every change and as a heartbeat. */
  reportPanes: {
    input: z
      .object({
        windowId: windowIdSchema,
        panes: z.array(paneRefSchema).max(16).nullable(),
        extraThreadIds: z.array(z.string().min(1).max(100)).max(16),
        compact: z.boolean(),
        focusedAt: z.number().nullable(),
        finishedThreadIds: z.array(z.string().min(1).max(100)).max(16).default([]),
      })
      .strict(),
    output: z.object({ expiresAt: z.number() }),
  },
  /** A window closing, so it drops out at once rather than after the lifetime. */
  forgetWindow: {
    input: z.object({ windowId: windowIdSchema }).strict(),
    output: z.null(),
  },
  /** The union of every live window's panes. */
  getPanes: {
    input: z.null(),
    output: summarySchema,
  },
  /**
   * Open a thread as a split in the window that owns the panes. Returns that
   * window's id, or null when no window can take a split.
   */
  openInPane: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ windowId: z.string().nullable() }),
  },
});

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export default function switchboard(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    showChildren: {
      type: "boolean",
      label: "Show child threads",
      description:
        "Threads spawned by an open chat show nested under it, so a thread that's off working on its own stays in view.",
      default: true,
    },
    newChatProjectId: {
      type: "string",
      label: "New chat: project id",
      description:
        "The project the New chat composer starts on (a proj_ id from `bb project list`). You can change it in the composer. Empty: the composer's own choice.",
      default: "proj_m7g3w6c5r8",
    },
    newChatEnvironmentId: {
      type: "string",
      label: "New chat: environment id",
      description:
        "The environment the New chat composer starts on (an env_ id from `bb environment list`). The project checkout keeps a new chat out of a fresh worktree. Empty: the composer's own choice.",
      default: "env_82jgfihfwx",
    },
    paneReportTtlSeconds: {
      type: "number",
      label: "Pane report lifetime (seconds)",
      description:
        "How long a bb window's pane report counts after its last heartbeat. A window that closes without saying so drops out of the list after this.",
      experimental_schema: z.number().int().min(MIN_TTL_SECONDS).max(MAX_TTL_SECONDS),
      default: DEFAULT_TTL_SECONDS,
    },
    frontDesk: {
      type: "string",
      label: "Ask the desk: front desk section",
      description:
        "The section (name or id) whose pinned thread is today's front desk. The Ask the desk button opens it, and it heads the list of today's asks; a + beside the button starts a blank chat. With no pin, the section's newest thread. Empty, or no thread there: the button is a plain New chat.",
      default: "Front desk",
    },
    relaySections: {
      type: "string",
      label: "Waiting: sections that pass on your asks",
      description:
        "Section names or ids, comma-separated. A reply to a turn another thread started is FYI, unless that thread sits in one of these sections, which pass on what you asked (the front desk forwards your messages word for word). Empty: every turn another thread starts is FYI.",
      default: "Front desk",
    },
    askLedgerFolder: {
      type: "string",
      label: "Waiting: front desk ledger folder",
      description:
        "Where the front desk keeps its daily ledger, one file a day named like 2026-11-03.jsonl, one ask per line. The Waiting view lists today's asks from it with where each one is now. A relative path is read from the New chat environment's checkout. Empty: no list of today's asks.",
      default: "automation/front-desk/ledger",
    },
    railBadge: {
      type: "boolean",
      label: "Count on the rail icon",
      description:
        "Show how many threads are asking you or have replied on Switchboard's rail icon, amber while one is asking.",
      default: true,
    },
    usageGauge: {
      type: "boolean",
      label: "Usage gauge in the title bar",
      description:
        "Show how much of your plan's session and week you've used, with when each resets, on the right of Switchboard's title bar. The figures are bb's own, read once a minute while the page shows.",
      default: true,
    },
  });

  const kv = bb.storage.kv;

  // Reads and writes run one at a time, so two windows reporting together
  // can't interleave a stale union into the published summary.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  }

  function keyFor(windowId: string): string {
    return `${REPORT_KEY_PREFIX}${windowId}`;
  }

  /** The live reports, dropping expired and malformed rows from kv on the way. */
  async function readReports(now: number): Promise<StoredReport[]> {
    const keys = await kv.list(REPORT_KEY_PREFIX);
    const values: unknown[] = [];
    for (const key of keys) values.push(await kv.get<unknown>(key));
    const live = liveReports(values, now);
    const liveKeys = new Set(live.map((report) => keyFor(report.windowId)));
    for (const key of keys) {
      if (!liveKeys.has(key)) await kv.delete(key);
    }
    return live;
  }

  let published: PanesSummary | null = null;

  /** Tell every page when the union changes, and only then. */
  function publish(reports: readonly StoredReport[]): PanesSummary {
    const summary = summarize(reports);
    if (published === null || !sameSummary(published, summary)) {
      published = summary;
      bb.realtime.publish(PANES_CHANNEL, summary);
      bb.log.debug(
        `Panes: ${summary.openThreadIds.length} open thread(s) across ${summary.windows} window(s); owner ${summary.ownerWindowId ?? "none"}.`,
      );
    }
    return summary;
  }

  bb.rpc.register(rpcContract, {
    reportPanes(report) {
      return serial(async () => {
        const now = Date.now();
        const { paneReportTtlSeconds } = await settings.get();
        const ttlMs = clampTtlSeconds(paneReportTtlSeconds) * 1000;
        const stored: StoredReport = {
          ...report,
          reportedAt: now,
          expiresAt: now + ttlMs,
        };
        await kv.set(keyFor(report.windowId), stored);
        publish(await readReports(now));
        return { expiresAt: stored.expiresAt };
      });
    },
    forgetWindow({ windowId }) {
      return serial(async () => {
        await kv.delete(keyFor(windowId));
        bb.log.info(`Window ${windowId} closed.`);
        publish(await readReports(Date.now()));
        return null;
      });
    },
    getPanes() {
      return serial(async () => summarize(await readReports(Date.now())));
    },
    openInPane({ threadId }) {
      return serial(async () => {
        const owner = paneOwner(await readReports(Date.now()));
        if (owner === null) {
          bb.log.info(`Open ${threadId} in a pane: no window can take a split.`);
          return { windowId: null };
        }
        bb.realtime.publish(OPEN_CHANNEL, { windowId: owner, threadId });
        bb.log.info(`Open ${threadId} in a pane: asked window ${owner}.`);
        return { windowId: owner };
      });
    },
  });

  // A window that vanishes without a forgetWindow (a crash, a killed tab)
  // only drops out when its report expires, and nothing else would notice.
  // This wakes up at the earliest expiry and republishes if the union moved.
  bb.background.service("expiry-sweep", {
    async start(signal) {
      while (!signal.aborted) {
        const now = Date.now();
        const reports = await serial(async () => {
          const live = await readReports(now);
          publish(live);
          return live;
        });
        const nextExpiry = reports.reduce(
          (soonest, report) => Math.min(soonest, report.expiresAt),
          Number.POSITIVE_INFINITY,
        );
        const wait = Number.isFinite(nextExpiry)
          ? Math.min(60_000, Math.max(1_000, nextExpiry - Date.now() + 100))
          : 60_000;
        await sleep(wait, signal);
      }
    },
  });
}
