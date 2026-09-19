/**
 * The phase's pass criterion: what a model recorded, the engine replays.
 *
 * The artifact under test was produced by a live discovery run against this
 * fixture and checked in under `evidence/discovery/`. Nothing here adapts the
 * engine to it — the engine is the one from the previous phase, unchanged, and
 * the only thing done to the artifact is the approval a person owes it.
 *
 * The second member is the part that matters. An artifact that replays for the
 * record it was recorded against has proved almost nothing; the claim being
 * made is that a flow was recorded, not that a session was.
 *
 *   npm run target              # in another terminal
 *   npm run test:integration
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilitySchema,
  replay,
  summarize,
  tenantSignIn,
  type Capability,
  type TenantConfig,
} from "@icap/core";
import { WebSurface } from "@icap/core/web";
import { loadTenant } from "../helpers/artifacts.js";
import { repoRoot } from "../helpers/paths.js";

const DISCOVERED = join(
  repoRoot,
  "evidence",
  "discovery",
  "2026-09-19-member.lookup_savings_balance",
  "artifact.json",
);

const tenant: TenantConfig = loadTenant();

process.env["NORTHSTAR_TELLER_USER"] ??= "teller";
process.env["NORTHSTAR_TELLER_PASSWORD"] ??= "teller-pw";

function discovered(): Capability {
  return CapabilitySchema.parse(JSON.parse(readFileSync(DISCOVERED, "utf8")));
}

/** What a reviewer does after reading it: nothing to the flow, only the verdict. */
function approved(): Capability {
  return CapabilitySchema.parse({
    ...discovered(),
    approval: "approved",
    provenance: {
      ...discovered().provenance,
      source: "llm_discovery+human_edit",
      humanEdits: [
        {
          at: "2026-09-19T00:00:00.000Z",
          by: "review",
          note: "Read and approved. The recorded flow is unchanged.",
        },
      ],
    },
  });
}

let surface: WebSurface;

before(async () => {
  surface = await WebSurface.launch({
    baseUrl: tenant.baseUrl,
    headless: process.env["SURFACE_HEADED"] !== "1",
  });
  const session = await tenantSignIn(surface, tenant, { timeoutMs: 15_000 })("teller");
  assert.ok(session.ok, session.ok ? "" : session.reason);
});

after(async () => {
  await surface?.close();
});

function run(capability: Capability, memberId: string) {
  return replay({
    capability,
    tenant,
    inputs: { member_id: memberId },
    surface,
    budget: { wallClockMs: 60_000, perStepMs: 10_000, maxRecoveries: 3 },
  });
}

test("what the model recorded carries its own provenance", () => {
  const artifact = discovered();
  assert.equal(artifact.provenance.source, "llm_discovery");
  assert.equal(artifact.provenance.model, "deepseek-flash");
  assert.ok(artifact.steps.length >= 4, "a real flow, not a stub");
  assert.match(artifact.provenance.traceRef ?? "", /^discovery\//);
});

test("a draft is refused by the engine, so approval is an act and not a formality", async () => {
  const result = await run(discovered(), "100005");
  assert.equal(result.status, "failed");
  assert.ok(result.status === "failed");
  assert.match(result.failure.expected, /approved/);
  assert.match(result.failure.message, /draft/);
  assert.deepEqual(
    result.steps.map((step) => step.status),
    result.steps.map(() => "skipped"),
    "and nothing was done to the application on the way to refusing",
  );
});

test("the unchanged engine replays what the model recorded", async () => {
  const result = await run(approved(), "100005");
  assert.ok(result.status === "succeeded", summarize(result));
  assert.equal(result.decisionSource, "artifact", "no model took part in any of this");

  assert.equal(result.outputs["member_name"], "Priya Raman");
  assert.deepEqual(result.outputs["savings_balance"], { amount: "45000.00", currency: "USD" });
  assert.equal(result.outputs["account_status"], "active");
});

test("and replays it for a member it was never recorded against", async () => {
  // The whole claim. A flow was recorded, not a session.
  const result = await run(approved(), "100001");
  assert.ok(result.status === "succeeded", summarize(result));

  assert.equal(result.outputs["member_name"], "Margaret Chen");
  assert.equal(result.outputs["account_status"], "active");
  const balance = result.outputs["savings_balance"] as { amount: string; currency: string };
  assert.equal(balance.currency, "USD");
  assert.match(balance.amount, /^\d+\.\d{2}$/);
  assert.notEqual(balance.amount, "45000.00", "it read this member's balance, not the other one's");
});

test("every step it recorded resolved on the real screens", async () => {
  const result = await run(approved(), "100001");
  assert.ok(result.status === "succeeded");
  for (const step of result.steps) {
    assert.equal(step.status, "ok", `${step.stepId} did not run`);
    assert.equal(step.resolvedBy?.rung, "primary", `${step.stepId} needed a fallback`);
  }
});

test("the outputs agree with the hand-written artifact for the same member", async () => {
  // Same contract, two independent implementations of the flow. If they
  // disagree, one of them is reading the wrong cell.
  const byHand = CapabilitySchema.parse(
    JSON.parse(
      readFileSync(
        join(repoRoot, "capabilities", "member.lookup_savings_balance", "v1.json"),
        "utf8",
      ),
    ),
  );

  const recorded = await run(approved(), "100001");
  const handwritten = await run(byHand, "100001");
  assert.ok(recorded.status === "succeeded" && handwritten.status === "succeeded");
  assert.deepEqual(recorded.outputs, handwritten.outputs);
});
