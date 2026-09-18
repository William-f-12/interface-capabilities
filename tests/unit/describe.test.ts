/**
 * Renderings a failure report is made of.
 *
 * `FailureDetail` promises `expected` reads directly for a person, so these are
 * assertions about English, not about JSON.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeAssertion,
  describeLocator,
  describeTarget,
  type ElementLocator,
  type StateAssertion,
  type TargetSpec,
} from "@icap/core";

const inputs = { member_id: "100005" };

/* ── locators ────────────────────────────────────────────────────────────── */

test("a role and an exact name read as the control a person would point at", () => {
  const locator: ElementLocator = {
    kind: "ax",
    role: "link",
    name: { template: "Member Search", match: "equals" },
    framePath: ["nav"],
  };
  assert.equal(describeLocator(locator), 'link "Member Search" in frame nav');
});

test("a partial match says so, so the reader knows what was compared", () => {
  const locator: ElementLocator = {
    kind: "ax",
    role: "heading",
    name: { template: "Member Search", match: "contains" },
    framePath: [],
  };
  assert.equal(describeLocator(locator), 'heading contains "Member Search"');
});

test("an input is filled in, because the reader wants the value not the template", () => {
  const locator: ElementLocator = {
    kind: "ax",
    role: "heading",
    name: { template: "Member #{{inputs.member_id}}", match: "contains" },
    framePath: ["content"],
  };
  assert.equal(
    describeLocator(locator, inputs),
    'heading contains "Member #100005" in frame content',
  );
});

test("an input nobody supplied stays visible as written rather than throwing", () => {
  const locator: ElementLocator = {
    kind: "text",
    text: { template: "{{inputs.branch}}", match: "equals" },
    framePath: [],
  };
  assert.equal(describeLocator(locator, inputs), 'text "{{inputs.branch}}"');
});

test("a pattern is shown as a pattern, not as prose", () => {
  const locator: ElementLocator = {
    kind: "text",
    text: { pattern: "no members? found", flags: "i" },
    framePath: ["content"],
  };
  assert.equal(describeLocator(locator), "text matching /no members? found/i in frame content");
});

test("the bottom two rungs of the ladder describe themselves honestly", () => {
  assert.equal(
    describeLocator({ kind: "dom", selector: "input[name$='txtMemberId']", framePath: [] }),
    `an element matching "input[name$='txtMemberId']"`,
  );
  assert.equal(
    describeLocator({ kind: "coords", x: 40, y: 12, note: "the unlabelled OK button", framePath: [] }),
    "the point (40, 12) — the unlabelled OK button",
  );
});

/* ── scopes ──────────────────────────────────────────────────────────────── */

test("a row scope says which row, with the input filled in", () => {
  const locator: ElementLocator = {
    kind: "ax",
    role: "link",
    name: { template: "View", match: "equals" },
    scope: { kind: "row", containingText: "{{inputs.member_id}}" },
    framePath: ["content"],
  };
  assert.equal(
    describeLocator(locator, inputs),
    'link "View" in the row containing "100005" in frame content',
  );
});

test("a labelled scope and a table cell each read as a location", () => {
  assert.equal(
    describeLocator({
      kind: "ax",
      role: "cell",
      scope: { kind: "labelled", labelText: "Member Name:" },
      framePath: [],
    }),
    'cell labelled "Member Name:"',
  );
  assert.equal(
    describeLocator({
      kind: "ax",
      role: "cell",
      scope: { kind: "tableCell", rowContaining: "Savings", columnHeader: "Balance" },
      framePath: [],
    }),
    'cell in the "Balance" column of the row containing "Savings"',
  );
});

/* ── targets and assertions ──────────────────────────────────────────────── */

test("a target mentions that a ladder exists without reciting it", () => {
  const target: TargetSpec = {
    primary: { kind: "ax", role: "button", name: { template: "Search", match: "equals" }, framePath: [] },
    fallbacks: [{ kind: "dom", selector: "input[type=image]", framePath: [] }],
  };
  assert.equal(describeTarget(target), 'button "Search", or any of 1 declared fallback(s)');
});

test("a target with nothing to fall back on says only what it wanted", () => {
  const target: TargetSpec = {
    primary: { kind: "dom", selector: "#only", framePath: [] },
    fallbacks: [],
  };
  assert.equal(describeTarget(target), 'an element matching "#only"');
});

test("a compound assertion keeps its shape so a reader can see the alternatives", () => {
  const assertion: StateAssertion = {
    anyOf: [
      { kind: "ax", role: "table", name: { template: "Search Results", match: "contains" }, framePath: ["content"] },
      { kind: "ax", role: "alert", framePath: ["content"] },
    ],
  };
  assert.equal(
    describeAssertion(assertion),
    'any of [table contains "Search Results" in frame content; alert in frame content]',
  );
});

test("an absence reads as an absence", () => {
  const assertion: StateAssertion = { absent: { kind: "dom", selector: "#spinner", framePath: [] } };
  assert.equal(describeAssertion(assertion), 'no an element matching "#spinner"');
});

test("nesting is preserved and inputs are filled at every depth", () => {
  const assertion: StateAssertion = {
    allOf: [
      { kind: "ax", role: "status", framePath: ["content"] },
      {
        anyOf: [
          { kind: "text", text: { template: "Member #{{inputs.member_id}}", match: "contains" }, framePath: [] },
        ],
      },
    ],
  };
  assert.match(describeAssertion(assertion, inputs), /all of \[status in frame content; any of \[/);
  assert.match(describeAssertion(assertion, inputs), /Member #100005/);
});
