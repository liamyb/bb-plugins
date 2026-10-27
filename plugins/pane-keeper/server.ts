// Settings, plus `bb pane-keeper draft`, which hands a New thread prompt to
// the app to open beside the focused pane without sending it. The app side
// is in app.tsx; the shared rules are in src/drafts.ts.
import { randomUUID } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DRAFT_CHANNEL,
  DRAFT_KEY_PREFIX,
  DRAFT_OUTCOMES,
  DRAFT_PROMPT_MAX,
  DRAFT_TTL_MS,
  liveDrafts,
  parseEnvironmentRef,
  type Draft,
  type DraftStatus,
} from "./src/drafts";

const draftSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  prompt: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const rpcContract = defineRpcContract({
  /** Every draft still waiting. Each is handed out once, to whichever page asks first. */
  claimDrafts: {
    input: z.null(),
    output: z.object({ drafts: z.array(draftSchema) }),
  },
  /** What the page did with a draft it claimed. */
  reportDraft: {
    input: z
      .object({
        id: z.string().max(100),
        outcome: z.enum(DRAFT_OUTCOMES),
        detail: z.string().max(500).optional(),
      })
      .strict(),
    output: z.null(),
  },
});

const WAIT_MAX_MS = 60_000;

const STATUS_TEXT: Record<DraftStatus, string> = {
  queued:
    "Queued. No bb window has picked it up yet. It opens when one loads, for the next 10 minutes.",
  claimed: "A bb window picked it up but hasn't said how it went.",
  inserted: "Opened in New thread beside the focused pane, not sent.",
  "already-there": "New thread already held this prompt, so it was left as it was.",
  clipboard:
    "bb couldn't take it into New thread, so it's on the clipboard to paste.",
  failed: "bb couldn't open it in New thread or copy it to the clipboard.",
};

export default function paneKeeper(bb: BbPluginApi): void {
  bb.settings.define({
    notificationClicks: {
      type: "boolean",
      label: "Notification clicks open beside the focused pane",
      description:
        "Needs the Notifications Pro hook from this repo's patches folder. Off: a click opens over the focused pane, as Notifications Pro does on its own.",
      default: true,
    },
    atPaneLimit: {
      type: "select",
      label: "At 8 panes (bb's limit)",
      description:
        "replace-oldest swaps out the pane you used least recently, never the focused one or one Pane Attention has flagged. notice opens nothing and says so.",
      options: ["replace-oldest", "notice"],
      default: "replace-oldest",
    },
    newThreadButton: {
      type: "boolean",
      label: "A plain click on New thread opens beside the focused pane",
      description:
        "With a split showing, a plain click on the sidebar's New thread button opens it beside the focused pane, as Cmd+N does, and a Cmd- or Ctrl-click opens it over the focused pane. That's bb's rule swapped round. Off: bb's own clicks.",
      default: true,
    },
  });

  const kv = bb.storage.kv;

  // Writes and claims run one at a time, so two pages asking at once can't
  // both get the same draft.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  }

  // Where each draft a `--wait` is watching stands. Only those are tracked.
  const statuses = new Map<string, DraftStatus>();
  const watchers = new Map<string, () => void>();
  function setStatus(id: string, status: DraftStatus): void {
    if (!statuses.has(id)) return;
    statuses.set(id, status);
    watchers.get(id)?.();
  }

  async function claimDrafts(): Promise<Draft[]> {
    return serial(async () => {
      const keys = await kv.list(DRAFT_KEY_PREFIX);
      const values: unknown[] = [];
      for (const key of keys) {
        values.push(await kv.get<unknown>(key));
        await kv.delete(key);
      }
      const drafts = liveDrafts(values, Date.now());
      for (const draft of drafts) {
        setStatus(draft.id, "claimed");
        bb.log.info(`Draft ${draft.id} claimed by an app page.`);
      }
      return drafts;
    });
  }

  async function resolveEnvironment(
    projectId: string,
    value: string,
  ): Promise<string> {
    const ref = parseEnvironmentRef(value);
    if (ref.kind === "id") {
      const environment = await bb.sdk.environments
        .get({ environmentId: ref.id })
        .catch(() => null);
      if (environment === null) {
        throw new PluginCliError(`No environment ${ref.id}.`, {
          code: "environment_not_found",
          hint: `Run \`bb environment list --project ${projectId}\` to see this project's environments.`,
        });
      }
      if (environment.projectId !== projectId) {
        throw new PluginCliError(
          `Environment ${ref.id} belongs to another project.`,
          { code: "environment_not_in_project" },
        );
      }
      return environment.id;
    }
    const environments = await bb.sdk.environments.list({ projectId });
    const match = environments.find(
      (environment) =>
        environment.path?.replace(/\/+$/, "") === ref.path &&
        environment.lifecycle.phase === "active",
    );
    if (match === undefined) {
      throw new PluginCliError(
        `No active environment in ${projectId} at ${ref.path}.`,
        {
          code: "environment_not_found",
          hint: "Pass the checkout path exactly as `bb project list --json` gives it, or an environment id.",
        },
      );
    }
    return match.id;
  }

  async function waitFor(
    id: string,
    ms: number,
    signal: AbortSignal | undefined,
  ): Promise<DraftStatus> {
    const settled = () => {
      const status = statuses.get(id) ?? "queued";
      return status !== "queued" && status !== "claimed";
    };
    if (ms > 0 && !settled()) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          watchers.delete(id);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        watchers.set(id, () => {
          if (settled()) finish();
        });
        signal?.addEventListener("abort", finish);
      });
    }
    return statuses.get(id) ?? "queued";
  }

  bb.rpc.register(rpcContract, {
    async claimDrafts() {
      return { drafts: await claimDrafts() };
    },
    reportDraft({ id, outcome, detail }) {
      const note = detail === undefined ? "" : ` (${detail})`;
      const line = `Draft ${id}: ${outcome}${note}.`;
      if (outcome === "failed") bb.log.warn(line);
      else bb.log.info(line);
      setStatus(id, outcome);
      return null;
    },
  });

  bb.cli.register(
    defineCli({
      name: "pane-keeper",
      summary: "Pane Keeper: open a pre-filled, unsent New thread beside the focused pane",
      commands: {
        draft: cliCommand({
          summary:
            "Open New thread beside the focused pane in the bb app, with this prompt typed in and not sent",
          description:
            "The prompt is added to New thread's composer (after anything already typed there) and nothing is sent: you add context, pick the mode and send it yourself. With one pane showing, New thread opens beside it. A draft waits up to 10 minutes for a bb window to load, and one window takes it.",
          options: {
            project: {
              type: "string",
              description:
                "Project id for New thread. Defaults to the invoking thread's project.",
              placeholder: "id",
            },
            // No `stdin: true`: bb's --<name>-stdin takes a single line, and a
            // prompt usually has several.
            prompt: {
              type: "string",
              required: true,
              description: `The prompt to type in, line breaks and all, up to ${DRAFT_PROMPT_MAX.toLocaleString("en-GB")} characters.`,
              placeholder: "text",
            },
            environment: {
              type: "string",
              aliases: ["env", "checkout"],
              description:
                "Environment New thread should reuse: an environment id, or a checkout path as bb thread spawn --environment takes. Omitted: New thread's own choice.",
              placeholder: "id|path",
            },
            wait: {
              type: "duration",
              defaultUnit: "s",
              min: 0,
              max: WAIT_MAX_MS,
              default: 0,
              description:
                "Wait up to this long (max 60s) for a bb window to report back, and say what it did.",
            },
            json: {
              type: "boolean",
              description: "Print { id, status } as JSON.",
            },
          },
          async run({ options }, ctx) {
            const projectId = options.project ?? ctx.projectId;
            if (projectId === undefined) {
              throw new PluginCliError("Which project?", {
                code: "missing_project",
                hint: "Add --project <id>. `bb project list` shows them.",
              });
            }
            const prompt = options.prompt.trim();
            if (prompt.length === 0) {
              throw new PluginCliError("The prompt is empty.", {
                code: "empty_prompt",
              });
            }
            if (prompt.length > DRAFT_PROMPT_MAX) {
              throw new PluginCliError(
                `The prompt is ${prompt.length.toLocaleString("en-GB")} characters, over the ${DRAFT_PROMPT_MAX.toLocaleString("en-GB")} limit.`,
                { code: "prompt_too_long" },
              );
            }
            const project = await bb.sdk.projects
              .get({ projectId })
              .catch(() => null);
            if (project === null) {
              throw new PluginCliError(`No project ${projectId}.`, {
                code: "project_not_found",
                hint: "`bb project list` shows them.",
              });
            }
            const environmentId =
              options.environment === undefined
                ? null
                : await resolveEnvironment(projectId, options.environment);

            const now = Date.now();
            const draft: Draft = {
              id: `draft_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
              projectId,
              environmentId,
              prompt,
              createdAt: now,
              expiresAt: now + DRAFT_TTL_MS,
            };
            // Tracked before it's stored, so a claim can't land unseen.
            if (options.wait > 0) statuses.set(draft.id, "queued");
            await serial(() => kv.set(`${DRAFT_KEY_PREFIX}${draft.id}`, draft));
            bb.log.info(
              `Draft ${draft.id} queued for ${projectId}${environmentId === null ? "" : ` on ${environmentId}`} (${prompt.length} characters).`,
            );
            bb.realtime.publish(DRAFT_CHANNEL, { id: draft.id });

            const status = await waitFor(draft.id, options.wait, ctx.signal);
            statuses.delete(draft.id);
            const stdout = options.json
              ? `${JSON.stringify({ id: draft.id, status })}\n`
              : `${STATUS_TEXT[status]}\n`;
            return { exitCode: 0, stdout };
          },
        }),
      },
    }),
  );
}
