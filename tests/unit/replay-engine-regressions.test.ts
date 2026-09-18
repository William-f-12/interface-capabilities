/**
 * Bugs an audit of the engine turned up, each pinned so it cannot come back.
 *
 * Every test here failed before the fix it names, so it is testing the fix and
 * not merely describing the code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, summarize, type Capability, type ReplayResult, type RunBudget } from "@icap/core";
import {
  ScriptedSurface,
  happyPathSurface,
  testCapability,
  testTenant,
} from "../helpers/scripted.js";

const quick = { wallClockMs: 5000, perStepMs: 150, maxRecoveries: 3 };

function run(options: {
  capability?: Capability;
  tenant?: ReturnType<typeof testTenant>;
  surface?: ScriptedSurface;
  inputs?: Record<string, unknown>;
  budget?: Partial<RunBudget>;
}): Promise<ReplayResult> {
  return replay({
    capability: options.capability ?? testCapability(),
    tenant: options.tenant ?? testTenant(),
    inputs: options.inputs ?? { query: "100005" },
    surface: options.surface ?? happyPathSurface(),
    budget: options.budget ?? quick,
    runId: "regression",
  });
}

/* ── a condition is one fact, however many attempts see it ───────────────── */

test("a condition still on screen for a retry is recorded once, not once per attempt", async () => {
  const restricted = {
    code: "RESTRICTED",
    kind: "business_outcome",
    description: "A restriction worth reporting.",
    after: "open",
    onDetect: "continue",
    detect: { kind: "dom", selector: "#restricted" },
  };
  const notice = {
    code: "NOTICE",
    kind: "recoverable",
    description: "A notice over the screen.",
    detect: { kind: "dom", selector: "#notice" },
    recover: { action: "dismiss", target: { primary: { kind: "dom", selector: "#notice-ok" } } },
    maxAttempts: 2,
  };

  // The restriction outlives the notice, so the retry sees it a second time.
  const surface = new ScriptedSurface({
    facts: ["#open", "#restricted", "#notice", "#notice-ok"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #notice-ok") {
        facts.delete("#notice");
        facts.add("#form");
        facts.add("#query");
        facts.add("#submit");
      }
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });

  const result = await run({
    capability: testCapability({ outcomes: [restricted] }),
    tenant: testTenant({ ambientOutcomes: [notice] }),
    surface,
  });

  assert.ok(result.status === "succeeded");
  assert.deepEqual(result.observedOutcomes.map((o) => o.code), ["NOTICE", "RESTRICTED"]);
  assert.equal(result.recoveries.length, 1, "the retry belongs in recoveries, not in outcomes");
});

/* ── the wall clock is a budget, not a suggestion ────────────────────────── */

test("a step's wait cannot carry the run past its wall clock", async () => {
  const began = Date.now();
  const result = await run({
    surface: new ScriptedSurface({ facts: [] }),
    budget: { wallClockMs: 200, perStepMs: 4000, maxRecoveries: 0 },
  });
  const elapsed = Date.now() - began;

  assert.ok(result.status === "failed");
  assert.ok(elapsed < 1500, `the run took ${elapsed}ms against a 200ms budget`);
  assert.equal(result.failure.cause, "BUDGET_EXCEEDED", "and blames the budget, not the control");
});

test("a declared wait is trimmed to what is left rather than overrunning it", async () => {
  const slow = {
    code: "SLOW",
    kind: "recoverable",
    description: "A processing interstitial.",
    detect: { kind: "dom", selector: "#slow" },
    recover: { action: "wait", ms: 30_000 },
    maxAttempts: 3,
  };
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#slow");
    },
  });

  const began = Date.now();
  const result = await run({
    tenant: testTenant({ ambientOutcomes: [slow] }),
    surface,
    budget: { wallClockMs: 400, perStepMs: 100, maxRecoveries: 3 },
  });
  const elapsed = Date.now() - began;

  assert.ok(result.status === "failed");
  assert.ok(elapsed < 2000, `a 30s declared wait ran for ${elapsed}ms against a 400ms budget`);
});

/* ── a missing input is a contract problem, not a dead browser ───────────── */

test("an input that is declared, interpolated and not supplied is refused up front", async () => {
  const capability = testCapability({
    inputs: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { query: { type: "string" } },
    },
  });
  const surface = happyPathSurface();

  const result = await run({ capability, surface, inputs: {} });

  assert.ok(result.status === "failed");
  assert.equal(result.failure.cause, "CONTRACT_VIOLATION");
  assert.match(result.failure.expected, /query/);
  assert.deepEqual(surface.actions, [], "and the browser was never touched");
});

/* ── a step report describes the attempt it reports on ───────────────────── */

test("a step that ends up resolving nothing does not claim an earlier rung", async () => {
  const retry = {
    code: "RETRY_ME",
    kind: "recoverable",
    description: "Something that asks for the step again.",
    detect: { kind: "dom", selector: "#retry-me" },
    recover: { action: "retryStep" },
    maxAttempts: 1,
  };
  // The click consumes the control, so the retry has nothing to resolve.
  const surface = new ScriptedSurface({
    facts: ["#open", "#retry-me"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.delete("#open");
    },
  });

  const result = await run({ tenant: testTenant({ ambientOutcomes: [retry] }), surface });
  const open = result.steps.find((s) => s.stepId === "open");

  assert.equal(open?.status, "failed");
  assert.ok((open?.attempts ?? 0) >= 2, "the step really was taken more than once");
  assert.equal(open?.resolvedBy, null);
  assert.equal(open?.checkpointMet, null);
});

/* ── a value is waited for, like everything else the engine looks for ────── */

test("a value that paints just after its checkpoint is read, not called missing", async () => {
  // The results table lands, so the step is settled; the balance cell in it
  // arrives a poll later.
  const surface = new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    appearOnFind: { "#amount": 2 },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#results").add("#status");
    },
  });

  const result = await run({ surface });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(result.outputs, {
    amount: { amount: "1204.50", currency: "USD" },
    status: "active",
  });
});

test("a value the artifact says may be absent is not waited for", async () => {
  const capability = testCapability({
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { amount: { type: ["object", "null"] }, status: { enum: ["active", "closed"] } },
    },
    steps: [
      {
        id: "open",
        intent: "Open the search screen.",
        action: { type: "click" },
        target: { primary: { kind: "dom", selector: "#open" } },
        checkpoint: { kind: "dom", selector: "#form" },
        extract: [
          {
            to: "amount",
            target: { kind: "dom", selector: "#never" },
            coerce: { as: "Money" },
            onCoerceFailure: "null",
          },
          { to: "status", target: { kind: "dom", selector: "#status" }, coerce: { as: "string" } },
        ],
      },
    ],
  });
  const surface = new ScriptedSurface({
    facts: ["#open"],
    text: { "#status": "active" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#status");
    },
  });

  const began = Date.now();
  const result = await run({ capability, surface, budget: { ...quick, perStepMs: 3000 } });
  const elapsed = Date.now() - began;

  assert.ok(result.status === "succeeded", summarize(result));
  assert.equal(result.outputs.amount, null);
  assert.ok(elapsed < 1000, `a tolerated absence cost ${elapsed}ms of waiting`);
});

/* ── evidenceRef names a directory only once one exists ──────────────────── */

test("a run that wrote no evidence says so rather than naming a path", async () => {
  const result = await run({});
  assert.ok(result.status === "succeeded");
  assert.equal(result.evidenceRef, null);
});

/* ── a tenant patch that cannot apply is refused, never dropped ──────────── */

test("an insertion naming a step the capability lacks is refused, not skipped", async () => {
  const tenant = testTenant({
    stepInsertions: [
      {
        capabilityId: "demo.lookup",
        beforeStepId: "no_such_step",
        step: {
          id: "branch",
          intent: "Choose the branch this tenant requires.",
          action: { type: "select", value: "Downtown" },
          target: { primary: { kind: "dom", selector: "#branch" } },
        },
      },
    ],
  });

  const result = await run({ tenant });
  assert.ok(result.status === "failed");
  assert.equal(result.failure.cause, "CONTRACT_VIOLATION");
  assert.match(result.failure.expected, /no_such_step/);
});

test("an override naming a step the capability lacks is refused too", async () => {
  const tenant = testTenant({
    targetOverrides: { "demo.lookup#gone": { primary: { kind: "dom", selector: "#x" } } },
  });

  const result = await run({ tenant });
  assert.ok(result.status === "failed");
  assert.equal(result.failure.cause, "CONTRACT_VIOLATION");
  assert.match(result.failure.expected, /gone/);
});

test("a patch aimed at another capability is none of this run's business", async () => {
  const tenant = testTenant({
    targetOverrides: { "other.capability#whatever": { primary: { kind: "dom", selector: "#x" } } },
  });
  const result = await run({ tenant });
  assert.ok(result.status === "succeeded");
});
