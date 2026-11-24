// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { canSendToDesk, deskInput, sendBlocker, sentNote, type DeskAttachment } from "./ask.ts";

const image: DeskAttachment = {
  type: "localImage",
  path: "attachments/image-1.png",
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  sourceProjectId: "proj_a",
};
const pdf: DeskAttachment = {
  type: "localFile",
  path: "attachments/notes.pdf",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 9000,
};

test("the message is the trimmed text, then each attachment in order", () => {
  assert.deepEqual(deskInput("  Can you check the report?\n\nThanks  ", [image, pdf]), [
    { type: "text", text: "Can you check the report?\n\nThanks", mentions: [] },
    { type: "localImage", path: "attachments/image-1.png", sourceProjectId: "proj_a" },
    { type: "localFile", path: "attachments/notes.pdf", name: "notes.pdf", mimeType: "application/pdf", sizeBytes: 9000 },
  ]);
  // A screenshot on its own is a message too; blank text adds no empty part.
  assert.deepEqual(deskInput("   ", [image]), [
    { type: "localImage", path: "attachments/image-1.png", sourceProjectId: "proj_a" },
  ]);
  assert.deepEqual(deskInput("", []), []);
});

test("Send waits for text or a file, and for every upload to finish", () => {
  const ready = { status: "ready" } as const;
  const uploading = { status: "uploading" } as const;
  const failed = { status: "failed" } as const;
  assert.equal(canSendToDesk("Look at this", []), true);
  assert.equal(canSendToDesk("", [ready]), true);
  assert.equal(canSendToDesk("  \n ", []), false);
  assert.equal(canSendToDesk("Look at this", [ready, uploading]), false);
  assert.equal(canSendToDesk("Look at this", [failed]), false);
  assert.equal(sendBlocker("Look at this", [uploading]), "Waiting for the upload to finish");
  assert.equal(sendBlocker("Look at this", [failed]), "Remove the file that didn't upload");
  assert.equal(sendBlocker("", []), "Type what the desk should pick up");
  assert.equal(sendBlocker("Look at this", [ready]), null);
});

test("the toast says whether the desk started on it or queued it", () => {
  assert.deepEqual(sentNote("sent", "Front desk, 24 Nov"), { title: "Sent to Front desk, 24 Nov" });
  assert.deepEqual(sentNote("queued", "Front desk, 24 Nov"), {
    title: "Queued for Front desk, 24 Nov",
    description: "It's busy, so it'll pick this up when it finishes.",
  });
});
