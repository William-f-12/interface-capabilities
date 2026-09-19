/**
 * What the model is shown, and what it is not shown twice.
 *
 * A discovery loop that re-sends every screen it has seen runs out of context
 * long before it runs out of steps, so only the current screen is given in
 * full. What the earlier turns are compacted into is the whole of the agent's
 * memory — including, deliberately, its own mistakes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARS_PER_TOKEN,
  DiscoveryBudgetSchema,
  observationChars,
  systemPrompt,
  turnPrompt,
  type AgentAction,
  type Observation,
} from "@icap/core";
import { testCapability } from "../helpers/scripted.js";

const budget = DiscoveryBudgetSchema.parse({ maxObservationTokens: 100 });

function screen(tree: string): Observation {
  return {
    url: "http://localhost:4173/",
    title: "Core",
    frames: [{ path: [], url: "http://localhost:4173/", tree }],
    hash: "h",
  };
}

const navigated: AgentAction = { kind: "navigate", why: "Open search", path: "/search" };
const clicked: AgentAction = {
  kind: "click",
  why: "Submit",
  target: { kind: "dom", selector: "#go", framePath: [] },
};

function prompt(options: { turns?: { action: AgentAction | null; result: string }[]; tree?: string }) {
  return turnPrompt({
    goal: "Look up the savings balance",
    contract: testCapability(),
    inputs: { query: "100005" },
    turns: options.turns ?? [],
    observation: screen(options.tree ?? "CURRENT SCREEN"),
    budget,
  });
}

test("a token budget becomes a character budget rather than being passed straight in", () => {
  assert.equal(observationChars(budget), 100 * CHARS_PER_TOKEN);
});

test("the system prompt names the perception channel and the ladder", () => {
  const system = systemPrompt();
  assert.match(system, /accessibility/i);
  assert.match(system, /\bax\b/);
  assert.match(system, /expect/i, "declaring an expectation is the whole mechanism");
});

test("only the current screen is shown in full", () => {
  const text = prompt({ turns: [{ action: navigated, result: "ok" }] });
  assert.match(text, /CURRENT SCREEN/);
  assert.doesNotMatch(text, /"tree"/, "an earlier screen is summarised, never re-sent");
});

test("a turn that went wrong stays visible, because that is the feedback", () => {
  const text = prompt({
    turns: [
      { action: navigated, result: "ok" },
      { action: clicked, result: "expectation did not hold" },
    ],
  });
  assert.match(text, /expectation did not hold/);
  assert.match(text, /navigate/, "and the history is in order, not just the last thing");
});

test("the declared contract is in the prompt, since it is what the run aims at", () => {
  const text = prompt({});
  assert.match(text, /amount/, "the outputs to be read must be named");
  assert.match(text, /100005/, "the input values it may use must be given");
  assert.match(text, /Look up the savings balance/);
});

test("the screen is trimmed to the character budget", () => {
  const text = prompt({ tree: "x".repeat(10_000) });
  assert.ok(text.length < 10_000, `prompt was ${text.length} chars`);
  assert.match(text, /truncated/);
});

test("a first turn says so rather than showing an empty history", () => {
  assert.match(prompt({}), /nothing yet|no actions/i);
});
