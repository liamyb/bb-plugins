import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EMPTY_MEMORY,
  documentTab,
  fileTarget,
  forgetTabs,
  parseMemory,
  planSync,
  recordTabs,
  setClosed,
  threadPanelFiles,
  threadPanelKey,
  type FileTab,
  type FileTarget,
} from "./panelfiles.ts";

const ENV = "env_abc123";
const tab = (path: string, scope = ENV, kind = "workspace-file-preview"): FileTab => ({
  key: `${kind}:${encodeURIComponent(path)}:${scope}`,
  path,
});
const ws = (path: string): FileTarget => ({ kind: "workspace", environmentId: ENV, path });
const targetFor = (t: FileTab, owner: string) =>
  fileTarget(t, { threadId: owner, environmentId: ENV });

test("a tab's file comes from its key, with the chat as fallback", () => {
  assert.deepEqual(fileTarget(tab("notes/a.md", "env_other1"), { threadId: "thr_a", environmentId: ENV }), {
    kind: "workspace",
    environmentId: "env_other1",
    path: "notes/a.md",
  });
  assert.deepEqual(
    fileTarget(tab("Attachments/x.png", "thr_owner1", "thread-storage-file-preview"), { threadId: "thr_a", environmentId: ENV }),
    { kind: "thread-storage", threadId: "thr_owner1", path: "Attachments/x.png" },
  );
  assert.equal(fileTarget({ key: "browser:https://x", path: "x" }, { threadId: "thr_a", environmentId: ENV }), null);
});

test("new tabs belong to the chat in the slide, or to the agent whose file it is", () => {
  let memory = recordTabs(EMPTY_MEMORY, [tab("a.md")], { view: "thr_a", agent: null, legacy: false, targetFor });
  memory = recordTabs(memory, [tab("a.md"), tab("deck.pdf")], {
    view: "thr_a",
    agent: { threadId: "thr_agent", path: "deck.pdf" },
    legacy: false,
    targetFor,
  });
  assert.deepEqual(memory.files, { thr_a: [ws("a.md")], thr_agent: [ws("deck.pdf")] });
  assert.equal(memory.owners[tab("deck.pdf").key]?.view, "thr_agent");
  // Nothing new: the same object back.
  assert.equal(recordTabs(memory, [tab("a.md")], { view: "thr_b", agent: null, legacy: false, targetFor }), memory);
});

test("tabs from before Switchboard watched belong to no chat and aren't remembered", () => {
  const memory = recordTabs(EMPTY_MEMORY, [tab("old.pdf")], { view: "thr_a", agent: null, legacy: true, targetFor });
  assert.deepEqual(memory.files, {});
  assert.deepEqual(planSync({ view: "thr_a", tabs: [tab("old.pdf")], memory, keep: null }), {
    close: [tab("old.pdf").key],
    open: [],
    closePanel: true,
  });
});

test("moving to another chat swaps the files, and back again", () => {
  let memory = recordTabs(EMPTY_MEMORY, [tab("a.md")], { view: "thr_a", agent: null, legacy: false, targetFor });
  memory = recordTabs(memory, [tab("b.md")], { view: "thr_b", agent: null, legacy: false, targetFor });
  // Showing thr_b with a.md open: a.md closes, b.md is already there.
  assert.deepEqual(planSync({ view: "thr_b", tabs: [tab("a.md"), tab("b.md")], memory, keep: null }), {
    close: [tab("a.md").key],
    open: [],
    closePanel: false,
  });
  // A chat with no files closes the panel.
  assert.deepEqual(planSync({ view: "thr_c", tabs: [tab("b.md")], memory, keep: null }), {
    close: [tab("b.md").key],
    open: [],
    closePanel: true,
  });
  // Closed by Switchboard, still remembered; back on thr_a it reopens.
  memory = forgetTabs(memory, [], new Set([tab("a.md").key, tab("b.md").key]));
  assert.deepEqual(planSync({ view: "thr_a", tabs: [], memory, keep: null }), {
    close: [],
    open: [ws("a.md")],
    closePanel: false,
  });
});

test("an agent's file stays while its bar is up, and the list moves nothing", () => {
  const memory = recordTabs(EMPTY_MEMORY, [tab("deck.pdf")], {
    view: "thr_a",
    agent: { threadId: "thr_agent", path: "deck.pdf" },
    legacy: false,
    targetFor,
  });
  assert.deepEqual(planSync({ view: "thr_a", tabs: [tab("deck.pdf")], memory, keep: "thr_agent" }).close, []);
  assert.deepEqual(planSync({ view: "thr_a", tabs: [tab("deck.pdf")], memory, keep: null }).close, [tab("deck.pdf").key]);
  assert.deepEqual(planSync({ view: null, tabs: [tab("deck.pdf")], memory, keep: null }), {
    close: [],
    open: [],
    closePanel: false,
  });
});

test("a tab you close is forgotten", () => {
  let memory = recordTabs(EMPTY_MEMORY, [tab("a.md")], { view: "thr_a", agent: null, legacy: false, targetFor });
  memory = forgetTabs(memory, [], new Set());
  assert.deepEqual(memory.files, {});
  assert.deepEqual(setClosed(memory, "thr_a", true).closed, ["thr_a"]);
});

test("a PDF viewer's tab counts as a document, with its file from the tab's params", () => {
  const pdf = documentTab(
    "plugin-panel:pdf-preview:x",
    { kind: "plugin", pluginId: "pdf-preview", params: { path: "decks/plan.pdf", source: { kind: "workspace", environmentId: ENV, projectId: null, threadId: null } } },
    { threadId: "thr_a", environmentId: ENV },
  );
  assert.deepEqual(pdf, { key: "plugin-panel:pdf-preview:x", path: "decks/plan.pdf", target: ws("decks/plan.pdf") });
  assert.deepEqual(documentTab(tab("a.md").key, { kind: "file", path: "a.md" }, { threadId: "thr_a", environmentId: ENV })?.target, ws("a.md"));
  assert.equal(documentTab("browser:1", { kind: "browser", url: "https://x" }, { threadId: "thr_a", environmentId: ENV }), null);
  assert.equal(documentTab("info", { kind: "info" }, { threadId: "thr_a", environmentId: ENV }), null);
});

test("a thread's documents in bb's own panel, from bb's saved state", () => {
  const raw = JSON.stringify({
    version: 1,
    secondary: {
      tabs: [
        { id: "plugin-fixed:core:info", kind: "plugin-fixed", pluginId: "core", tabId: "info" },
        { kind: "workspace-file-preview", environmentId: ENV, path: "notes/a.md", id: "w1" },
        {
          kind: "plugin-panel",
          pluginId: "pdf-preview",
          paramsJson: JSON.stringify({ path: "decks/plan.pdf", source: { kind: "workspace", environmentId: ENV } }),
        },
        { kind: "thread-storage-file-preview", path: "report.md" },
        { kind: "workspace-file-preview", environmentId: ENV, path: "notes/a.md" },
      ],
      isOpen: false,
    },
  });
  assert.equal(threadPanelKey("thr_a"), "bb.thread.fixedPanelTabsState-thr_a-1");
  assert.deepEqual(threadPanelFiles(raw, "thr_a"), [
    ws("notes/a.md"),
    ws("decks/plan.pdf"),
    { kind: "thread-storage", threadId: "thr_a", path: "report.md" },
  ]);
  assert.deepEqual(threadPanelFiles("nope", "thr_a"), []);
  assert.deepEqual(threadPanelFiles(null, "thr_a"), []);
});

test("a chat's documents include its thread's own, without doubles", () => {
  const memory = recordTabs(EMPTY_MEMORY, [tab("a.md")], { view: "thr_a", agent: null, legacy: false, targetFor });
  const plan = planSync({ view: "thr_a", tabs: [], memory, keep: null, threadFiles: [ws("deck.pdf"), ws("a.md")] });
  assert.deepEqual(plan.open, [ws("deck.pdf"), ws("a.md")]);
  assert.equal(plan.closePanel, false);
});

test("a saved memory round-trips and junk doesn't", () => {
  const memory = recordTabs(EMPTY_MEMORY, [tab("a.md")], { view: "thr_a", agent: null, legacy: false, targetFor });
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(setClosed(memory, "thr_b", true)))), setClosed(memory, "thr_b", true));
  assert.deepEqual(parseMemory({ files: { thr_a: [{ kind: "nope", path: "x" }] }, owners: { k: 3 }, closed: [1] }), EMPTY_MEMORY);
  assert.deepEqual(parseMemory(null), EMPTY_MEMORY);
});
