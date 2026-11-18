import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTheme, themeCycle, themeSetting } from "./toggle.ts";

const two = themeCycle("sandbar", "mixtape");
const three = themeCycle("sandbar", "mixtape", "palm-noir");

test("with two themes, from the first it goes to the second", () => {
  assert.equal(nextTheme("sandbar", two), "mixtape");
});

test("with two themes, from the second it goes back to the first", () => {
  assert.equal(nextTheme("mixtape", two), "sandbar");
});

test("from any other theme it goes to the second", () => {
  assert.equal(nextTheme("default", two), "mixtape");
  assert.equal(nextTheme("plugin:aura:dusk", three), "mixtape");
});

test("with two themes, twice from anywhere lands on the first", () => {
  assert.equal(nextTheme(nextTheme("nord", two), two), "sandbar");
});

test("with a third theme it goes round all three in order", () => {
  assert.equal(nextTheme("sandbar", three), "mixtape");
  assert.equal(nextTheme("mixtape", three), "palm-noir");
  assert.equal(nextTheme("palm-noir", three), "sandbar");
});

test("a blank third leaves the two-theme flip", () => {
  assert.deepEqual(themeCycle("sandbar", "mixtape", "  "), ["sandbar", "mixtape"]);
  assert.deepEqual(themeCycle("sandbar", "mixtape", ""), two);
});

test("a theme named twice counts once", () => {
  assert.deepEqual(themeCycle("sandbar", "mixtape", "sandbar"), ["sandbar", "mixtape"]);
  assert.equal(nextTheme("sandbar", themeCycle("sandbar", "sandbar")), "sandbar");
});

test("blank or missing settings fall back to the defaults", () => {
  assert.equal(themeSetting(undefined, "sandbar"), "sandbar");
  assert.equal(themeSetting("   ", "sandbar"), "sandbar");
  assert.equal(themeSetting(42, "mixtape"), "mixtape");
  assert.equal(themeSetting("  gruvbox ", "sandbar"), "gruvbox");
});
