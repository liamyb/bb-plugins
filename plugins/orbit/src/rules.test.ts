// src/rules.ts is a copy of Switchboard's rules. These tests run both over
// the same inputs and fail when they disagree, so a rule changed in one place
// can't be forgotten in the other. They're skipped when Switchboard's source
// isn't beside this folder (an install of Orbit alone).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as mine from "./rules.ts";

const waitingUrl = new URL("../../switchboard/src/waiting.ts", import.meta.url);
const currentUrl = new URL("../../switchboard/src/current.ts", import.meta.url);
const beside = existsSync(fileURLToPath(waitingUrl)) && existsSync(fileURLToPath(currentUrl));
const skip = beside ? false : "Switchboard's source isn't beside this folder";

const turnRequests: unknown[] = [
  { initiator: "user", input: [{ type: "text", text: "Hello" }] },
  { initiator: "user", input: [{ type: "text", text: "[bb automation due:auto_1] Run the sweep" }] },
  { initiator: "user", input: [{ type: "text", text: "  /compact  " }] },
  { initiator: "agent", senderThreadId: "thr_hub", input: [{ type: "text", text: "[bb message from thread:thr_hub]\n\nOver to you" }] },
  { initiator: "agent", senderThreadId: null, input: [{ type: "text", text: "no sender" }] },
  { initiator: "agent", senderThreadId: "thr_hub", input: [{ type: "text", text: "/compact" }] },
  { initiator: "system", systemMessageSubject: { threadId: "thr_kid" }, input: [{ type: "text", text: "Child finished" }] },
  { initiator: "system", systemMessageSubject: null, input: [{ type: "text", text: "Please continue." }] },
  { initiator: "system", systemMessageSubject: null, input: [{ type: "text", text: "Something else" }] },
  { initiator: "system", input: [] },
  { input: [{ type: "image" }, { type: "text", text: "second part" }] },
  {},
  null,
  "text",
];

function facts(extra: Record<string, unknown>): mine.ThreadFacts {
  return {
    id: "thr_a",
    parentThreadId: null,
    status: "idle",
    runtimeStatus: "idle",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 },
    indicator: "none",
    isUnread: false,
    isHidden: false,
    isArchived: false,
    latestAttentionAt: null,
    updatedAt: 0,
    ...extra,
  } as mine.ThreadFacts;
}

const threads: mine.ThreadFacts[] = [
  facts({}),
  facts({ status: "active" }),
  facts({ status: "starting" }),
  facts({ status: "stopping" }),
  facts({ status: "error" }),
  facts({ runtimeStatus: "provisioning" }),
  facts({ runtimeStatus: "host-reconnecting" }),
  facts({ runtimeStatus: "waiting-for-host" }),
  facts({ activity: { workflows: 1, backgroundAgents: 0, backgroundCommands: 0 } }),
  facts({ activity: { workflows: 0, backgroundAgents: 2, backgroundCommands: 0 } }),
  facts({ activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 1 } }),
  facts({ activity: undefined }),
  facts({ hasPendingInteraction: true }),
  facts({ indicator: "waiting-for-input" }),
  facts({ indicator: "queued-failed" }),
  facts({ indicator: "queued-waiting" }),
  facts({ indicator: "plan-mode" }),
];

const ledger = [
  '{"time":"08:25","ask":"Stop the 06:00 notifications","thread":"thr_abc123","via":"","how":"owner"}',
  '{"time":" 09:10 ","ask":"  Spaces round it  ","thread":"thr_def456"}',
  '{"time":"09:30","ask":"No thread yet"}',
  '{"time":"09:40","ask":"A thread id that is not one","thread":"proj_m7g3"}',
  '{"time":"09:50","ask":""}',
  '{"ask":7}',
  "not json",
  "",
  '["a list"]',
].join("\n");

const sections = [
  { id: "sec_desk", name: "Front desk" },
  { id: "sec_a", name: "Alpha" },
  { id: "sec_b", name: " Beta " },
];

function deskThread(id: string, extra: Record<string, unknown>): mine.DeskFacts {
  return {
    id,
    parentThreadId: null,
    sectionId: "sec_desk",
    isHidden: false,
    isArchived: false,
    isPinned: false,
    pinnedAt: null,
    createdAt: 1,
    ...extra,
  } as mine.DeskFacts;
}

const deskCases: mine.DeskFacts[][] = [
  [],
  [deskThread("thr_1", {}), deskThread("thr_2", { createdAt: 5 })],
  [deskThread("thr_1", { isPinned: true, pinnedAt: 3 }), deskThread("thr_2", { createdAt: 9 })],
  [deskThread("thr_1", { isPinned: true, pinnedAt: 3 }), deskThread("thr_2", { isPinned: true, pinnedAt: 8 })],
  [deskThread("thr_1", { isPinned: true, pinnedAt: 3 }), deskThread("thr_2", { isPinned: true, pinnedAt: 3 })],
  [deskThread("thr_1", { isArchived: true }), deskThread("thr_2", { isHidden: true }), deskThread("thr_3", { parentThreadId: "thr_9" })],
  [deskThread("thr_1", { sectionId: "sec_a" }), deskThread("thr_2", { sectionId: null })],
];

test("who started a turn: the copy agrees with Switchboard", { skip }, async () => {
  const theirs = await import(waitingUrl.href);
  for (const data of turnRequests) {
    assert.deepEqual(mine.originOf(data), theirs.originOf(data), JSON.stringify(data));
  }
});

test("working and waiting on you: the copy agrees with Switchboard", { skip }, async () => {
  const theirs = await import(currentUrl.href);
  for (const thread of threads) {
    assert.equal(mine.isBusy(thread), theirs.isBusy(thread), JSON.stringify(thread));
    assert.equal(mine.isWaitingOnUser(thread), theirs.isWaitingOnUser(thread), JSON.stringify(thread));
  }
});

test("the ledger and its folder: the copy agrees with Switchboard", { skip }, async () => {
  const theirs = await import(waitingUrl.href);
  assert.deepEqual(mine.parseLedger(ledger), theirs.parseLedger(ledger));
  for (const date of [new Date(2026, 10, 3, 0, 0, 1), new Date(2026, 0, 31, 23, 59, 59)]) {
    assert.equal(mine.ledgerFileName(date), theirs.ledgerFileName(date));
  }
  const folders: [string, string | null][] = [
    ["automation/front-desk/ledger", "/Users/me/work"],
    ["./automation/ledger//", "/Users/me/work/"],
    ["/abs/ledger/", null],
    ["relative", null],
    ["  ", "/Users/me/work"],
  ];
  for (const [setting, checkout] of folders) {
    assert.equal(mine.ledgerFolder(setting, checkout), theirs.ledgerFolder(setting, checkout), setting);
  }
});

test("sections and the front desk: the copy agrees with Switchboard", { skip }, async () => {
  const theirs = await import(waitingUrl.href);
  for (const setting of ["Front desk", "front desk, beta", "sec_a", "sec_zzz, Alpha", "", "nothing"]) {
    assert.deepEqual([...mine.sectionIdsFor(setting, sections)].sort(), [...theirs.sectionIdsFor(setting, sections)].sort(), setting);
    for (const list of deskCases) {
      assert.equal(mine.findDesk(list, sections, setting), theirs.findDesk(list, sections, setting), `${setting}: ${list.map((t) => t.id)}`);
    }
  }
});

// The copy's own behaviour, pinned where Orbit leans on it, whether or not Switchboard is there.
test("the copy on its own: origins, the ledger and the desk", () => {
  assert.deepEqual(mine.originOf(turnRequests[3]), { kind: "thread", threadId: "thr_hub" });
  assert.deepEqual(mine.originOf(turnRequests[6]), { kind: "child", threadId: "thr_kid" });
  assert.deepEqual(mine.originOf(turnRequests[7]), { kind: "maintenance" });
  assert.deepEqual(mine.originOf(turnRequests[1]), { kind: "automation" });
  assert.deepEqual(mine.parseLedger(ledger), [
    { time: "08:25", ask: "Stop the 06:00 notifications", threadId: "thr_abc123" },
    { time: "09:10", ask: "Spaces round it", threadId: "thr_def456" },
    { time: "09:30", ask: "No thread yet", threadId: null },
    { time: "09:40", ask: "A thread id that is not one", threadId: null },
  ]);
  assert.equal(mine.findDesk(deskCases[3]!, sections, "Front desk"), "thr_2");
  assert.equal(mine.ledgerFolder("automation/ledger", "/work/"), "/work/automation/ledger");
});
