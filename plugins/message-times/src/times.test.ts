// Runs on Node's own test runner (`npm test`), with the machine's time zone.
// The expected strings assume Europe/London, so run with TZ=Europe/London.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyThreadTimes,
  formatDetail,
  formatFull,
  formatShort,
  ingest,
  isSettled,
  parseUserRowId,
  shownAt,
  type RawEvent,
} from "./times.ts";

const at = (iso: string) => new Date(iso).getTime();

function requested(
  seq: number,
  iso: string,
  data: Record<string, unknown> = {},
): RawEvent {
  return {
    seq,
    createdAt: at(iso),
    type: "client/turn/requested",
    scope: { kind: "thread" },
    data: {
      requestId: `creq_${seq}`,
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      target: { kind: "new-turn" },
      input: [{ type: "text", text: "hello" }],
      ...data,
    },
  };
}

function accepted(seq: number, iso: string, requestSeq: number, turnId = "t1"): RawEvent {
  return {
    seq,
    createdAt: at(iso),
    type: "turn/input/accepted",
    scope: { kind: "turn", turnId },
    data: { clientRequestId: `creq_${requestSeq}` },
  };
}

test("parses user row ids, including grouped queued turns", () => {
  assert.deepEqual(parseUserRowId("thr_abc123:user-seed:42"), { threadId: "thr_abc123", seq: 42 });
  assert.deepEqual(parseUserRowId("thr_abc123:user-seed:42-1"), { threadId: "thr_abc123", seq: 42 });
  assert.equal(parseUserRowId("thr_abc123:assistant:kind:assistant"), null);
  assert.equal(parseUserRowId("thr_abc123:op:thread-provisioning:3"), null);
});

test("a normal message shows its request time", () => {
  const times = emptyThreadTimes();
  ingest(times, [
    requested(28, "2026-10-07T09:21:12.488Z"),
    accepted(30, "2026-10-07T09:21:13.402Z", 28),
  ]);
  const entry = times.bySeq.get(28)!;
  assert.equal(entry.mine, true);
  assert.equal(shownAt(entry), at("2026-10-07T09:21:12.488Z"));
  assert.equal(isSettled(entry), true);
  assert.equal(times.maxSeq, 30);
});

test("a steer shows its acceptance time, like bb's own row", () => {
  const times = emptyThreadTimes();
  ingest(times, [
    requested(170, "2026-10-07T09:22:36.993Z", {
      target: { kind: "steer", expectedTurnId: "t18" },
    }),
  ]);
  const pending = times.bySeq.get(170)!;
  assert.equal(isSettled(pending), false);
  assert.equal(shownAt(pending), at("2026-10-07T09:22:36.993Z"));
  ingest(times, [accepted(171, "2026-10-07T09:22:44.025Z", 170, "t18")]);
  const done = times.bySeq.get(170)!;
  assert.equal(isSettled(done), true);
  assert.equal(shownAt(done), at("2026-10-07T09:22:44.025Z"));
  assert.equal(
    formatDetail(done),
    "Wednesday 7 October 2026, 10:22:44\nSent mid-turn at 10:22:36, taken in at 10:22:44",
  );
});

test("a steer that missed its turn falls back to the request time", () => {
  const times = emptyThreadTimes();
  ingest(times, [
    requested(5, "2026-10-07T09:00:00Z", { target: { kind: "steer", expectedTurnId: "t1" } }),
    accepted(9, "2026-10-07T09:00:40Z", 5, "t2"),
  ]);
  assert.equal(shownAt(times.bySeq.get(5)!), at("2026-10-07T09:00:00Z"));
});

test("system notices and relayed thread messages aren't Liam's", () => {
  const times = emptyThreadTimes();
  ingest(times, [
    requested(1, "2026-10-07T09:00:00Z", { initiator: "system", systemMessageKind: "child-completed" }),
    requested(2, "2026-10-07T09:00:00Z", {
      input: [{ type: "text", text: "[bb message from thread:thr_x1] hi" }],
    }),
    requested(3, "2026-10-07T09:00:00Z", { senderThreadId: "thr_x1" }),
    requested(4, "2026-10-07T09:00:00Z", { initiator: "agent" }),
    requested(5, "2026-10-07T09:00:00Z"),
  ]);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((seq) => times.bySeq.get(seq)!.mine),
    [false, false, false, false, true],
  );
});

test("overlapping pages don't double-count", () => {
  const times = emptyThreadTimes();
  const page = [requested(1, "2026-10-07T09:00:00Z"), accepted(2, "2026-10-07T09:00:03Z", 1)];
  assert.equal(ingest(times, page), true);
  assert.equal(ingest(times, page), false);
});

test("short labels: today, yesterday, this week, older, other years", () => {
  const now = at("2026-10-07T15:00:00+01:00"); // Wednesday
  assert.equal(formatShort(at("2026-10-07T14:32:05+01:00"), now), "14:32");
  assert.equal(formatShort(at("2026-10-07T00:05:00+01:00"), now), "00:05");
  assert.equal(formatShort(at("2026-10-06T23:59:00+01:00"), now), "Yesterday 23:59");
  assert.equal(formatShort(at("2026-10-05T09:03:00+01:00"), now), "Mon 09:03");
  assert.equal(formatShort(at("2026-10-01T14:32:00+01:00"), now), "Thu 14:32");
  // Seven days back is the same weekday as today, so it gets the date.
  assert.equal(formatShort(at("2026-09-30T14:32:00+01:00"), now), "Wed 30 Sep, 14:32");
  assert.equal(formatShort(at("2025-12-24T09:00:00Z"), now), "Wed 24 Dec 2025, 09:00");
});

test("labels follow local calendar days across the clock change", () => {
  // Clocks go back at 02:00 BST on Sunday 25 October 2026.
  const now = at("2026-10-26T08:00:00Z"); // Monday 08:00 GMT
  assert.equal(formatShort(at("2026-10-25T23:30:00Z"), now), "Yesterday 23:30");
  assert.equal(formatShort(at("2026-10-24T22:30:00Z"), now), "Sat 23:30");
});

test("full hover text", () => {
  assert.equal(formatFull(at("2026-10-06T14:32:05+01:00")), "Tuesday 6 October 2026, 14:32:05");
  assert.equal(formatFull(at("2026-12-01T09:05:09Z")), "Tuesday 1 December 2026, 09:05:09");
});

test("the hover notes a slow start on a normal message", () => {
  const times = emptyThreadTimes();
  ingest(times, [
    requested(485, "2026-10-06T11:31:43.207Z"),
    accepted(491, "2026-10-06T11:35:00.960Z", 485),
  ]);
  assert.equal(
    formatDetail(times.bySeq.get(485)!),
    "Tuesday 6 October 2026, 12:31:43\nThe agent started on it at 12:35:00",
  );
});
