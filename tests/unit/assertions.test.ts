import { test } from "node:test";
import assert from "node:assert/strict";
import { holds, waitUntil, type StateAssertion } from "@icap/core";
import { FakeSurface, dom, noInputs } from "../helpers/fake-surface.js";

test("a bare locator asserts presence", async () => {
  const surface = new FakeSurface({ present: ["dom:table"] });
  assert.equal(await holds(surface, dom("table"), noInputs), true);
  assert.equal(await holds(surface, dom("form"), noInputs), false);
});

test("anyOf passes when either branch holds", async () => {
  const surface = new FakeSurface({ present: ["dom:.alert"] });
  const assertion: StateAssertion = { anyOf: [dom("table"), dom(".alert")] };
  assert.equal(await holds(surface, assertion, noInputs), true);
});

test("anyOf stops at the first branch that holds", async () => {
  const surface = new FakeSurface({ present: ["dom:table"] });
  await holds(surface, { anyOf: [dom("table"), dom(".alert")] }, noInputs);
  assert.deepEqual(surface.lookups, ["dom:table"]);
});

test("anyOf fails only when no branch holds", async () => {
  const surface = new FakeSurface();
  assert.equal(await holds(surface, { anyOf: [dom("table"), dom(".alert")] }, noInputs), false);
});

test("allOf needs every branch", async () => {
  const surface = new FakeSurface({ present: ["dom:table"] });
  assert.equal(await holds(surface, { allOf: [dom("table")] }, noInputs), true);
  assert.equal(await holds(surface, { allOf: [dom("table"), dom("form")] }, noInputs), false);
});

test("absent inverts presence", async () => {
  const surface = new FakeSurface({ present: ["dom:table"] });
  assert.equal(await holds(surface, { absent: dom("form") }, noInputs), true);
  assert.equal(await holds(surface, { absent: dom("table") }, noInputs), false);
});

test("branches nest", async () => {
  const surface = new FakeSurface({ present: ["dom:table"] });
  const assertion: StateAssertion = {
    allOf: [{ anyOf: [dom(".alert"), dom("table")] }, { absent: dom("form") }],
  };
  assert.equal(await holds(surface, assertion, noInputs), true);
});

test("waitUntil returns as soon as the condition holds", async () => {
  const surface = new FakeSurface({ appearOnCall: { "dom:table": 3 } });
  const started = Date.now();
  const met = await waitUntil(surface, dom("table"), noInputs, { timeoutMs: 3000, pollMs: 20 });
  assert.equal(met, true);
  assert.ok(Date.now() - started < 2000, "should not have waited out the timeout");
});

test("waitUntil gives up at the timeout instead of hanging", async () => {
  const surface = new FakeSurface();
  const met = await waitUntil(surface, dom("table"), noInputs, { timeoutMs: 150, pollMs: 20 });
  assert.equal(met, false);
});
