// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCountdown, formatReset, resetLine, summariseUsage, usageLabel, usageTone } from "./usage.ts";

// The shape bb returned on 3 Nov 2026 (GET /api/v1/system/usage-limits).
const LIVE = {
  "claude-code": {
    status: "ok",
    accountEmail: "someone@example.com",
    planLabel: "Max (5x)",
    windows: [
      { label: "Current session", usedPercent: 57, resetsAt: "2026-11-03T20:40:00.025Z", kind: "five-hour" },
      { label: "Weekly limit", usedPercent: 31, resetsAt: "2026-11-06T21:00:00.025Z", kind: "weekly" },
      { label: "Fable", usedPercent: 0, resetsAt: "2026-11-06T21:00:00.000Z", kind: "weekly", model: "fable" },
    ],
  },
  codex: { status: "not_installed" },
};

test("the session and the plan's week, not a model's own week", () => {
  const windows = summariseUsage(LIVE);
  assert.deepEqual(
    windows?.map((window) => [window.key, window.usedPercent]),
    [
      ["session", 57],
      ["week", 31],
    ],
  );
  assert.equal(windows?.[0]?.resetsAt, Date.parse("2026-11-03T20:40:00.025Z"));
});

test("another signed-in provider when Claude Code has no figures", () => {
  const windows = summariseUsage({
    "claude-code": { status: "unauthenticated" },
    codex: { status: "ok", windows: [{ label: "Weekly", usedPercent: 12.6, resetsAt: null }] },
  });
  assert.deepEqual(windows, [{ key: "week", usedPercent: 13, resetsAt: null }]);
});

test("nothing to show without figures", () => {
  assert.equal(summariseUsage(null), null);
  assert.equal(summariseUsage({ "claude-code": { status: "expired" } }), null);
  assert.equal(summariseUsage({ "claude-code": { status: "ok", windows: [] } }), null);
  assert.equal(
    summariseUsage({ "claude-code": { status: "ok", windows: [{ kind: "five-hour", usedPercent: "x" }] } }),
    null,
  );
});

test("amber from 80%, red from 95%", () => {
  assert.equal(usageTone(79), null);
  assert.equal(usageTone(80), "warning");
  assert.equal(usageTone(94), "warning");
  assert.equal(usageTone(95), "bad");
});

test("reset times read as today, this week or a date", () => {
  const now = new Date(2026, 10, 3, 16, 0).getTime(); // Tue 3 Nov, 16:00 local
  assert.equal(formatReset(new Date(2026, 10, 3, 20, 40).getTime(), now), "20:40");
  assert.equal(formatReset(new Date(2026, 10, 6, 21, 0).getTime(), now), "Fri 21:00");
  assert.equal(formatReset(new Date(2026, 10, 12, 9, 5).getTime(), now), "12 Nov");
});

test("the tooltip names both windows and when they reset", () => {
  const now = new Date(2026, 10, 3, 16, 0).getTime();
  const label = usageLabel(
    [
      { key: "session", usedPercent: 57, resetsAt: new Date(2026, 10, 3, 20, 40).getTime() },
      { key: "week", usedPercent: 31, resetsAt: null },
    ],
    now,
  );
  assert.equal(label, "Session 57%, resets 20:40. Week 31%.");
});

test("how long until a reset", () => {
  const now = new Date(2026, 10, 10, 14, 50).getTime();
  const at = (h: number, m: number, d = 10) => new Date(2026, 10, d, h, m).getTime();
  assert.equal(formatCountdown(at(17, 0), now), "in 2h 10m");
  assert.equal(formatCountdown(at(15, 35), now), "in 45m");
  assert.equal(formatCountdown(at(16, 50), now), "in 2h");
  assert.equal(formatCountdown(at(9, 0, 16), now), "in 5d 18h");
  assert.equal(formatCountdown(at(14, 50, 12), now), "in 2d");
  assert.equal(formatCountdown(now + 30_000, now), "any moment now");
  assert.equal(formatCountdown(now - 60_000, now), "any moment now");
});

test("the hover card says when each window resets", () => {
  const now = new Date(2026, 10, 10, 14, 50).getTime(); // Tue 10 Nov, 14:50 local
  assert.deepEqual(
    resetLine({ key: "session", usedPercent: 62, resetsAt: new Date(2026, 10, 10, 17, 0).getTime() }, now),
    { title: "Session 62% used", detail: "Resets at 17:00 (in 2h 10m)" },
  );
  assert.deepEqual(
    resetLine({ key: "week", usedPercent: 21, resetsAt: new Date(2026, 10, 16, 9, 0).getTime() }, now),
    { title: "Week 21% used", detail: "Resets Mon 09:00 (in 5d 18h)" },
  );
  assert.deepEqual(
    resetLine({ key: "week", usedPercent: 21, resetsAt: new Date(2026, 10, 20, 9, 0).getTime() }, now),
    { title: "Week 21% used", detail: "Resets 20 Nov (in 9d 18h)" },
  );
  assert.deepEqual(resetLine({ key: "week", usedPercent: 5, resetsAt: null }, now), {
    title: "Week 5% used",
    detail: "bb doesn't say when it resets",
  });
});
