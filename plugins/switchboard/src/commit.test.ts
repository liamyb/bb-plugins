import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  branchFromHeader,
  commitFailure,
  commitLabel,
  confirmQuestion,
  isNothingToCommit,
  listedPaths,
  parseStatus,
} from "./commit.ts";

const z = (...entries: string[]) => `${entries.join("\0")}\0`;

test("git status gives the branch and every changed path, new files one by one", () => {
  const output = z(
    "## main...origin/main [ahead 1]",
    " M notes/plan.md",
    "?? notes/new one.md",
    "?? notes/drafts/a.md",
    "A  src/added.ts",
    " D old.md",
  );
  assert.deepEqual(parseStatus(output), {
    branch: "main",
    count: 5,
    paths: ["notes/plan.md", "notes/new one.md", "notes/drafts/a.md", "src/added.ts", "old.md"],
  });
});

test("a rename counts once, and its old path isn't a change of its own", () => {
  const output = z("## main", "R  notes/plan-DROPPED.md", "notes/plan-DRAFT.md", " M readme.md");
  assert.deepEqual(parseStatus(output), {
    branch: "main",
    count: 2,
    paths: ["notes/plan-DROPPED.md", "readme.md"],
  });
});

test("a clean checkout has nothing to commit", () => {
  assert.deepEqual(parseStatus(z("## main")), { branch: "main", count: 0, paths: [] });
  assert.deepEqual(parseStatus(""), { branch: null, count: 0, paths: [] });
});

test("only the first few paths are sent, but all are counted", () => {
  const entries = Array.from({ length: 30 }, (_, index) => `?? file-${index}.md`);
  const changes = parseStatus(z("## main", ...entries), 12);
  assert.equal(changes.count, 30);
  assert.equal(changes.paths.length, 12);
  assert.equal(changes.paths[11], "file-11.md");
});

test("the branch line", () => {
  assert.equal(branchFromHeader("main...origin/main [ahead 1, behind 2]"), "main");
  assert.equal(branchFromHeader("liam/switchboard-commit"), "liam/switchboard-commit");
  assert.equal(branchFromHeader("No commits yet on main"), "main");
  assert.equal(branchFromHeader("HEAD (no branch)"), null);
});

test("what the button and the confirm say", () => {
  assert.equal(commitLabel(1), "Commit 1 change");
  assert.equal(commitLabel(12), "Commit 12 changes");
  const changes = { branch: "main", count: 12, paths: ["a.md", "b.md", "c.md"] };
  assert.equal(confirmQuestion(changes, "workspace"), "Commit 12 changes in workspace on main?");
  assert.equal(confirmQuestion({ ...changes, branch: null }, null), "Commit 12 changes?");
  assert.equal(confirmQuestion({ ...changes, count: 1 }, null), "Commit 1 change on main?");
  assert.deepEqual(listedPaths(changes, 2), { paths: ["a.md", "b.md"], more: 10 });
  assert.deepEqual(listedPaths({ branch: null, count: 1, paths: ["a.md"] }), { paths: ["a.md"], more: 0 });
});

test("a commit that found nothing to commit is told apart from a real failure", () => {
  assert.equal(isNothingToCommit(new Error("No changes to commit")), true);
  assert.equal(isNothingToCommit(Object.assign(new Error("Request failed"), { code: "no_changes" })), true);
  assert.equal(isNothingToCommit(new Error("git commit failed: index.lock exists")), false);
  assert.equal(commitFailure(new Error("\ngit commit failed: index.lock exists\nmore")), "git commit failed: index.lock exists");
  assert.equal(commitFailure("x".repeat(300)).length, 200);
});
