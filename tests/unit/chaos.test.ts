/** The fixture's fault-injection counter, which the integration suite arms. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { arm, armed, consume, isChaosMode } from "../../targets/legacy-core/src/chaos.js";

test("nothing is armed to begin with", () => {
  const state = armed();
  assert.equal(consume(state), "none");
});

test("a mode applies for the number of renders it was armed for", () => {
  const state = armed();
  arm(state, "notice", 2);
  assert.equal(consume(state), "notice");
  assert.equal(consume(state), "notice");
  assert.equal(consume(state), "none");
});

test("the mode clears itself once the count runs out", () => {
  const state = armed();
  arm(state, "app_error", 1);
  consume(state);
  assert.deepEqual(state, { mode: "none", remaining: 0 });
});

test("arming none clears whatever was pending", () => {
  const state = armed();
  arm(state, "app_error", 5);
  arm(state, "none", 3);
  assert.equal(consume(state), "none");
  assert.equal(state.remaining, 0);
});

test("re-arming replaces the pending mode rather than queuing", () => {
  const state = armed();
  arm(state, "notice", 3);
  arm(state, "session_expired", 1);
  assert.equal(consume(state), "session_expired");
  assert.equal(consume(state), "none");
});

test("only the documented modes are accepted", () => {
  for (const mode of ["none", "notice", "slow_load", "session_expired", "permission_denied", "app_error"]) {
    assert.equal(isChaosMode(mode), true, mode);
  }
  assert.equal(isChaosMode("explode"), false);
  assert.equal(isChaosMode(""), false);
});
