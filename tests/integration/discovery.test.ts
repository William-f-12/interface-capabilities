/**
 * The discovery loop against the real fixture, in a real browser.
 *
 * The model is scripted, so this costs nothing and runs in CI — what is under
 * test is not whether a model can find the flow but whether the vocabulary it
 * is given resolves on real screens, whether an expectation is really checked
 * against them, and whether what comes out compiles into a contract.
 *
 *   npm run target              # in another terminal
 *   npm run test:integration
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  CapabilitySchema,
  compileArtifact,
  discover,
  memoryTrace,
  tenantSignIn,
  type AgentAction,
  type Capability,
  type TenantConfig,
} from "@icap/core";
import { WebSurface } from "@icap/core/web";
import { ScriptedModel } from "../helpers/scripted-model.js";
import { loadCapability, loadTenant } from "../helpers/artifacts.js";

const contract: Capability = loadCapability();
const tenant: TenantConfig = loadTenant();

process.env["NORTHSTAR_TELLER_USER"] ??= "teller";
process.env["NORTHSTAR_TELLER_PASSWORD"] ??= "teller-pw";

const MEMBER = "100005";
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

/** The flow as a model would have to describe it: roles, names and scopes. */
const walk: AgentAction[] = [
  {
    kind: "click",
    why: "Open the Member Search screen",
    target: {
      kind: "ax",
      role: "link",
      name: { template: "Member Search", match: "equals" },
      framePath: ["nav"],
    },
    expect: {
      kind: "ax",
      role: "heading",
      name: { template: "Member Search", match: "contains" },
      framePath: ["content"],
    },
  },
  {
    kind: "type",
    why: "Type the member number into the Member ID field",
    value: MEMBER,
    clearFirst: true,
    target: {
      kind: "ax",
      role: "textbox",
      name: { template: "Member ID", match: "contains" },
      framePath: ["content"],
    },
  },
  {
    kind: "click",
    why: "Submit the search",
    target: {
      kind: "ax",
      role: "button",
      name: { template: "Search", match: "equals" },
      framePath: ["content"],
    },
    expect: {
      kind: "ax",
      role: "table",
      name: { template: "Search Results", match: "contains" },
      framePath: ["content"],
    },
  },
  {
    kind: "click",
    why: "Open the detail page for the matching row",
    target: {
      kind: "ax",
      role: "link",
      name: { template: "View", match: "equals" },
      scope: { kind: "row", containingText: MEMBER },
      framePath: ["content"],
    },
    expect: {
      kind: "ax",
      role: "heading",
      name: { template: `Member #${MEMBER}`, match: "contains" },
      framePath: ["content"],
    },
  },
  {
    kind: "click",
    why: "Switch to the Accounts tab",
    target: {
      kind: "ax",
      role: "link",
      name: { template: "Accounts", match: "equals" },
      framePath: ["content"],
    },
    expect: {
      kind: "ax",
      role: "table",
      name: { template: "Accounts", match: "contains" },
      framePath: ["content"],
    },
  },
  {
    kind: "read",
    why: "The member's name is beside its label",
    as: "member_name",
    target: {
      kind: "ax",
      role: "cell",
      scope: { kind: "labelled", labelText: "Member Name:" },
      framePath: ["content"],
    },
  },
  {
    kind: "read",
    why: "The savings balance is where the Savings row meets the Balance column",
    as: "savings_balance",
    target: {
      kind: "ax",
      role: "cell",
      scope: { kind: "tableCell", rowContaining: "Savings", columnHeader: "Balance" },
      framePath: ["content"],
    },
  },
  {
    kind: "read",
    why: "The account status is in the same row under Status",
    as: "account_status",
    target: {
      kind: "ax",
      role: "cell",
      scope: { kind: "tableCell", rowContaining: "Savings", columnHeader: "Status" },
      framePath: ["content"],
    },
  },
  { kind: "done", why: "Every declared output has been read", summary: "Look up a savings balance" },
];

function run(script: (AgentAction | null)[]) {
  const { events, sink } = memoryTrace();
  return discover({
    contract,
    tenant,
    inputs: { member_id: MEMBER },
    goal: "Look up the savings balance for the member",
    surface,
    model: new ScriptedModel(script),
    budget: { maxSteps: 12, wallClockMs: 60_000, expectMs: 8_000 },
    trace: sink,
    runId: "integration",
  }).then((outcome) => ({ outcome, events }));
}

test("the vocabulary a model is given resolves on the real screens", async () => {
  const { outcome } = await run(walk);

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(
    outcome.steps.map((step) => step.action.kind),
    ["click", "type", "click", "click", "click", "read", "read", "read"],
  );
});

test("what was read off the real screen is what the contract will be typed from", async () => {
  const { outcome } = await run(walk);
  const read = Object.fromEntries(
    outcome.steps
      .filter((step) => step.action.kind === "read")
      .map((step) => [step.action.kind === "read" ? step.action.as : "", step.text]),
  );

  assert.equal(read["member_name"], "Priya Raman");
  assert.match(String(read["savings_balance"]), /^\$[\d,]+\.\d{2}$/);
  assert.equal(read["account_status"], "Active");
});

test("an expectation is checked against the real screen, not taken on trust", async () => {
  const wrong: AgentAction[] = [
    {
      ...(walk[0] as AgentAction & { kind: "click" }),
      expect: {
        kind: "ax",
        role: "heading",
        name: { template: "Wire Transfer", match: "contains" },
        framePath: ["content"],
      },
    },
    { kind: "abandon", why: "That was not the screen I expected", reason: "wrong screen" },
  ];

  const { outcome, events } = await run(wrong);
  assert.equal(outcome.result.stopReason, "agent_abandoned");
  assert.ok(
    events.some((event) => event.kind === "expectation" && !event.held),
    "the loop believed a wrong prediction",
  );
});

test("a locator that matches nothing on a real screen is feedback, not a crash", async () => {
  const { outcome } = await run([
    {
      kind: "click",
      why: "Click a control that is not there",
      target: {
        kind: "ax",
        role: "link",
        name: { template: "Nonexistent Screen", match: "equals" },
        framePath: ["nav"],
      },
    },
    { kind: "abandon", why: "No such control", reason: "dead end" },
  ]);
  assert.equal(outcome.result.stopReason, "agent_abandoned");
});

test("the walked path compiles into a contract the artifact schema accepts", async () => {
  const { outcome } = await run(walk);
  const compiled = compileArtifact(contract, outcome.steps, { member_id: MEMBER }, {
    model: "scripted",
    traceRef: "discovery/integration",
  });

  assert.ok(compiled.ok, compiled.ok ? "" : compiled.reason);
  assert.doesNotThrow(() => CapabilitySchema.parse(compiled.capability));
  assert.equal(compiled.capability.steps.length, 5, "three reads folded into the step before them");
  assert.doesNotMatch(
    JSON.stringify(compiled.capability.steps),
    new RegExp(MEMBER),
    "the member number this run used must not survive as a literal",
  );
});
