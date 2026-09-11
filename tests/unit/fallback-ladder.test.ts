import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget, resolveWhenReady, type TargetSpec } from "@icap/core";
import { FakeSurface, ax, dom, noInputs } from "../helpers/fake-surface.js";

const target: TargetSpec = {
  primary: ax("link"),
  fallbacks: [dom("a.first"), dom("a.second")],
};

test("the primary answers when it is there", async () => {
  const surface = new FakeSurface({ present: ["ax:link"] });
  const resolved = await resolveTarget(surface, target, noInputs);
  assert.deepEqual(resolved?.resolution, { rung: "primary", index: 0, kind: "ax" });
});

test("the ladder descends in order and reports which rung answered", async () => {
  const surface = new FakeSurface({ present: ["dom:a.second"] });
  const resolved = await resolveTarget(surface, target, noInputs);
  assert.deepEqual(resolved?.resolution, { rung: "fallback", index: 1, kind: "dom" });
  assert.deepEqual(surface.lookups, ["ax:link", "dom:a.first", "dom:a.second"]);
});

test("nothing resolving is null, not an exception", async () => {
  const surface = new FakeSurface();
  assert.equal(await resolveTarget(surface, target, noInputs), null);
});

test("a target with no fallbacks still resolves its primary", async () => {
  const surface = new FakeSurface({ present: ["ax:link"] });
  const resolved = await resolveTarget(surface, { primary: ax("link"), fallbacks: [] }, noInputs);
  assert.equal(resolved?.resolution.rung, "primary");
});

test("a primary that is still loading wins over an available fallback", async () => {
  const surface = new FakeSurface({
    present: ["dom:a.first"],
    appearOnCall: { "ax:link": 3 },
  });
  const resolved = await resolveWhenReady(surface, target, noInputs, 3000);
  assert.deepEqual(
    resolved?.resolution,
    { rung: "primary", index: 0, kind: "ax" },
    "polling the whole ladder would have reported drift that did not happen",
  );
});

test("a primary that never appears falls through after the timeout", async () => {
  const surface = new FakeSurface({ present: ["dom:a.first"] });
  const resolved = await resolveWhenReady(surface, target, noInputs, 150);
  assert.deepEqual(resolved?.resolution, { rung: "fallback", index: 0, kind: "dom" });
});
