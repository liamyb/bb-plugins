/**
 * Ask the desk's popup: a request typed in Switchboard goes to today's front
 * desk as your own message, while you stay in the chat you're working in.
 *
 * The message is sent with `queue-if-active`, so an idle desk starts a turn on
 * it straight away and a busy one picks it up when it finishes what it's
 * doing, rather than having it steered into the middle of another ask.
 * Pasted or dropped files are uploaded to the desk's project first, the way
 * bb's own composer does, and go with the text as attachments.
 *
 * Pure, so it can be tested without bb.
 */

/** A file uploaded for the message: what `projects.attachments.upload` returns. */
export interface DeskAttachment {
  type: "localImage" | "localFile";
  path: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  sourceProjectId?: string;
}

/** One part of the message, in the shape `threads.send` takes. */
export type DeskInput =
  | { type: "text"; text: string; mentions: [] }
  | { type: "localImage"; path: string; sourceProjectId?: string }
  | {
      type: "localFile";
      path: string;
      name: string;
      mimeType?: string;
      sizeBytes: number;
      sourceProjectId?: string;
    };

/** The message for the desk: the text, then each attachment in the order added. */
export function deskInput(text: string, attachments: readonly DeskAttachment[]): DeskInput[] {
  const parts: DeskInput[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) parts.push({ type: "text", text: trimmed, mentions: [] });
  for (const attachment of attachments) {
    const source = attachment.sourceProjectId === undefined ? {} : { sourceProjectId: attachment.sourceProjectId };
    if (attachment.type === "localImage") {
      parts.push({ type: "localImage", path: attachment.path, ...source });
    } else {
      parts.push({
        type: "localFile",
        path: attachment.path,
        name: attachment.name,
        ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
        sizeBytes: attachment.sizeBytes,
        ...source,
      });
    }
  }
  return parts;
}

/** Whether there's something to send and nothing still uploading or broken. */
export function canSendToDesk(
  text: string,
  files: readonly { status: "uploading" | "ready" | "failed" }[],
): boolean {
  if (files.some((file) => file.status !== "ready")) return false;
  return text.trim().length > 0 || files.length > 0;
}

/** Why Send is off, for its tooltip; null when it's on. */
export function sendBlocker(
  text: string,
  files: readonly { status: "uploading" | "ready" | "failed" }[],
): string | null {
  if (files.some((file) => file.status === "uploading")) return "Waiting for the upload to finish";
  if (files.some((file) => file.status === "failed")) return "Remove the file that didn't upload";
  if (text.trim().length === 0 && files.length === 0) return "Type what the desk should pick up";
  return null;
}

/** The toast after a send. */
export function sentNote(delivery: "sent" | "queued", deskTitle: string): { title: string; description?: string } {
  return delivery === "queued"
    ? { title: `Queued for ${deskTitle}`, description: "It's busy, so it'll pick this up when it finishes." }
    : { title: `Sent to ${deskTitle}` };
}
