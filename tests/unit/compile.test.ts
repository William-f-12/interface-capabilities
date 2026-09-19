/**
 * Turning a walked path into a reusable contract.
 *
 * The risk this file exists to pin down is transcription: an artifact that is
 * the agent's session written out, wrong turns and all. The filter is
 * structural rather than a matter of care — only actions whose predicted state
 * arrived ever reach the compiler, and what it emits is computed, not copied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilitySchema, compileArtifact, type RecordedStep } from "@icap/core";
import { testCapability } from "../helpers/scripted.js";

const options = {
  model: "claude-sonnet-5",
  traceRef: "discovery/2026-09-18-demo.lookup",
  now: new Date("2026-09-18T10:00:00.000Z"),
};

const dom = (selector: string) => ({ kind: "dom" as const, selector, framePath: [] });

function compile(steps: RecordedStep[], inputs: Record<string, unknown> = { query: "100005" }) {
  return compileArtifact(testCapability(), steps, inputs, options);
}

const walked: RecordedStep[] = [
  {
    action: {
      kind: "click",
      why: "Open the search screen",
      target: dom("#open"),
      expect: dom("#form"),
    },
  },
  {
    action: {
      kind: "type",
      why: "Enter the member number",
      value: "100005",
      clearFirst: true,
      target: dom("#query"),
    },
  },
  {
    action: {
      kind: "click",
      why: "Submit the search",
      target: dom("#submit"),
      expect: dom("#results"),
    },
  },
  {
    action: { kind: "read", why: "Read the balance", as: "amount", target: dom("#amount") },
    text: "$1,204.50",
  },
  {
    action: { kind: "read", why: "Read the status", as: "status", target: dom("#status") },
    text: "Active",
  },
];

test("a walked path becomes an artifact the schema accepts", () => {
  const result = compile(walked);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.doesNotThrow(() => CapabilitySchema.parse(result.capability));
  assert.deepEqual(
    result.capability.steps.map((step) => step.action.type),
    ["click", "type", "click"],
    "a read is not a step of its own; it is what a step produced",
  );
});

test("the contract's own steps are ignored, since they are what is being replaced", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  const handwritten = testCapability().steps.map((step) => step.id);
  for (const id of result.capability.steps.map((step) => step.id)) {
    assert.ok(!handwritten.includes(id), `${id} came from the contract, not the run`);
  }
});

test("a value that came from a declared input is a parameter, not a literal", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  const typed = result.capability.steps.find((step) => step.action.type === "type");
  assert.equal(typed?.action.type === "type" && typed.action.value, "{{inputs.query}}");
  assert.doesNotMatch(
    JSON.stringify(result.capability.steps),
    /100005/,
    "no step may still carry the value this run happened to use",
  );
});

test("a parameter is lifted out of where it was used to narrow a search too", () => {
  const result = compile([
    {
      action: {
        kind: "click",
        why: "Open the member",
        target: {
          kind: "ax",
          role: "link",
          name: { template: "View", match: "equals" },
          scope: { kind: "row", containingText: "100005" },
          framePath: ["content"],
        },
        expect: {
          kind: "ax",
          role: "heading",
          name: { template: "Member #100005", match: "contains" },
          framePath: ["content"],
        },
      },
    },
    { action: { kind: "read", why: "Read it", as: "amount", target: dom("#a") }, text: "$1.00" },
    { action: { kind: "read", why: "Read it", as: "status", target: dom("#s") }, text: "Active" },
  ]);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  const json = JSON.stringify(result.capability.steps);
  assert.match(json, /\{\{inputs\.query\}\}/);
  assert.doesNotMatch(json, /100005/, "a row filter and a heading both had it");
});

test("a selector is left alone, because a selector is never interpolated", () => {
  const result = compile([
    {
      action: {
        kind: "click",
        why: "Click the generated control",
        target: dom("#ctl_100005"),
        expect: dom("#form"),
      },
    },
    { action: { kind: "read", why: "Read it", as: "amount", target: dom("#a") }, text: "$1.00" },
    { action: { kind: "read", why: "Read it", as: "status", target: dom("#s") }, text: "Active" },
  ]);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  const step = result.capability.steps[0];
  assert.equal(
    step?.target?.primary.kind === "dom" && step.target.primary.selector,
    "#ctl_100005",
    "parameterising a selector would produce one that matches nothing",
  );
});

test("what the agent expected becomes the step's checkpoint", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  assert.deepEqual(result.capability.steps[0]?.checkpoint, dom("#form"));
  assert.equal(result.capability.steps[1]?.checkpoint, undefined, "it predicted nothing here");
});

test("a read becomes an extraction on the step it followed, typed from the contract", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  const last = result.capability.steps.at(-1);
  assert.deepEqual(last?.extract.map((extraction) => extraction.to), ["amount", "status"]);
  assert.equal(last?.extract[0]?.coerce.as, "Money", "an output shaped like Money is coerced as Money");
  assert.equal(last?.extract[1]?.coerce.as, "enum", "an output declared as an enum is mapped");
});

test("an enum map is built from what was on screen, not from what the contract hoped", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  const status = result.capability.steps.at(-1)?.extract[1];
  assert.equal(status?.coerce.as === "enum" && status.coerce.map["Active"], "active");
  assert.equal(
    status?.coerce.as === "enum" && status.coerce.onUnmapped,
    "hard_failure",
    "a display value this run never saw must fail loudly, not be guessed at",
  );
});

test("consecutive typing into one control is one step, with the last value", () => {
  const result = compile([
    walked[0] as RecordedStep,
    {
      action: { kind: "type", why: "Enter it", value: "1000", clearFirst: true, target: dom("#query") },
    },
    {
      action: { kind: "type", why: "Enter it", value: "100005", clearFirst: true, target: dom("#query") },
    },
    ...walked.slice(2),
  ]);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  const typed = result.capability.steps.filter((step) => step.action.type === "type");
  assert.equal(typed.length, 1);
  assert.equal(typed[0]?.action.type === "type" && typed[0].action.value, "{{inputs.query}}");
});

test("a required output nobody read is a refusal, not an artifact that cannot succeed", () => {
  const result = compile(walked.slice(0, 4));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /status/);
});

test("a value located by quoting itself is refused, however far the run got", () => {
  const result = compile([
    walked[0] as RecordedStep,
    walked[1] as RecordedStep,
    walked[2] as RecordedStep,
    {
      action: {
        kind: "read",
        why: "The balance is the text showing the amount",
        as: "amount",
        target: { kind: "text", text: { template: "$1,204.50", match: "equals" }, framePath: [] },
      },
      text: "$1,204.50",
    },
    walked[4] as RecordedStep,
  ]);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /quoting that value/);
});

test("a locator that describes a shape rather than a value is fine", () => {
  // A pattern says "an amount goes here", which is true of every record.
  const result = compile([
    walked[0] as RecordedStep,
    walked[1] as RecordedStep,
    walked[2] as RecordedStep,
    {
      action: {
        kind: "read",
        why: "The balance cell in the Savings row",
        as: "amount",
        target: {
          kind: "ax",
          role: "cell",
          name: { pattern: "^\\$[0-9,]+\\.[0-9]{2}$", flags: "" },
          scope: { kind: "tableCell", rowContaining: "Savings", columnHeader: "Balance" },
          framePath: ["content"],
        },
      },
      text: "$1,204.50",
    },
    walked[4] as RecordedStep,
  ]);
  assert.ok(result.ok, result.ok ? "" : result.reason);
});

test("a read naming something the contract does not declare is a refusal", () => {
  const result = compile([
    ...walked,
    { action: { kind: "read", why: "Read the branch", as: "branch", target: dom("#b") }, text: "X" },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /branch/);
});

test("a flow that read a value before doing anything is a refusal, not a dropped read", () => {
  const result = compile([walked[3] as RecordedStep, walked[4] as RecordedStep]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /before any step/i);
});

test("the artifact says where it came from and stays a draft until a person approves it", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  assert.equal(result.capability.provenance.source, "llm_discovery");
  assert.equal(result.capability.provenance.model, "claude-sonnet-5");
  assert.equal(result.capability.provenance.traceRef, "discovery/2026-09-18-demo.lookup");
  assert.equal(result.capability.provenance.createdAt, "2026-09-18T10:00:00.000Z");
  assert.equal(result.capability.approval, "draft", "nothing a model wrote is approved by writing it");
});

test("outcomes are not carried over, because this run did not observe any", () => {
  const contract = testCapability({
    outcomes: [
      {
        code: "NOT_FOUND",
        kind: "business_outcome",
        description: "Nothing matched.",
        after: "submit",
        onDetect: "halt",
        detect: { kind: "dom", selector: "#empty" },
      },
    ],
  });
  const result = compileArtifact(contract, walked, { query: "100005" }, options);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.deepEqual(result.capability.outcomes, [], "a binding to steps that no longer exist");
});

test("step ids are legal, unique and say what the step does", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  const ids = result.capability.steps.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
  assert.equal(ids[0], "open_the_search_screen");
});

test("two steps that were described the same way still get distinct ids", () => {
  const result = compile([
    { action: { kind: "click", why: "Go on", target: dom("#open"), expect: dom("#form") } },
    { action: { kind: "click", why: "Go on", target: dom("#submit"), expect: dom("#results") } },
    walked[3] as RecordedStep,
    walked[4] as RecordedStep,
  ]);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.deepEqual(result.capability.steps.map((step) => step.id), ["go_on", "go_on_2"]);
});

test("the intent a reviewer reads is the reason the agent gave at the time", () => {
  const result = compile(walked);
  assert.ok(result.ok);
  assert.equal(result.capability.steps[0]?.intent, "Open the search screen");
});

test("the prose describes the flow, not the record it was recorded against", () => {
  // Observed on a live run: "Submit the member number search to find member
  // 100005" on a capability whose whole point is that the number varies.
  const result = compile([
    { action: { kind: "click", why: "Submit the search for member 100005", target: dom("#open"), expect: dom("#form") } },
    walked[3] as RecordedStep,
    walked[4] as RecordedStep,
  ]);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.equal(result.capability.steps[0]?.intent, "Submit the search for member {{inputs.query}}");
});
