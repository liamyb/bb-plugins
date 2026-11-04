/**
 * The side panel shows the documents of the chat in the slide, as bb's panel
 * shows the thread you're in. Switchboard has one panel for every chat, so a
 * chat's documents are the ones its thread has open in bb's own panel (read
 * from bb's saved panel state) and the ones opened while it was in the slide
 * (a link in the chat, or an agent's file that came over). Moving to another
 * chat with the panel open closes the last chat's tabs and opens this one's,
 * or closes the panel when it has none; opening the panel on a chat shows its
 * documents. With no chat in the slide (the list), nothing is moved.
 *
 * Pure, so it can be tested without bb. Tabs are matched by bb's tab key,
 * files by path.
 */

/** A file Switchboard can reopen in its panel. */
export type FileTarget =
  | { kind: "workspace"; environmentId: string; path: string }
  | { kind: "thread-storage"; threadId: string; path: string };

/** A document tab in the panel: bb's key, the file's path and, when known, how to reopen it. */
export interface FileTab {
  key: string;
  path: string;
  target?: FileTarget | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A file source as bb writes it (`{kind: "workspace", environmentId}` or thread storage), as a target. */
function targetFromSource(path: unknown, source: unknown): FileTarget | null {
  if (typeof path !== "string" || path.length === 0 || !isRecord(source)) return null;
  if (source.kind === "workspace" && typeof source.environmentId === "string") {
    return { kind: "workspace", environmentId: source.environmentId, path };
  }
  if (source.kind === "thread-storage" && typeof source.threadId === "string") {
    return { kind: "thread-storage", threadId: source.threadId, path };
  }
  return null;
}

/**
 * The document a panel tab shows, from what the plugin SDK says about it: a
 * file tab (`detail.kind` "file"), or a file opener's plugin tab, such as the
 * PDF viewer's, whose params carry the file's path and source. Null for
 * anything else (a browser page, a terminal, bb's info tab).
 */
export function documentTab(
  key: string,
  detail: unknown,
  fallback: { threadId: string | null; environmentId: string | undefined },
): FileTab | null {
  if (!isRecord(detail)) return null;
  if (detail.kind === "file" && typeof detail.path === "string") {
    const tab = { key, path: detail.path };
    return {
      ...tab,
      target:
        fallback.threadId === null
          ? null
          : fileTarget(tab, { threadId: fallback.threadId, environmentId: fallback.environmentId }),
    };
  }
  if (detail.kind === "plugin" && isRecord(detail.params)) {
    const target = targetFromSource(detail.params.path, detail.params.source);
    if (target !== null) return { key, path: target.path, target };
  }
  return null;
}

/**
 * The documents a thread has in bb's own side panel, from bb's saved panel
 * state (localStorage `bb.thread.fixedPanelTabsState-<thread>-1`): file
 * previews and file openers' tabs, oldest first. Not part of the plugin SDK,
 * so anything unexpected reads as none.
 */
export function threadPanelKey(threadId: string): string {
  return `bb.thread.fixedPanelTabsState-${threadId}-1`;
}

export function threadPanelFiles(raw: string | null, threadId: string): FileTarget[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(value) || !isRecord(value.secondary) || !Array.isArray(value.secondary.tabs)) return [];
  const files: FileTarget[] = [];
  for (const tab of value.secondary.tabs) {
    if (!isRecord(tab)) continue;
    let target: FileTarget | null = null;
    if (tab.kind === "workspace-file-preview" && typeof tab.environmentId === "string") {
      target = targetFromSource(tab.path, { kind: "workspace", environmentId: tab.environmentId });
    } else if (tab.kind === "thread-storage-file-preview") {
      const owner = typeof tab.threadId === "string" ? tab.threadId : threadId;
      target = targetFromSource(tab.path, { kind: "thread-storage", threadId: owner });
    } else if (tab.kind === "plugin-panel" && typeof tab.paramsJson === "string") {
      try {
        const params: unknown = JSON.parse(tab.paramsJson);
        if (isRecord(params)) target = targetFromSource(params.path, params.source);
      } catch {
        target = null;
      }
    }
    if (target !== null && !files.some((file) => file.path === target.path)) files.push(target);
  }
  return files;
}

/** What Switchboard remembers about the panel's files, per chat. */
export interface PanelMemory {
  /** Each chat's files, oldest first. */
  files: Record<string, FileTarget[]>;
  /** The chat each open tab belongs to ("" for none), and its path, by tab key. */
  owners: Record<string, { view: string; path: string }>;
  /** Chats whose panel you hid: moving back to them leaves it closed. */
  closed: string[];
}

export const EMPTY_MEMORY: PanelMemory = { files: {}, owners: {}, closed: [] };

/**
 * The file a tab shows, as a target Switchboard can reopen, or null for a
 * tab it can't (a browser page, a terminal, a host file). bb's file tabs
 * carry the source and scope in their key: `workspace-file-preview:<path>:
 * <environment>`, `thread-storage-file-preview:<path>:<thread>`. Not part of
 * the plugin SDK, so the chat's own environment or thread is the fallback.
 */
export function fileTarget(
  tab: FileTab,
  fallback: { threadId: string; environmentId: string | undefined },
): FileTarget | null {
  const scope = tab.key.slice(tab.key.lastIndexOf(":") + 1);
  if (tab.key.startsWith("workspace-file-preview:")) {
    const environmentId = /^env_[a-z0-9]+$/.test(scope) ? scope : fallback.environmentId;
    return environmentId === undefined ? null : { kind: "workspace", environmentId, path: tab.path };
  }
  if (tab.key.startsWith("thread-storage-file-preview:")) {
    const threadId = /^thr_[a-z0-9]+$/.test(scope) ? scope : fallback.threadId;
    return { kind: "thread-storage", threadId, path: tab.path };
  }
  return null;
}

function withFile(list: readonly FileTarget[] | undefined, file: FileTarget): FileTarget[] {
  const rest = (list ?? []).filter((item) => item.path !== file.path);
  return [...rest, file];
}

/**
 * Takes note of tabs that appeared: each belongs to the agent's thread when
 * it's the file that agent just opened, or else to the chat in the slide.
 * Tabs there before Switchboard started watching (`legacy`) belong to no chat
 * and aren't remembered, so they're closed the first time a chat's panel is
 * shown. Returns the same object when nothing changed.
 */
export function recordTabs(
  memory: PanelMemory,
  tabs: readonly FileTab[],
  input: {
    view: string | null;
    agent: { threadId: string; path: string } | null;
    legacy: boolean;
    targetFor: (tab: FileTab, owner: string) => FileTarget | null;
  },
): PanelMemory {
  let next = memory;
  for (const tab of tabs) {
    if (next.owners[tab.key] !== undefined) continue;
    const owner =
      input.agent !== null && input.agent.path === tab.path
        ? input.agent.threadId
        : input.legacy
          ? ""
          : (input.view ?? "");
    next = { ...next, owners: { ...next.owners, [tab.key]: { view: owner, path: tab.path } } };
    if (owner === "") continue;
    const target = tab.target ?? input.targetFor(tab, owner);
    if (target === null) continue;
    next = {
      ...next,
      files: { ...next.files, [owner]: withFile(next.files[owner], target) },
      closed: next.closed.filter((id) => id !== owner),
    };
  }
  return next;
}

/**
 * Takes note of tabs that went. One Switchboard closed itself (`closedByUs`)
 * is still remembered for its chat; one you closed is forgotten.
 */
export function forgetTabs(
  memory: PanelMemory,
  tabs: readonly FileTab[],
  closedByUs: ReadonlySet<string>,
): PanelMemory {
  const open = new Set(tabs.map((tab) => tab.key));
  const gone = Object.keys(memory.owners).filter((key) => !open.has(key));
  if (gone.length === 0) return memory;
  const owners = { ...memory.owners };
  const files = { ...memory.files };
  for (const key of gone) {
    const owner = owners[key];
    delete owners[key];
    if (closedByUs.has(key) || owner === undefined || owner.view === "") continue;
    const kept = (files[owner.view] ?? []).filter((file) => file.path !== owner.path);
    if (kept.length === 0) delete files[owner.view];
    else files[owner.view] = kept;
  }
  return { ...memory, owners, files };
}

/** You hid the panel on a chat (true) or showed it again (false). */
export function setClosed(memory: PanelMemory, view: string, closed: boolean): PanelMemory {
  const has = memory.closed.includes(view);
  if (has === closed) return memory;
  return {
    ...memory,
    closed: closed ? [...memory.closed, view] : memory.closed.filter((id) => id !== view),
  };
}

/**
 * What moving the panel to a chat takes: the tabs to close (another chat's,
 * or no chat's, apart from an agent's file whose bar is still up), the
 * chat's documents to open (its thread's in bb, then the ones opened for it
 * here), and whether the panel's then empty. Nothing for the list.
 */
export function planSync(input: {
  view: string | null;
  tabs: readonly FileTab[];
  memory: PanelMemory;
  /** An agent's thread whose file came over and whose bar is still showing. */
  keep: string | null;
  /** The documents the chat's thread has open in bb's own panel. */
  threadFiles?: readonly FileTarget[];
}): { close: string[]; open: FileTarget[]; closePanel: boolean } {
  if (input.view === null) return { close: [], open: [], closePanel: false };
  const view = input.view;
  const close = input.tabs
    .filter((tab) => {
      const owner = input.memory.owners[tab.key];
      if (owner === undefined) return false;
      return owner.view !== view && owner.view !== input.keep;
    })
    .map((tab) => tab.key);
  const staying = input.tabs.filter((tab) => !close.includes(tab.key));
  const wanted: FileTarget[] = [];
  for (const file of [...(input.threadFiles ?? []), ...(input.memory.files[view] ?? [])]) {
    if (!wanted.some((item) => item.path === file.path)) wanted.push(file);
  }
  const open = wanted.filter((file) => !staying.some((tab) => tab.path === file.path));
  return { close, open, closePanel: staying.length + open.length === 0 };
}

/** A memory as saved to sessionStorage, or empty when it isn't one. */
export function parseMemory(value: unknown): PanelMemory {
  if (typeof value !== "object" || value === null) return EMPTY_MEMORY;
  const record = value as Record<string, unknown>;
  const files: Record<string, FileTarget[]> = {};
  if (typeof record.files === "object" && record.files !== null) {
    for (const [view, list] of Object.entries(record.files as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter(isTarget);
      if (kept.length > 0) files[view] = kept;
    }
  }
  const owners: Record<string, { view: string; path: string }> = {};
  if (typeof record.owners === "object" && record.owners !== null) {
    for (const [key, owner] of Object.entries(record.owners as Record<string, unknown>)) {
      if (typeof owner !== "object" || owner === null) continue;
      const { view, path } = owner as Record<string, unknown>;
      if (typeof view === "string" && typeof path === "string") owners[key] = { view, path };
    }
  }
  const closed = Array.isArray(record.closed)
    ? record.closed.filter((id): id is string => typeof id === "string")
    : [];
  return { files, owners, closed };
}

function isTarget(value: unknown): value is FileTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  if (typeof target.path !== "string" || target.path.length === 0) return false;
  if (target.kind === "workspace") return typeof target.environmentId === "string";
  if (target.kind === "thread-storage") return typeof target.threadId === "string";
  return false;
}
