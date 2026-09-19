/**
 * What a discovery agent is allowed to say.
 *
 * The vocabulary is the artifact's own, so a recorded decision needs no
 * translation to become a step. That only holds if what the model is taught and
 * what we accept are the same shape, which is what the last test is for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_TOOLS, AgentActionSchema, checkAgainstSchema } from "@icap/core";

const click = {
  kind: "click",
  why: "Open the member's detail screen",
  target: {
    kind: "ax",
    role: "link",
    name: { template: "View", match: "equals" },
    scope: { kind: "row", containingText: "100005" },
    framePath: ["content"],
  },
  expect: { kind: "ax", role: "heading", name: { template: "Member #", match: "contains" } },
};

test("an action in the artifact's own vocabulary parses", () => {
  const parsed = AgentActionSchema.parse(click);
  assert.equal(parsed.kind, "click");
});

test("a locator the artifact schema would refuse is refused here too", () => {
  const bad = { ...click, target: { ...click.target, role: "hyperlink" } };
  assert.equal(AgentActionSchema.safeParse(bad).success, false);
});

test("an action must say why, since that is what becomes the step's intent", () => {
  assert.equal(AgentActionSchema.safeParse({ ...click, why: "" }).success, false);
});

test("reading a value names the output it fills", () => {
  const parsed = AgentActionSchema.parse({
    kind: "read",
    why: "The savings balance is in the Balance column",
    as: "savings_balance",
    target: { kind: "ax", role: "cell", framePath: ["content"] },
  });
  assert.equal(parsed.kind === "read" && parsed.as, "savings_balance");
});

test("every action kind has a tool the model can call", () => {
  const kinds = ["click", "type", "select", "press", "navigate", "read", "done", "abandon"];
  assert.deepEqual(
    ACTION_TOOLS.map((tool) => tool.name).sort(),
    [...kinds].sort(),
  );
});

test("a tool tells the model what the action is for", () => {
  for (const tool of ACTION_TOOLS) {
    assert.ok(tool.description.length > 20, `${tool.name} has no useful description`);
  }
});

// The tool schema is what the model is shown; the Zod schema is what we accept.
// They are written separately, so a canonical example has to satisfy both — or
// the model is being taught a shape we would turn around and reject.
test("each tool's schema accepts the example its Zod counterpart accepts", () => {
  const examples: Record<string, unknown> = {
    click,
    type: { kind: "type", why: "Enter the member number", value: "100005", target: click.target },
    select: { kind: "select", why: "Pick the branch", value: "Downtown", target: click.target },
    press: { kind: "press", why: "Submit with the keyboard", key: "Enter" },
    navigate: { kind: "navigate", why: "Go to the search screen", path: "/search" },
    read: { kind: "read", why: "Read the balance", as: "savings_balance", target: click.target },
    done: { kind: "done", why: "Every declared output has been read", summary: "Read the balance" },
    abandon: { kind: "abandon", why: "There is no search control", reason: "dead end" },
  };

  for (const tool of ACTION_TOOLS) {
    const example = examples[tool.name];
    assert.ok(example, `no example for ${tool.name}`);
    assert.equal(
      AgentActionSchema.safeParse(example).success,
      true,
      `zod refused the ${tool.name} example`,
    );
    const check = checkAgainstSchema(tool.inputSchema, example);
    assert.equal(check.ok, true, `${tool.name}: ${check.errors.join(" | ")}`);
  }
});

test("the tool schema refuses what the artifact schema refuses, so drift shows up here", () => {
  const clickTool = ACTION_TOOLS.find((tool) => tool.name === "click");
  assert.ok(clickTool);
  const check = checkAgainstSchema(clickTool.inputSchema, {
    ...click,
    target: { ...click.target, role: "hyperlink" },
  });
  assert.equal(check.ok, false, "the model would have been told an invalid role is fine");
});

/* ── what a model actually writes ────────────────────────────────────────── */

// Observed from a real run: the intent was right every time and the shape was
// wrong every time. Where a deviation is unambiguous, normalising it costs one
// function here and saves a correction round trip on every single turn.

test("a name given as a plain string is taken as the text to match", () => {
  const parsed = AgentActionSchema.parse({
    kind: "click",
    why: "Open the Member Search screen",
    target: { kind: "ax", role: "link", name: "Member Search", framePath: ["nav"] },
  });
  assert.ok(parsed.kind === "click" && parsed.target.kind === "ax");
  assert.deepEqual(parsed.target.name, { template: "Member Search", match: "contains" });
});

test("a text locator given as a plain string is taken the same way", () => {
  const parsed = AgentActionSchema.parse({
    kind: "click",
    why: "Click the notice",
    target: { kind: "text", text: "Continue", framePath: [] },
  });
  assert.ok(parsed.kind === "click" && parsed.target.kind === "text");
  assert.deepEqual(parsed.target.text, { template: "Continue", match: "contains" });
});

test("a frame path put on the action rather than the locator still means the frame", () => {
  const parsed = AgentActionSchema.parse({
    kind: "click",
    why: "Open the Member Search screen",
    target: { kind: "ax", role: "link", name: "Member Search" },
    framePath: ["nav"],
    expect: { kind: "text", text: "Member Search" },
  });
  assert.ok(parsed.kind === "click");
  assert.deepEqual(parsed.target.framePath, ["nav"]);
  assert.deepEqual(parsed.expect?.framePath, ["nav"], "the expectation is in that frame too");
});

test("a frame path the locator states itself wins over one on the action", () => {
  const parsed = AgentActionSchema.parse({
    kind: "click",
    why: "Open the detail screen",
    target: { kind: "ax", role: "link", name: "View", framePath: ["content"] },
    framePath: ["nav"],
  });
  assert.ok(parsed.kind === "click");
  assert.deepEqual(parsed.target.framePath, ["content"]);
});

test("a matcher written out in full is left exactly as written", () => {
  const parsed = AgentActionSchema.parse({
    kind: "click",
    why: "Open it",
    target: { kind: "ax", role: "link", name: { template: "View", match: "equals" }, framePath: [] },
  });
  assert.ok(parsed.kind === "click" && parsed.target.kind === "ax");
  assert.deepEqual(parsed.target.name, { template: "View", match: "equals" });
});

test("normalising does not paper over a role that is not a role", () => {
  const bad = AgentActionSchema.safeParse({
    kind: "click",
    why: "Open it",
    target: { kind: "ax", role: "hyperlink", name: "View" },
  });
  assert.equal(bad.success, false, "a shape fix is not a licence to invent vocabulary");
});

test("a coordinate is available but is the bottom of the ladder, not a shortcut", () => {
  const parsed = AgentActionSchema.parse({
    kind: "click",
    why: "The OK button carries no accessible name",
    target: { kind: "coords", x: 40, y: 12, note: "unlabelled OK button" },
  });
  assert.equal(parsed.kind === "click" && parsed.target.kind, "coords");
});
