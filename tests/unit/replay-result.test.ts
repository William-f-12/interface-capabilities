import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplayResultSchema, summarize } from "@icap/core";

const NOW = "2026-09-10T12:00:00.000Z";

const common = {
  runId: "run-1",
  capability: { id: "member.lookup_savings_balance", version: "1.0.0" },
  tenantId: "northstar",
  inputs: { member_id: "100005" },
  budget: {},
  startedAt: NOW,
  finishedAt: NOW,
  durationMs: 1200,
  steps: [],
  evidenceRef: "evidence/replay/run-1",
};

const restricted = {
  code: "ACCOUNT_RESTRICTED",
  kind: "business_outcome" as const,
  origin: "capability" as const,
  atStepId: "detail.open",
  observedAt: NOW,
  description: "The account carries a restriction.",
};

test("a success carries its outputs", () => {
  const result = ReplayResultSchema.parse({
    ...common,
    status: "succeeded",
    outputs: { savings_balance: { amount: "45000.00", currency: "USD" } },
  });
  assert.equal(result.status, "succeeded");
  assert.match(summarize(result), /succeeded in 1200ms/);
});

test("budget and decisionSource default rather than having to be written out", () => {
  const result = ReplayResultSchema.parse({ ...common, status: "succeeded", outputs: {} });
  assert.equal(result.decisionSource, "artifact");
  assert.equal(result.budget.maxRecoveries, 3);
});

test("a run can succeed and still report an outcome the caller must know", () => {
  const result = ReplayResultSchema.parse({
    ...common,
    status: "succeeded",
    outputs: { account_status: "restricted" },
    observedOutcomes: [restricted],
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.observedOutcomes[0]?.code, "ACCOUNT_RESTRICTED");
});

test("a business outcome halts without being a failure", () => {
  const result = ReplayResultSchema.parse({
    ...common,
    status: "halted",
    outputs: null,
    outcome: { ...restricted, code: "MEMBER_NOT_FOUND", description: "No such member." },
  });
  assert.equal(result.status, "halted");
  assert.match(summarize(result), /halted: MEMBER_NOT_FOUND/);
  assert.doesNotMatch(summarize(result), /fail/i);
});

test("a suspended run names the role it is waiting on", () => {
  const result = ReplayResultSchema.parse({
    ...common,
    status: "suspended",
    escalation: {
      escalationId: "esc-1",
      reason: "A supervisor authorization code is required.",
      requiredRole: "supervisor",
      raisedAtStepId: "confirm.submit",
      resumeFrom: "confirm.submit",
      raisedAt: NOW,
      sessionRef: "session://run-1",
      contextRef: null,
    },
  });
  assert.match(summarize(result), /suspended awaiting supervisor/);
});

test("a failure names the step, the cause and the message", () => {
  const result = ReplayResultSchema.parse({
    ...common,
    status: "failed",
    failure: {
      cause: "CHECKPOINT_NOT_MET",
      code: null,
      stepId: "detail.open",
      stepIntent: "Open the detail page.",
      expected: 'heading "Member #100005"',
      observed: "search results still on screen",
      message: "the detail screen never appeared",
      snapshotRef: "evidence/replay/run-1/step-4.png",
    },
  });
  assert.match(summarize(result), /failed at detail\.open \(CHECKPOINT_NOT_MET\)/);
});

test("a success without outputs is rejected", () => {
  const parsed = ReplayResultSchema.safeParse({ ...common, status: "succeeded" });
  assert.equal(parsed.success, false);
});

test("an unknown status is rejected", () => {
  const parsed = ReplayResultSchema.safeParse({ ...common, status: "partly", outputs: {} });
  assert.equal(parsed.success, false);
});
