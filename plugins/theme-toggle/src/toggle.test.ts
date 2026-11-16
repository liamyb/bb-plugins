import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTheme, themeSetting } from "./toggle.ts";

test("from the first theme it goes to the second", () => {
  assert.equal(nextTheme("sandbar", "sandbar", "mixtape"), "mixtape");
});

test("from the second theme it goes back to the first", () => {
  assert.equal(nextTheme("mixtape", "sandbar", "mixtape"), "sandbar");
});

test("from any other theme it goes to the second", () => {
  assert.equal(nextTheme("default", "sandbar", "mixtape"), "mixtape");
  assert.equal(nextTheme("plugin:aura:dusk", "sandbar", "mixtape"), "mixtape");
});

test("twice from anywhere lands on the first", () => {
  const once = nextTheme("nord", "sandbar", "mixtape");
  assert.equal(nextTheme(once, "sandbar", "mixtape"), "sandbar");
});

test("blank or missing settings fall back to the defaults", () => {
  assert.equal(themeSetting(undefined, "sandbar"), "sandbar");
  assert.equal(themeSetting("   ", "sandbar"), "sandbar");
  assert.equal(themeSetting(42, "mixtape"), "mixtape");
  assert.equal(themeSetting("  gruvbox ", "sandbar"), "gruvbox");
});
