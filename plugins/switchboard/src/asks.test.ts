// Run with `npm test` (Node's own test runner; Node 23.6+ strips the types).
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerButtons, finalMessage, proseParagraphs, replyAsk } from "./asks.ts";

const ui = (body: string) => "```ui\n" + body + "\n```";

test("buttons with no action are answers; buttons that do something aren't", () => {
  assert.deepEqual(answerButtons('Card("x", [Button("Mark it complete"), Button("Leave it open")])'), [
    "Mark it complete",
    "Leave it open",
  ]);
  assert.deepEqual(answerButtons('Button("Send", variant: "primary"), Button("Hold")'), ["Send", "Hold"]);
  assert.deepEqual(answerButtons('Button("Open", OpenUrl("https://x")), Button("Copy", Copy("y"))'), []);
  assert.deepEqual(answerButtons('Button("Go", [Set($a, 1), Send("go")], variant: "primary")'), []);
});

test("a draft waiting for your send is a go-ahead", () => {
  const vendors =
    "Point 2 commits you to a new limit. If you send this, I'll draft that line to Robin next.\n\n" +
    ui('Card("Reply to Kim", [Button("Send", variant: "primary"), Button("Hold")])');
  assert.equal(replyAsk(vendors), "go-ahead");
  assert.equal(replyAsk('Here\'s the draft.\n\n> Hi Pat, could you check this?\n\nSay "send" and it goes.'), "go-ahead");
  assert.equal(replyAsk('It\'s tested and live. When you\'re happy, say "Push it as 0.2.7".'), "go-ahead");
  // A real reply that was missed until "say" took any word.
  assert.equal(
    replyAsk('I took your "send" as covering the message only. If you\'re happy with the revised draft in my last reply, say "OK" and I\'ll write it in.'),
    "go-ahead",
  );
});

test("a question, a form, a plan or a decision is a question", () => {
  assert.equal(replyAsk("It's moved to your Pip List. Shall I mark it complete?\n\n" + ui('Card("x", [Button("Mark it complete"), Button("Leave it open")])')), "question");
  assert.equal(replyAsk("Two things to settle first.\n\n" + ui('$a = ""\nCard("x", [Form([Choice($a, ["A", "B"], label: "Which?")])])')), "question");
  assert.equal(replyAsk("Here's the plan.\n\n" + ui('Card("x", [Plan([{title: "Do it"}])])')), "question");
  assert.equal(replyAsk("I've looked at both.\n\nWhich one should I build?"), "question");
  assert.equal(replyAsk("Still waiting on you from my last reply: the supplier draft.\n\nOn the new ask, it's done."), "question");
  // A closing list of what's owed.
  assert.equal(replyAsk("Everything is logged.\n\nThree things are still with you:\n- **A:** route it.\n- **B:** share the list."), "question");
  assert.equal(replyAsk("Both options cost the same. It's your call."), "question");
});

test("an update with nothing asked is an update", () => {
  assert.equal(replyAsk("I've sent the reply in your DM. If Kim asks for a PDF, I'll build it."), null);
  assert.equal(
    replyAsk("I won't send the note.\n\n" + ui('Card("Next", [FollowUps(["List everything open", "Draft the columns"])])')),
    null,
  );
  // Mentions of send that don't ask for one: a relay about another thread, and a report.
  assert.equal(replyAsk('It\'ll draft the note for your "send".\n\n' + ui('Threads(["thr_abc"])')), null);
  assert.equal(replyAsk("That thread is also waiting on you for the notes draft, so it's there when you're ready."), null);
  assert.equal(replyAsk('Sent on your "send" at 14:02, and the hub record has it.'), null);
  assert.equal(replyAsk('You said "send" at 14:02, so it went to Robin and Pat.'), null);
  assert.equal(replyAsk(null), null);
  assert.equal(replyAsk(""), null);
});

test("questions in a draft, in quotes, in code or in a link don't count", () => {
  assert.equal(replyAsk("Here's the reply.\n\n> Hi Robin, could you confirm the list size?\n\nIt's in the drafts file."), null);
  assert.equal(replyAsk('Your words: "How can we solve for that?" I\'ve routed it to the Switchboard thread.'), null);
  assert.equal(replyAsk("The endpoint is `events?types=x` and the page is https://example.com/a?b=c now."), null);
  // A question earlier on, then a closing statement: it's been answered in the reply itself.
  assert.equal(replyAsk("Why did it fail?\n\nBecause the token expired. I've renewed it."), null);
});

test("prose comes back without code, drafts or links", () => {
  assert.deepEqual(proseParagraphs("One.\n\n```ui\nCard()\n```\n\n> draft\n\nTwo [link](https://x) `code`."), [
    "One.",
    "Two link .",
  ]);
});

test("the reply is the last agent message of the newest finished turn", () => {
  const rows = [
    { seq: 10, type: "turn/completed", data: {} },
    { seq: 9, type: "item/completed", data: { item: { type: "reasoning" } } },
    { seq: 8, type: "item/completed", data: { item: { type: "agentMessage", text: "Final." } } },
    { seq: 7, type: "item/completed", data: { item: { type: "agentMessage", text: "Working on it." } } },
    { seq: 6, type: "turn/completed", data: {} },
  ];
  assert.equal(finalMessage(rows), "Final.");
  // Out of order, still newest first by seq.
  assert.equal(finalMessage([...rows].reverse()), "Final.");
  // A turn still running: nothing to judge yet.
  assert.equal(finalMessage([{ seq: 11, type: "item/completed", data: { item: { type: "agentMessage", text: "x" } } }, ...rows]), null);
  // The finished turn's message is past what was read.
  assert.equal(finalMessage([{ seq: 10, type: "turn/completed" }, { seq: 9, type: "turn/completed" }]), null);
  assert.equal(finalMessage(null), null);
});
