/** The refusals that happen before a browser is ever touched. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutputs, checkPreconditions, type Capability } from "@icap/core";
import { loadCapability, loadTenant } from "../helpers/artifacts.js";

const capability = loadCapability();
const tenant = loadTenant();
const inputs = { member_id: "100005" };

const balance = { amount: "45000.00", currency: "USD" };
const outputs = {
  member_name: "Priya Raman",
  savings_balance: balance,
  account_status: "active",
};

/* ── what the repository ships must pass ─────────────────────────────────── */

test("the shipped artifact and tenant profile satisfy each other", () => {
  assert.equal(checkPreconditions(capability, tenant, inputs), null);
});

test("outputs of the shape the artifact promises are accepted", () => {
  assert.equal(checkOutputs(capability, outputs), null);
});

/* ── contract ────────────────────────────────────────────────────────────── */

test("a draft capability is refused before anything runs", () => {
  const draft: Capability = { ...capability, approval: "draft" };
  const failure = checkPreconditions(draft, tenant, inputs);
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
  assert.match(failure?.observed ?? "", /draft/);
});

test("a capability with a contract but no recorded flow is refused", () => {
  const empty: Capability = { ...capability, steps: [] };
  assert.equal(checkPreconditions(empty, tenant, inputs)?.cause, "CONTRACT_VIOLATION");
});

test("the repository's own draft artifact is refused for the same reason", () => {
  const draft = loadCapability("member.open_sub_account");
  assert.equal(checkPreconditions(draft, tenant, inputs)?.cause, "CONTRACT_VIOLATION");
});

/* ── inputs ──────────────────────────────────────────────────────────────── */

test("an input failing its declared pattern is a contract violation, not a bad search", () => {
  const failure = checkPreconditions(capability, tenant, { member_id: "abc" });
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
  assert.match(failure?.observed ?? "", /member_id/);
});

test("a missing required input names the property that is missing", () => {
  const failure = checkPreconditions(capability, tenant, {});
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
  assert.match(failure?.observed ?? "", /member_id/);
});

test("an input the contract does not declare is refused rather than ignored", () => {
  const failure = checkPreconditions(capability, tenant, { ...inputs, branch: "Downtown" });
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
  assert.match(failure?.observed ?? "", /branch/);
});

test("a number where the contract says string is refused", () => {
  assert.equal(
    checkPreconditions(capability, tenant, { member_id: 100005 })?.cause,
    "CONTRACT_VIOLATION",
  );
});

/* ── target and tenant ───────────────────────────────────────────────────── */

test("an artifact recorded against another application is refused", () => {
  const other: Capability = {
    ...capability,
    target: { ...capability.target, app: "other-core" },
  };
  const failure = checkPreconditions(other, tenant, inputs);
  assert.equal(failure?.cause, "PRECONDITION_FAILED");
  assert.match(failure?.message ?? "", /different application/);
});

test("a tenant running a build outside the recorded range is refused", () => {
  const upgraded = { ...tenant, appVersion: "3.0.0" };
  const failure = checkPreconditions(capability, upgraded, inputs);
  assert.equal(failure?.cause, "PRECONDITION_FAILED");
  assert.match(failure?.observed ?? "", /3\.0\.0/);
});

test("a tenant inside the range is allowed, including a later patch", () => {
  assert.equal(checkPreconditions(capability, { ...tenant, appVersion: "2.4.7" }, inputs), null);
});

test("a capability whose role the tenant cannot sign in as is refused", () => {
  const auditor: Capability = {
    ...capability,
    preconditions: { authenticated: true, role: "auditor" },
  };
  const failure = checkPreconditions(auditor, tenant, inputs);
  assert.equal(failure?.cause, "PRECONDITION_FAILED");
  assert.match(failure?.expected ?? "", /auditor/);
});

/* ── outputs ─────────────────────────────────────────────────────────────── */

test("an amount left as screen text is caught by the output contract", () => {
  const failure = checkOutputs(capability, { ...outputs, savings_balance: "$45,000.00" });
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
});

test("a float amount is refused, since Money promises a decimal string", () => {
  const failure = checkOutputs(capability, {
    ...outputs,
    savings_balance: { amount: 45000, currency: "USD" },
  });
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
});

test("a status outside the declared set is refused", () => {
  assert.equal(
    checkOutputs(capability, { ...outputs, account_status: "Active" })?.cause,
    "CONTRACT_VIOLATION",
  );
});

test("a missing required output is refused", () => {
  const { savings_balance: _dropped, ...partial } = outputs;
  const failure = checkOutputs(capability, partial);
  assert.equal(failure?.cause, "CONTRACT_VIOLATION");
  assert.match(failure?.observed ?? "", /savings_balance/);
});

test("a capability that does not insist on every output tolerates a missing one", () => {
  const lenient: Capability = {
    ...capability,
    successCondition: { ...capability.successCondition, allRequiredOutputsPresent: false },
  };
  const { savings_balance: _dropped, ...partial } = outputs;
  assert.equal(checkOutputs(lenient, partial), null);
});

test("even when outputs are optional, a value that is present is still typed", () => {
  const lenient: Capability = {
    ...capability,
    successCondition: { ...capability.successCondition, allRequiredOutputsPresent: false },
  };
  assert.equal(
    checkOutputs(lenient, { savings_balance: { amount: "45,000", currency: "USD" } })?.cause,
    "CONTRACT_VIOLATION",
  );
});
