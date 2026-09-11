/** Evaluation of checkpoints and outcome detectors against any Surface. */

import type { StateAssertion } from "../artifact/schema.js";
import type { FindOptions, Surface } from "./types.js";
import type { BindingContext } from "./template.js";

export async function holds(
  surface: Surface,
  assertion: StateAssertion,
  ctx: BindingContext,
  options?: FindOptions,
): Promise<boolean> {
  if ("anyOf" in assertion) {
    for (const branch of assertion.anyOf) {
      if (await holds(surface, branch, ctx, options)) return true;
    }
    return false;
  }
  if ("allOf" in assertion) {
    for (const branch of assertion.allOf) {
      if (!(await holds(surface, branch, ctx, options))) return false;
    }
    return true;
  }
  if ("absent" in assertion) {
    return (await surface.find(assertion.absent, ctx, options)) === null;
  }
  return (await surface.find(assertion, ctx, options)) !== null;
}

export interface WaitOptions extends FindOptions {
  timeoutMs: number;
  pollMs?: number;
}

/** Polls until the assertion holds or the timeout passes. */
export async function waitUntil(
  surface: Surface,
  assertion: StateAssertion,
  ctx: BindingContext,
  options: WaitOptions,
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 200;
  for (;;) {
    if (await holds(surface, assertion, ctx, options)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
