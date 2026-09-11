import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeRegExp, render, toMatchOption } from "@icap/core";

const ctx = { inputs: { member_id: "100005", q: "a.b*c" } };

test("render substitutes a declared input", () => {
  assert.equal(render("Member #{{inputs.member_id}}", ctx), "Member #100005");
});

test("render handles repeats and surrounding whitespace in the placeholder", () => {
  assert.equal(render("{{ inputs.member_id }}/{{inputs.member_id}}", ctx), "100005/100005");
});

test("render leaves a string with no placeholders alone", () => {
  assert.equal(render("Member Search", ctx), "Member Search");
});

test("render fails loudly when the input was not supplied", () => {
  assert.throws(() => render("{{inputs.missing}}", ctx), /was not supplied/);
});

test("equals asks for an exact match", () => {
  const option = toMatchOption({ template: "Search", match: "equals" }, ctx);
  assert.equal(option.value, "Search");
  assert.equal(option.exact, true);
});

test("contains asks for a substring match", () => {
  const option = toMatchOption({ template: "Member ID", match: "contains" }, ctx);
  assert.equal(option.value, "Member ID");
  assert.equal(option.exact, false);
});

test("an interpolated value is a plain string, never a pattern", () => {
  const option = toMatchOption({ template: "{{inputs.q}}", match: "contains" }, ctx);
  assert.equal(option.value, "a.b*c");
});

test("startsWith anchors the pattern and escapes the interpolated value", () => {
  const option = toMatchOption({ template: "{{inputs.q}}", match: "startsWith" }, ctx);
  assert.ok(option.value instanceof RegExp);
  const pattern = option.value as RegExp;
  assert.ok(pattern.test("a.b*c and more"));
  assert.equal(pattern.test("axbxc"), false, "unescaped metacharacters would match this");
});

test("a pattern matcher keeps its flags", () => {
  const option = toMatchOption({ pattern: "no members? found", flags: "i" }, ctx);
  const pattern = option.value as RegExp;
  assert.ok(pattern.test("No members found for that search."));
  assert.ok(pattern.test("no member found"));
});

test("escapeRegExp neutralises every metacharacter it claims to", () => {
  const raw = ".*+?^${}()|[]\\";
  assert.ok(new RegExp(`^${escapeRegExp(raw)}$`).test(raw));
});
