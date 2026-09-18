/**
 * The engine's decisions: what it does with a screen, and how each ending is
 * classified. Nothing here touches a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  replay,
  summarize,
  type Capability,
  type Clock,
  type ReplayResult,
  type RunBudget,
  type SignIn,
  type TenantConfig,
} from "@icap/core";
import {
  ScriptedSurface,
  fastBudget,
  happyPathSurface,
  testCapability,
  testTenant,
} from "../helpers/scripted.js";

interface RunOptions {
  capability?: Capability;
  tenant?: TenantConfig;
  surface?: ScriptedSurface;
  inputs?: Record<string, unknown>;
  budget?: Partial<RunBudget>;
  signIn?: SignIn;
  clock?: Clock;
}

async function run(options: RunOptions = {}): Promise<ReplayResult> {
  return replay({
    capability: options.capability ?? testCapability(),
    tenant: options.tenant ?? testTenant(),
    inputs: options.inputs ?? { query: "100005" },
    surface: options.surface ?? happyPathSurface(),
    budget: options.budget ?? fastBudget,
    runId: "run-1",
    ...(options.signIn ? { signIn: options.signIn } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

const MONEY = { amount: "1204.50", currency: "USD" };

/* ── the happy path ──────────────────────────────────────────────────────── */

test("a flow that lands returns typed outputs, not screen text", async () => {
  const result = await run();
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(result.outputs, { amount: MONEY, status: "active" });
});

test("every step reports how it went", async () => {
  const result = await run();
  assert.deepEqual(
    result.steps.map((s) => [s.stepId, s.status, s.attempts]),
    [
      ["open", "ok", 1],
      ["fill", "ok", 1],
      ["submit", "ok", 1],
    ],
  );
  assert.equal(result.steps[0]?.checkpointMet, true);
  assert.equal(result.steps[1]?.checkpointMet, null, "a step with no checkpoint reports none");
  assert.deepEqual(result.steps[0]?.resolvedBy, { rung: "primary", index: 0, kind: "dom" });
});

test("a template in an action is filled from the caller's inputs", async () => {
  const surface = happyPathSurface();
  await run({ surface, inputs: { query: "424242" } });
  assert.ok(surface.actions.includes("fill #query=424242"), surface.actions.join(" | "));
});

test("no model took part, and the result says so", async () => {
  const result = await run();
  assert.equal(result.decisionSource, "artifact");
});

test("the same inputs produce the same result ten times over", async () => {
  const results: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const result = await run();
    assert.ok(result.status === "succeeded");
    results.push(JSON.stringify(result.outputs));
  }
  assert.equal(new Set(results).size, 1, "replays disagreed");
});

/* ── business outcomes ───────────────────────────────────────────────────── */

const notFound = {
  code: "NOT_FOUND",
  kind: "business_outcome",
  description: "Nothing matched the query. A legitimate answer, not a failure.",
  after: "submit",
  onDetect: "halt",
  detect: { kind: "dom", selector: "#empty" },
};

function emptyResultSurface(): ScriptedSurface {
  return new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#empty");
    },
  });
}

test("a declared business outcome halts the run without failing it", async () => {
  const result = await run({
    capability: testCapability({ outcomes: [notFound] }),
    surface: emptyResultSurface(),
  });
  assert.ok(result.status === "halted", summarize(result));
  assert.equal(result.outcome.code, "NOT_FOUND");
  assert.equal(result.outcome.origin, "capability");
  assert.equal(result.outcome.atStepId, "submit");
  assert.equal(result.outputs, null, "nothing was read, so there are no outputs");
});

test("a halt still says the step that carried it landed", async () => {
  const result = await run({
    capability: testCapability({ outcomes: [notFound] }),
    surface: emptyResultSurface(),
  });
  assert.equal(result.steps.find((s) => s.stepId === "submit")?.status, "ok");
});

test("an outcome that says continue is reported and the flow carries on", async () => {
  const restricted = {
    code: "RESTRICTED",
    kind: "business_outcome",
    description: "The account carries a restriction the caller must surface.",
    after: "submit",
    onDetect: "continue",
    detect: { kind: "dom", selector: "#restricted" },
  };
  const surface = happyPathSurface();
  surface.facts.add("#restricted");

  const result = await run({ capability: testCapability({ outcomes: [restricted] }), surface });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(result.outputs, { amount: MONEY, status: "active" });
  assert.deepEqual(
    result.observedOutcomes.map((o) => o.code),
    ["RESTRICTED"],
  );
});

test("an outcome that says continue does not end the wait for the checkpoint", async () => {
  const restricted = {
    code: "RESTRICTED",
    kind: "business_outcome",
    description: "The account carries a restriction the caller must surface.",
    after: "open",
    onDetect: "continue",
    detect: { kind: "dom", selector: "#restricted" },
  };
  // The banner is painted before the screen it sits on, so the first look finds
  // the condition while the checkpoint is still on its way.
  const surface = new ScriptedSurface({
    facts: ["#open", "#restricted", "#query", "#submit"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    appearOnFind: { "#form": 2 },
    onAction: (entry, facts) => {
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });

  const result = await run({ capability: testCapability({ outcomes: [restricted] }), surface });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.equal(result.steps.find((s) => s.stepId === "open")?.checkpointMet, true);
  assert.deepEqual(
    result.observedOutcomes.map((o) => o.code),
    ["RESTRICTED"],
    "recorded once, not once per poll",
  );
});

/* ── hard failures ───────────────────────────────────────────────────────── */

const appError = {
  code: "APP_ERROR",
  kind: "hard_failure",
  description: "The application returned its unhandled-error screen.",
  detect: { kind: "dom", selector: "#error" },
  maxAttempts: 0,
};

test("a declared hard failure is reported by its code, not as a timeout", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#error");
    },
  });
  const result = await run({ tenant: testTenant({ ambientOutcomes: [appError] }), surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "DECLARED_HARD_FAILURE");
  assert.equal(result.failure.code, "APP_ERROR");
  assert.equal(result.failure.stepId, "open");
});

test("a broken application outranks a business reading of the same screen", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#empty").add("#error");
    },
  });
  const result = await run({
    capability: testCapability({ outcomes: [notFound] }),
    tenant: testTenant({ ambientOutcomes: [appError] }),
    surface,
  });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.code, "APP_ERROR");
  assert.deepEqual(
    result.observedOutcomes.map((o) => o.code).sort(),
    ["APP_ERROR", "NOT_FOUND"],
    "both readings are still recorded",
  );
});

/* ── recovery ────────────────────────────────────────────────────────────── */

const notice = {
  code: "NOTICE",
  kind: "recoverable",
  description: "A start-of-day notice sits over the screen. Dismissing it is safe.",
  detect: { kind: "dom", selector: "#notice" },
  recover: { action: "dismiss", target: { primary: { kind: "dom", selector: "#notice-ok" } } },
  maxAttempts: 2,
};

test("a recoverable condition is cleared and the step is taken again", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open", "#notice", "#notice-ok"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #notice-ok") {
        facts.delete("#notice");
        facts.delete("#notice-ok");
      }
      if (entry === "click #open" && !facts.has("#notice")) {
        facts.add("#form").add("#query").add("#submit");
      }
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });

  const result = await run({ tenant: testTenant({ ambientOutcomes: [notice] }), surface });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(
    result.recoveries.map((r) => [r.outcomeCode, r.action, r.attempt, r.succeeded]),
    [["NOTICE", "dismiss", 1, true]],
  );
  assert.equal(result.steps.find((s) => s.stepId === "open")?.attempts, 2);
});

test("recovering does not change how the run ends, only what it reports", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open", "#notice", "#notice-ok"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #notice-ok") {
        facts.delete("#notice");
        facts.delete("#notice-ok");
      }
      if (entry === "click #open" && !facts.has("#notice")) {
        facts.add("#form").add("#query").add("#submit");
      }
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });
  const result = await run({ tenant: testTenant({ ambientOutcomes: [notice] }), surface });
  assert.ok(result.status === "succeeded");
  assert.equal(result.observedOutcomes[0]?.kind, "recoverable");
});

test("a condition that will not clear is a failure once its attempts run out", async () => {
  const stuck = {
    code: "SLOW",
    kind: "recoverable",
    description: "The screen is behind a processing interstitial.",
    detect: { kind: "dom", selector: "#slow" },
    recover: { action: "wait", ms: 1 },
    maxAttempts: 1,
  };
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#slow");
    },
  });

  const result = await run({ tenant: testTenant({ ambientOutcomes: [stuck] }), surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "RECOVERY_EXHAUSTED");
  assert.equal(result.failure.code, "SLOW");
  assert.equal(result.recoveries.length, 1, "the one permitted attempt was used");
});

test("a recovery that cannot be carried out is reported as such", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#notice");
    },
  });
  const result = await run({ tenant: testTenant({ ambientOutcomes: [notice] }), surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "RECOVERY_EXHAUSTED");
  assert.equal(result.recoveries[0]?.succeeded, false);
  assert.match(result.failure.message, /recovering from it failed/i);
  assert.match(result.failure.message, /#notice-ok/, "and names the control it looked for");
});

test("a dead session is re-established and the flow starts over", async () => {
  const expired = {
    code: "SESSION_EXPIRED",
    kind: "recoverable",
    description: "The session timed out and the browser is back at sign-in.",
    detect: { kind: "dom", selector: "#login" },
    recover: { action: "reauthenticate", restartFromStart: true },
    maxAttempts: 1,
  };

  let submits = 0;
  const surface = new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") {
        submits += 1;
        if (submits === 1) facts.add("#login");
        else facts.add("#results").add("#amount").add("#status");
      }
    },
  });

  const signedInAs: (string | undefined)[] = [];
  const signIn: SignIn = async (role) => {
    signedInAs.push(role);
    surface.facts.delete("#login");
    return { ok: true };
  };

  const result = await run({
    capability: testCapability({ preconditions: { authenticated: true, role: "teller" } }),
    tenant: testTenant({ ambientOutcomes: [expired] }),
    surface,
    signIn,
  });

  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(signedInAs, ["teller", "teller"], "once to start, once to recover");
  assert.equal(result.recoveries[0]?.action, "reauthenticate");
  assert.deepEqual(
    result.steps.map((s) => s.stepId),
    ["open", "fill", "submit", "open", "fill", "submit"],
    "the abandoned pass is still in the record",
  );
  assert.deepEqual(result.outputs, { amount: MONEY, status: "active" });
});

test("an escalation suspends the run and names what a person has to do", async () => {
  const needsSupervisor = {
    code: "NEEDS_SUPERVISOR",
    kind: "recoverable",
    description: "The screen is asking for a supervisor authorisation code.",
    after: "open",
    detect: { kind: "dom", selector: "#auth-code" },
    recover: {
      action: "escalate",
      reason: "A supervisor authorisation code is required to continue.",
      requiredRole: "supervisor",
      resumeFrom: "open",
    },
    maxAttempts: 1,
  };
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit").add("#auth-code");
    },
  });

  const result = await run({
    capability: testCapability({ outcomes: [needsSupervisor] }),
    surface,
  });
  assert.ok(result.status === "suspended", summarize(result));
  assert.equal(result.escalation.requiredRole, "supervisor");
  assert.equal(result.escalation.resumeFrom, "open");
  assert.equal(result.escalation.raisedAtStepId, "open");
  assert.equal(result.escalation.resolution, undefined, "nobody has handed it back yet");
});

/* ── failures ────────────────────────────────────────────────────────────── */

test("a control no rung can find names what was wanted", async () => {
  const result = await run({ surface: new ScriptedSurface({ facts: [] }) });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "TARGET_NOT_FOUND");
  assert.equal(result.failure.stepId, "open");
  assert.match(result.failure.expected, /#open/);
});

test("an action that lands nowhere is a checkpoint failure, not a missing control", async () => {
  const surface = new ScriptedSurface({ facts: ["#open"] });
  const result = await run({ surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "CHECKPOINT_NOT_MET");
  assert.match(result.failure.expected, /#form/);
});

test("a value that will not become its declared type fails with the text it saw", async () => {
  const result = await run({ surface: happyPathSurface({ amount: "pending" }) });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "COERCION_FAILED");
  assert.equal(result.failure.observed, "pending");
  assert.equal(result.failure.stepId, "submit");
});

test("a display value outside the declared map is reported as unmapped", async () => {
  const result = await run({ surface: happyPathSurface({ status: "Dormant" }) });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "UNMAPPED_ENUM_VALUE");
  assert.equal(result.failure.observed, "Dormant");
});

test("a value the artifact says may be missing becomes null instead of failing", async () => {
  const capability = testCapability({
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["amount"],
      properties: {
        amount: {
          type: "object",
          additionalProperties: false,
          required: ["amount", "currency"],
          properties: {
            amount: { type: "string", pattern: "^-?[0-9]+([.][0-9]{1,4})?$" },
            currency: { const: "USD" },
          },
        },
        status: { enum: ["active", "closed", null] },
      },
    },
    steps: testCapability().steps.map((step) =>
      step.id !== "submit"
        ? step
        : {
            ...step,
            extract: step.extract.map((extraction) =>
              extraction.to === "status"
                ? { ...extraction, onCoerceFailure: "null" }
                : extraction,
            ),
          },
    ),
  });

  const result = await run({ capability, surface: happyPathSurface({ status: "Dormant" }) });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(result.outputs, { amount: MONEY, status: null });
});

test("a value the flow never reaches fails at the step that should have read it", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#results");
    },
  });
  const result = await run({ surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "TARGET_NOT_FOUND");
  assert.match(result.failure.expected, /amount/);
});

test("outputs that do not satisfy the published contract fail the run", async () => {
  const capability = testCapability({
    steps: testCapability().steps.map((step) =>
      step.id !== "submit"
        ? step
        : {
            ...step,
            extract: step.extract.map((extraction) =>
              extraction.to === "status"
                ? { ...extraction, coerce: { as: "enum", map: { Active: "ACTIVE" } } }
                : extraction,
            ),
          },
    ),
  });
  const result = await run({ capability });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "CONTRACT_VIOLATION");
  assert.match(result.failure.observed, /status/);
});

test("a run whose final state is not what success looks like fails", async () => {
  const capability = testCapability({
    successCondition: {
      allRequiredOutputsPresent: true,
      finalState: { kind: "dom", selector: "#receipt" },
    },
  });
  const result = await run({ capability });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "CHECKPOINT_NOT_MET");
  assert.equal(result.failure.stepId, null, "the run failed as a whole, not at a step");
});

test("a refused capability never touches the surface", async () => {
  const surface = happyPathSurface();
  const result = await run({ capability: testCapability({ approval: "draft" }), surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "CONTRACT_VIOLATION");
  assert.deepEqual(surface.actions, []);
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["skipped", "skipped", "skipped"],
  );
});

test("the wall-clock budget stops a run that is taking too long", async () => {
  let ticks = 0;
  const base = Date.parse("2026-01-01T00:00:00Z");
  const clock: Clock = {
    now: () => new Date(base + (ticks += 5000)),
    sleep: async () => {},
  };
  const result = await run({ budget: { ...fastBudget, wallClockMs: 1000 }, clock });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "BUDGET_EXCEEDED");
});

test("a surface that dies mid-run is a result, not an exception", async () => {
  const surface = new ScriptedSurface({ facts: ["#open"], breakOn: "click" });
  const result = await run({ surface });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "SURFACE_UNAVAILABLE");
  assert.match(result.failure.observed, /went away/);
});

/* ── sessions ────────────────────────────────────────────────────────────── */

const authenticated = { authenticated: true, role: "teller" };

test("a capability that needs a session gets one before the first step", async () => {
  const calls: (string | undefined)[] = [];
  const signIn: SignIn = async (role) => {
    calls.push(role);
    return { ok: true };
  };
  const result = await run({
    capability: testCapability({ preconditions: authenticated }),
    signIn,
  });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(calls, ["teller"]);
});

test("a session that is already open is not replaced", async () => {
  const surface = happyPathSurface();
  surface.facts.add("#signed-in");
  let called = 0;
  const signIn: SignIn = async () => {
    called += 1;
    return { ok: true };
  };
  await run({ capability: testCapability({ preconditions: authenticated }), surface, signIn });
  assert.equal(called, 0);
});

test("failing to sign in is a precondition failure that says why", async () => {
  const signIn: SignIn = async () => ({ ok: false, reason: "DEMO_PASSWORD is not set" });
  const result = await run({
    capability: testCapability({ preconditions: authenticated }),
    signIn,
  });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "PRECONDITION_FAILED");
  assert.equal(result.failure.observed, "DEMO_PASSWORD is not set");
});

/* ── what the tenant changes ─────────────────────────────────────────────── */

test("a tenant's target override replaces the control the artifact recorded", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open-alt"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #open-alt") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });
  const tenant = testTenant({
    targetOverrides: { "demo.lookup#open": { primary: { kind: "dom", selector: "#open-alt" } } },
  });

  const result = await run({ tenant, surface });
  assert.ok(result.status === "succeeded", summarize(result));
});

test("a tenant's extra step is run in the place the profile puts it", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit").add("#branch");
      if (entry === "click #submit") facts.add("#results").add("#amount").add("#status");
    },
  });
  const tenant = testTenant({
    stepInsertions: [
      {
        capabilityId: "demo.lookup",
        beforeStepId: "fill",
        step: {
          id: "branch",
          intent: "Choose the branch this tenant requires.",
          action: { type: "select", value: "Downtown" },
          target: { primary: { kind: "dom", selector: "#branch" } },
        },
      },
    ],
  });

  const result = await run({ tenant, surface });
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(
    result.steps.map((s) => s.stepId),
    ["open", "branch", "fill", "submit"],
  );
  assert.ok(surface.actions.includes("select #branch=Downtown"));
});
