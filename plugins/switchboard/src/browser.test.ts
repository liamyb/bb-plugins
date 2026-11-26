// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { browserTarget, fileUrl } from "./browser.ts";

const BASE = "http://127.0.0.1:38886/plugins/switchboard/switchboard";
const NO_CHAT = { threadId: null, environmentId: undefined };
const CHAT = { threadId: "thr_chat1", environmentId: "env_chat1" };

test("a web page opens at its own address", () => {
  assert.deepEqual(browserTarget("browser:1", { kind: "browser", url: "https://example.com/report?tab=2#top" }, NO_CHAT, BASE), {
    kind: "page",
    url: "https://example.com/report?tab=2#top",
  });
  // Only web addresses: anything else has no button.
  assert.equal(browserTarget("browser:2", { kind: "browser", url: "about:blank" }, NO_CHAT, BASE), null);
  assert.equal(browserTarget("browser:3", { kind: "browser", url: "javascript:alert(1)" }, NO_CHAT, BASE), null);
  assert.equal(browserTarget("browser:4", { kind: "browser", url: "not a url" }, NO_CHAT, BASE), null);
});

test("a checkout's file opens through bb's server, with each part of its path encoded", () => {
  const key = `workspace-file-preview:${encodeURIComponent("notes/Plan v2 #1.md")}:env_abc123`;
  assert.deepEqual(browserTarget(key, { kind: "file", path: "notes/Plan v2 #1.md" }, NO_CHAT, BASE), {
    kind: "file",
    url: "http://127.0.0.1:38886/api/v1/environments/env_abc123/files/notes/Plan%20v2%20%231.md",
  });
  // A key without its checkout falls back on the chat in the slide's.
  assert.deepEqual(browserTarget("workspace-file-preview:a.html", { kind: "file", path: "a.html" }, CHAT, BASE), {
    kind: "file",
    url: "http://127.0.0.1:38886/api/v1/environments/env_chat1/files/a.html",
  });
  assert.equal(browserTarget("workspace-file-preview:a.html", { kind: "file", path: "a.html" }, NO_CHAT, BASE), null);
});

test("a thread's stored file, and a file a viewer plugin shows, open too", () => {
  const key = `thread-storage-file-preview:${encodeURIComponent("Attachments/shot.png")}:thr_owner1`;
  assert.deepEqual(browserTarget(key, { kind: "file", path: "Attachments/shot.png" }, NO_CHAT, BASE), {
    kind: "file",
    url: "http://127.0.0.1:38886/api/v1/threads/thr_owner1/thread-storage/files/Attachments/shot.png",
  });
  const viewer = {
    kind: "plugin",
    pluginId: "pdf-preview",
    tab: { kind: "action", id: "pdf" },
    params: { path: "docs/brief.pdf", source: { kind: "workspace", environmentId: "env_abc123" } },
  };
  assert.deepEqual(browserTarget("plugin:pdf-preview:1", viewer, NO_CHAT, BASE), {
    kind: "file",
    url: "http://127.0.0.1:38886/api/v1/environments/env_abc123/files/docs/brief.pdf",
  });
});

test("tabs with nothing to open have no button", () => {
  for (const detail of [{ kind: "terminal", terminalId: "t1" }, { kind: "new-tab" }, { kind: "info" }, null, "file"]) {
    assert.equal(browserTarget("x", detail, CHAT, BASE), null);
  }
  // A file outside a checkout or a thread's storage (bb's host files).
  assert.equal(browserTarget("host-file-preview:/etc/hosts:host_1", { kind: "file", path: "/etc/hosts" }, CHAT, BASE), null);
});

test("bb's file address refuses a path that steps out of its folder", () => {
  const at = (path: string) => fileUrl({ kind: "workspace", environmentId: "env_abc123", path });
  assert.equal(at("a/b.md"), "/api/v1/environments/env_abc123/files/a/b.md");
  for (const path of ["", "/abs.md", "a/../b.md", "./a.md", "a//b.md", "a\\b.md"]) assert.equal(at(path), null);
});
