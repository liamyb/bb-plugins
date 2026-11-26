/**
 * Open in browser: what the side panel's tab you're on opens as in your web
 * browser. A web page opens at its address. A file opens through bb's own
 * server, at the address bb's panel reads it from, so the browser shows it as
 * it is: a web page, a PDF or a picture as itself, Markdown and other text
 * as plain text. A terminal, bb's new-tab page or a file outside a checkout
 * or a thread's storage has nothing to open, so there's no button.
 *
 * Pure, so it can be tested without bb.
 */
import { documentTab, type FileTarget } from "./panelfiles.ts";

/** What the button opens: a web page, or a file served by bb. `url` is absolute. */
export interface BrowserTarget {
  kind: "page" | "file";
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * bb's address for a file, relative to its server: a checkout's file under
 * `/api/v1/environments/<id>/files/`, a thread's storage under
 * `/api/v1/threads/<id>/thread-storage/files/`, each part of the path
 * encoded the way bb encodes it. Null for a path bb wouldn't serve (empty,
 * absolute, or stepping up out of its folder).
 */
export function fileUrl(target: FileTarget): string | null {
  const { path } = target;
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  const encoded = parts.map(encodeURIComponent).join("/");
  return target.kind === "workspace"
    ? `/api/v1/environments/${encodeURIComponent(target.environmentId)}/files/${encoded}`
    : `/api/v1/threads/${encodeURIComponent(target.threadId)}/thread-storage/files/${encoded}`;
}

/**
 * What a panel tab opens as in the browser, from what the plugin SDK says
 * about it (`key` and `detail`), or null when it has nothing to open. A
 * file's checkout or thread comes from its tab key; the chat in the slide
 * stands in when the key doesn't say. `base` is the page's own address, so
 * a file's address points at the bb server this window uses.
 */
export function browserTarget(
  key: string,
  detail: unknown,
  fallback: { threadId: string | null; environmentId: string | undefined },
  base: string,
): BrowserTarget | null {
  if (!isRecord(detail)) return null;
  if (detail.kind === "browser") {
    if (typeof detail.url !== "string") return null;
    try {
      const url = new URL(detail.url);
      return url.protocol === "http:" || url.protocol === "https:" ? { kind: "page", url: url.href } : null;
    } catch {
      return null;
    }
  }
  // A file tab's target needs a thread to fall back on; a key that names its
  // own checkout or thread never uses it, and one that doesn't can't open.
  const document = documentTab(key, detail, {
    threadId: fallback.threadId ?? "",
    environmentId: fallback.environmentId,
  });
  const target = document?.target ?? null;
  if (target === null) return null;
  if (target.kind === "thread-storage" && target.threadId === "") return null;
  const relative = fileUrl(target);
  if (relative === null) return null;
  try {
    return { kind: "file", url: new URL(relative, base).href };
  } catch {
    return null;
  }
}
