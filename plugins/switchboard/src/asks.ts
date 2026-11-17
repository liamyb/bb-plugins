/**
 * Whether a thread's latest reply asks you something, or only tells you
 * something.
 *
 * Waiting used to call every unread reply to your ask a Reply, so a busy
 * thread that wrote anything made every one of its rows in Today's asks say
 * "Reply", whether or not it needed you. This reads the reply itself, the last
 * agent message before the turn finished, and looks for the ways the
 * workspace's agents ask:
 *
 * - a question: a Form, a Plan or a Decision, buttons with no action (the
 *   label is the answer), or a closing paragraph with a question in it;
 * - a go-ahead: a Send (or Push, Post, Approve) button, or "say "…"" in the
 *   closing paragraphs ("say "send"", "say "OK" and I'll write it in");
 * - the "Still waiting on you from my last reply" line threads open with when
 *   something earlier is still owed, or a closing line that hands things to
 *   you ("Three things are still with you:", "It's your call.").
 *
 * A draft (a blockquote) is left out of the question check, since its
 * questions are for whoever it's going to, and so is anything in quotes,
 * code or a link. Anything else is an update.
 *
 * Pure, so it can be tested without bb.
 */

export type ReplyAsk = "question" | "go-ahead";

/** The event types to read for a thread's latest reply. */
export const FINAL_EVENT_TYPES = ["item/completed", "turn/completed"] as const;

/** How many of those events to read, newest first. */
export const FINAL_EVENT_LIMIT = 16;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The text of the last agent message of the newest finished turn, from a
 * `threads.events.list` response read newest first. Null when the newest
 * event isn't a finished turn (it's still running) or the message isn't
 * among the events read.
 */
export function finalMessage(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const events = rows
    .map(record)
    .filter((row): row is Record<string, unknown> => row !== null)
    .map((row) => ({ row, seq: typeof row.seq === "string" ? Number(row.seq) : row.seq }))
    .filter((entry): entry is { row: Record<string, unknown>; seq: number } =>
      typeof entry.seq === "number" && Number.isFinite(entry.seq),
    )
    .sort((a, b) => b.seq - a.seq)
    .map((entry) => entry.row);
  let finished = false;
  for (const row of events) {
    if (row.type === "turn/completed") {
      if (finished) return null;
      finished = true;
      continue;
    }
    if (!finished) return null;
    const item = record(record(row.data)?.item);
    if (row.type === "item/completed" && item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return null;
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
const GO_LABEL = /^\s*(send|push|post|approve|go ahead)\b/i;
// "say "send"", "say "OK" and I'll…", "say "Push it as 0.2.7"": you're the one to say it.
const SAY_GO = /\bsay\s+["“][^"”\n]{1,60}["”]/i;
const STILL_WAITING = /still waiting on you from my last reply/i;
// A closing line handing things to you: "Three things are still with you:",
// "This one's waiting on you.", "It's your call." A colon or full stop has to
// follow, so a relay ("that thread is waiting on you for the draft") doesn't count.
const WITH_YOU = /\b(still with you|waiting on you|over to you|your call|for you to (decide|choose|pick|approve|confirm))\s*[:.]/i;

/** The first string literal at the start of `text`, and what follows it. */
function leadingString(text: string): { value: string; rest: string } | null {
  const match = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(text);
  if (match === null) return null;
  return { value: match[1]!.slice(1, -1), rest: text.slice(match[0].length) };
}

/** The labels of the buttons in a ui block that have no action: each one is an answer. */
export function answerButtons(block: string): string[] {
  const labels: string[] = [];
  const pattern = /\bButton\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const label = leadingString(block.slice(match.index + match[0].length));
    if (label === null) continue;
    // `)` straight after the label, or only named arguments (variant:, icon:).
    if (/^\s*(\)|,\s*[A-Za-z_]\w*\s*:)/.test(label.rest)) labels.push(label.value);
  }
  return labels;
}

/** Prose with code, links, quoted words and drafts taken out, in paragraphs. */
export function proseParagraphs(text: string): string[] {
  const prose = text
    .replace(FENCE, "\n\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "");
  return prose
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function withoutQuotes(text: string): string {
  return text.replace(/"[^"\n]*"/g, "").replace(/“[^”\n]*”/g, "");
}

/** What a reply asks of you, or null when it only tells you something. */
export function replyAsk(text: string | null): ReplyAsk | null {
  if (text === null || text.trim().length === 0) return null;
  const blocks: string[] = [];
  for (const match of text.matchAll(FENCE)) {
    if (/^\s*ui\b/.test(match[1] ?? "")) blocks.push(match[2] ?? "");
  }
  const buttons = blocks.flatMap(answerButtons);
  const paragraphs = proseParagraphs(text);
  const closing = paragraphs.slice(-2).join("\n\n");
  if (buttons.some((label) => GO_LABEL.test(label)) || SAY_GO.test(closing)) return "go-ahead";
  if (buttons.length > 0) return "question";
  if (blocks.some((block) => /\b(Form|Plan|Decision)\s*\(/.test(block))) return "question";
  if (STILL_WAITING.test(paragraphs.join("\n")) || WITH_YOU.test(closing)) return "question";
  const last = paragraphs.at(-1);
  if (last !== undefined && /\?(?=[\s)*_]|$)/.test(withoutQuotes(last))) return "question";
  return null;
}
