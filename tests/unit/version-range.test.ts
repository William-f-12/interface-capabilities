/** Whether the build a tenant runs is one the capability was recorded against. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidRange, isVersion, satisfies } from "@icap/core";

test("the range the repository's own artifact declares behaves as intended", () => {
  const range = ">=2.1.0 <3.0.0";
  assert.equal(satisfies("2.1.0", range), true);
  assert.equal(satisfies("2.9.9", range), true);
  assert.equal(satisfies("2.0.9", range), false, "below the recorded build");
  assert.equal(satisfies("3.0.0", range), false, "the next major is a different product");
});

test("a caret admits the rest of the major", () => {
  assert.equal(satisfies("2.1.0", "^2.1.0"), true);
  assert.equal(satisfies("2.9.9", "^2.1.0"), true);
  assert.equal(satisfies("2.0.9", "^2.1.0"), false);
  assert.equal(satisfies("3.0.0", "^2.1.0"), false);
});

test("a caret below 1.0 admits patches only, since nothing above is compatible", () => {
  assert.equal(satisfies("0.2.9", "^0.2.3"), true);
  assert.equal(satisfies("0.3.0", "^0.2.3"), false);
});

test("a tilde admits the rest of the minor", () => {
  assert.equal(satisfies("2.1.9", "~2.1.0"), true);
  assert.equal(satisfies("2.2.0", "~2.1.0"), false);
});

test("alternatives let one artifact cover two supported majors", () => {
  const range = "^1.4.0 || ^2.0.0";
  assert.equal(satisfies("1.9.0", range), true);
  assert.equal(satisfies("2.3.0", range), true);
  assert.equal(satisfies("3.0.0", range), false);
});

test("a bare version means that version alone", () => {
  assert.equal(satisfies("2.1.0", "2.1.0"), true);
  assert.equal(satisfies("2.1.1", "2.1.0"), false);
});

test("a wildcard accepts any build", () => {
  assert.equal(satisfies("7.0.1", "*"), true);
});

test("a prerelease is compared as its release, which is the documented reading", () => {
  assert.equal(satisfies("2.1.0-rc.1", ">=2.1.0 <3.0.0"), true);
});

test("an unparseable version or range answers false rather than throwing", () => {
  assert.equal(satisfies("two point one", ">=2.1.0"), false);
  assert.equal(satisfies("2.1.0", "somewhere around 2"), false);
});

test("a malformed range is recognised, so it can be refused when the artifact loads", () => {
  assert.equal(isValidRange(">=2.1.0 <3.0.0"), true);
  assert.equal(isValidRange("^0.2.3 || 1.0.0"), true);
  assert.equal(isValidRange("*"), true);
  assert.equal(isValidRange("2.1"), false);
  assert.equal(isValidRange("latest"), false);
});

test("an unfinished range is not a wildcard, so an empty field guards nothing away", () => {
  // "*" says any build on purpose; blank says the author never filled it in.
  // Treated alike, a typo would silently match every version there is.
  for (const range of ["", "   ", "|| 2.1.0", "2.1.0 ||"]) {
    assert.equal(isValidRange(range), false, `accepted ${JSON.stringify(range)}`);
    assert.equal(satisfies("9.9.9", range), false, `matched ${JSON.stringify(range)}`);
  }
});

test("a tenant's build must be a concrete version, never a range", () => {
  assert.equal(isVersion("2.1.0"), true);
  assert.equal(isVersion("2.1.0-rc.1"), true);
  assert.equal(isVersion("2.1"), false);
  assert.equal(isVersion(">=2.1.0"), false);
});
