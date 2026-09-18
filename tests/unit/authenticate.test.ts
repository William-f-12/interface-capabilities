/**
 * Establishing a session from the tenant profile alone.
 *
 * Sign-in is the one flow no capability describes, so the profile has to carry
 * enough to walk it — and a failure has to say which of the several ways it can
 * go wrong actually happened, without ever quoting a credential.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tenantSignIn } from "@icap/core";
import { ScriptedSurface, testTenant } from "../helpers/scripted.js";

const env = { DEMO_USER: "teller", DEMO_PASSWORD: "teller-pw" };

/** A sign-in screen where submitting produces a session. */
function loginScreen(): ScriptedSurface {
  return new ScriptedSurface({
    facts: ["#user", "#password", "#signin"],
    onAction: (entry, facts) => {
      if (entry === "click #signin") facts.add("#signed-in");
    },
  });
}

test("a session is established and the profile's own locators are what walked it", async () => {
  const surface = loginScreen();
  const result = await tenantSignIn(surface, testTenant(), { env, timeoutMs: 300 })("teller");

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(surface.actions, [
    "navigate /login",
    "fill #user=teller",
    "fill #password=teller-pw",
    "click #signin",
  ]);
});

test("a role with no credentials in the profile is named, not guessed at", async () => {
  const result = await tenantSignIn(loginScreen(), testTenant(), { env, timeoutMs: 300 })("auditor");
  assert.ok(!result.ok);
  assert.match(result.reason, /no credentials for role "auditor"/);
});

test("no role is unambiguous only when the tenant offers exactly one sign-in", async () => {
  const single = await tenantSignIn(loginScreen(), testTenant(), { env, timeoutMs: 300 })(undefined);
  assert.deepEqual(single, { ok: true });

  const twoRoles = testTenant({
    auth: {
      ...testTenant().auth,
      credentials: {
        teller: { username: "env:DEMO_USER", password: "env:DEMO_PASSWORD" },
        supervisor: { username: "env:SUP_USER", password: "env:SUP_PASSWORD" },
      },
    },
  });
  const ambiguous = await tenantSignIn(loginScreen(), twoRoles, { env, timeoutMs: 300 })(undefined);
  assert.ok(!ambiguous.ok);
  assert.match(ambiguous.reason, /names no role and demo declares 2/);
});

test("a credential missing from the environment names the variable, never a value", async () => {
  const surface = loginScreen();
  const result = await tenantSignIn(surface, testTenant(), {
    env: { DEMO_USER: "teller" },
    timeoutMs: 300,
  })("teller");

  assert.ok(!result.ok);
  assert.match(result.reason, /env:DEMO_PASSWORD/);
  assert.doesNotMatch(result.reason, /teller-pw/);
  assert.deepEqual(surface.actions, [], "and it did not go to the sign-in screen to find out");
});

test("an empty variable counts as unset rather than as an empty password", async () => {
  const result = await tenantSignIn(loginScreen(), testTenant(), {
    env: { DEMO_USER: "teller", DEMO_PASSWORD: "" },
    timeoutMs: 300,
  })("teller");
  assert.ok(!result.ok);
  assert.match(result.reason, /env:DEMO_PASSWORD/);
});

test("a sign-in screen missing a control says which control", async () => {
  const noPassword = new ScriptedSurface({ facts: ["#user", "#signin"] });
  const result = await tenantSignIn(noPassword, testTenant(), { env, timeoutMs: 120 })("teller");
  assert.ok(!result.ok);
  assert.match(result.reason, /no password field/);
});

test("credentials that the app rejects are a failed session, not an exception", async () => {
  // Everything is fillable and clickable; no session ever appears.
  const refused = new ScriptedSurface({ facts: ["#user", "#password", "#signin"] });
  const result = await tenantSignIn(refused, testTenant(), { env, timeoutMs: 120 })("teller");

  assert.ok(!result.ok);
  assert.match(result.reason, /did not produce a session/);
  assert.doesNotMatch(result.reason, /teller-pw/, "a reason never carries a credential");
});
