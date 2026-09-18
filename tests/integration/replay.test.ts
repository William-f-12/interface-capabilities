/**
 * The engine against the real fixture, in a real browser.
 *
 * This is where the phase's claim is either true or not: the hand-written
 * artifact replays deterministically and returns typed outputs, and every
 * declared condition lands in the right one of the four endings.
 *
 *   npm run target              # in another terminal
 *   npm run test:integration    # SURFACE_HEADED=1 to watch it
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  replay,
  summarize,
  tenantSignIn,
  type Capability,
  type ReplayResult,
  type TenantConfig,
} from "@icap/core";
import { WebSurface } from "@icap/core/web";
import { loadCapability, loadTenant } from "../helpers/artifacts.js";

const capability: Capability = loadCapability();
const tenant: TenantConfig = loadTenant();

// The fixture's credentials are published in its own README; a real deployment
// puts real ones in the environment under the same names.
process.env.NORTHSTAR_TELLER_USER ??= "teller";
process.env.NORTHSTAR_TELLER_PASSWORD ??= "teller-pw";
process.env.NORTHSTAR_SUPERVISOR_USER ??= "supervisor";
process.env.NORTHSTAR_SUPERVISOR_PASSWORD ??= "supervisor-pw";

let surface: WebSurface;

function run(memberId: string): Promise<ReplayResult> {
  return replay({
    capability,
    tenant,
    inputs: { member_id: memberId },
    surface,
  });
}

/** Chaos is armed per session, so the cookie decides whose run is disturbed. */
async function armChaos(mode: string, times = "1"): Promise<void> {
  const cookies = await surface.page.context().cookies();
  await fetch(`${tenant.baseUrl}/_chaos?mode=${mode}&times=${times}`, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
  });
}

/**
 * Signs in before arming anything, so the fault lands on the session the run
 * will use rather than on one the engine is about to replace.
 */
async function signIn(): Promise<void> {
  const result = await tenantSignIn(surface, tenant)("teller");
  assert.ok(result.ok, result.ok ? "" : result.reason);
}

before(async () => {
  const probe = await fetch(`${tenant.baseUrl}/login`).catch(() => null);
  if (!probe?.ok) {
    throw new Error(`The fixture is not answering at ${tenant.baseUrl}. Run: npm run target`);
  }
  surface = await WebSurface.launch({
    baseUrl: tenant.baseUrl,
    headless: process.env.SURFACE_HEADED !== "1",
  });
});

after(async () => {
  await surface?.close();
});

/* ── the pass criterion ──────────────────────────────────────────────────── */

test("a run signs itself in and returns typed outputs", async () => {
  const result = await run("100005");
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(result.outputs, {
    member_name: "Priya Raman",
    savings_balance: { amount: "45000.00", currency: "USD" },
    account_status: "active",
  });
  assert.equal(result.decisionSource, "artifact", "no model took part");
});

test("the ladder's top rung answered on every step, and the record says so", async () => {
  const result = await run("100005");
  assert.ok(result.status === "succeeded", summarize(result));
  for (const step of result.steps) {
    assert.equal(step.status, "ok", `${step.stepId} did not land`);
    if (step.resolvedBy) assert.equal(step.resolvedBy.rung, "primary", step.stepId);
  }
});

test("ten consecutive replays agree, down to the last field", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10; i += 1) {
    const result = await run("100005");
    assert.ok(result.status === "succeeded", `run ${i + 1}: ${summarize(result)}`);
    seen.add(JSON.stringify(result.outputs));
  }
  assert.equal(seen.size, 1, `replays disagreed: ${[...seen].join(" vs ")}`);
});

test("a member who does not exist is an answer, not an exception", async () => {
  const result = await run("999999");
  assert.ok(result.status === "halted", summarize(result));
  assert.equal(result.outcome.code, "MEMBER_NOT_FOUND");
  assert.equal(result.outcome.kind, "business_outcome");
  assert.equal(result.outcome.atStepId, "search.submit");
  assert.equal(result.steps.find((s) => s.stepId === "detail.open")?.status, "skipped");
});

/* ── the rest of the taxonomy ────────────────────────────────────────────── */

test("a restriction is reported while the balance is still returned", async () => {
  const result = await run("100002");
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(result.outputs, {
    member_name: "Robert Alvarez",
    savings_balance: { amount: "3205.00", currency: "USD" },
    account_status: "restricted",
  });
  assert.deepEqual(
    result.observedOutcomes.map((o) => o.code),
    ["ACCOUNT_RESTRICTED"],
  );
});

test("a start-of-day notice is dismissed and the run carries on", async () => {
  await signIn();
  await armChaos("notice");

  const result = await run("100005");
  assert.ok(result.status === "succeeded", summarize(result));
  assert.deepEqual(
    result.recoveries.map((r) => [r.outcomeCode, r.action, r.succeeded]),
    [["SYSTEM_NOTICE_INTERSTITIAL", "dismiss", true]],
  );
});

test("a processing interstitial is waited out rather than treated as a failure", async () => {
  await signIn();
  await armChaos("slow_load");

  const result = await run("100005");
  assert.ok(result.status === "succeeded", summarize(result));
  assert.equal(result.recoveries[0]?.outcomeCode, "TRANSIENT_SLOW_LOAD");
  assert.equal(result.recoveries[0]?.action, "wait");
});

test("a timed-out session is re-established and the flow starts over", async () => {
  await signIn();
  await armChaos("session_expired");

  const result = await run("100005");
  assert.ok(result.status === "succeeded", summarize(result));
  assert.equal(result.recoveries[0]?.outcomeCode, "SESSION_EXPIRED");
  assert.equal(result.recoveries[0]?.action, "reauthenticate");

  const firstStep = capability.steps[0]?.id;
  const passes = result.steps.filter((s) => s.stepId === firstStep).length;
  assert.ok(passes >= 2, "the flow should have been taken from the top again");
  assert.deepEqual(result.outputs, {
    member_name: "Priya Raman",
    savings_balance: { amount: "45000.00", currency: "USD" },
    account_status: "active",
  });
});

test("a permission denial halts as a business outcome, not as a crash", async () => {
  await signIn();
  await armChaos("permission_denied");

  const result = await run("100005");
  assert.ok(result.status === "halted", summarize(result));
  assert.equal(result.outcome.code, "PERMISSION_DENIED");
  assert.equal(result.outcome.origin, "ambient");
});

test("an application error fails by its declared code, not as a timeout", async () => {
  await signIn();
  await armChaos("app_error");

  const result = await run("100005");
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "DECLARED_HARD_FAILURE");
  assert.equal(result.failure.code, "APP_ERROR");
});

/* ── contract refusals against the real profile ──────────────────────────── */

test("a caller's malformed input never reaches the browser", async () => {
  const before = await surface.observe();
  const result = await replay({
    capability,
    tenant,
    inputs: { member_id: "not-a-member" },
    surface,
  });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "CONTRACT_VIOLATION");
  assert.equal((await surface.observe()).hash, before.hash, "the screen did not move");
});

test("an artifact recorded for a build this tenant does not run is refused", async () => {
  const result = await replay({
    capability,
    tenant: { ...tenant, appVersion: "3.4.0" },
    inputs: { member_id: "100005" },
    surface,
  });
  assert.ok(result.status === "failed", summarize(result));
  assert.equal(result.failure.cause, "PRECONDITION_FAILED");
});
