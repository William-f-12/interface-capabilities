/** Walks a TargetSpec's fallback ladder and reports which rung answered. */

import type { TargetSpec } from "../artifact/schema.js";
import type { Resolution } from "../replay/contract.js";
import type { ElementRef, FindOptions, Surface } from "./types.js";
import type { BindingContext } from "./template.js";

export interface ResolvedTarget {
  ref: ElementRef;
  resolution: Resolution;
}

export async function resolveTarget(
  surface: Surface,
  target: TargetSpec,
  ctx: BindingContext,
  options?: FindOptions,
): Promise<ResolvedTarget | null> {
  const primary = await surface.find(target.primary, ctx, options);
  if (primary) {
    return { ref: primary, resolution: { rung: "primary", index: 0, kind: target.primary.kind } };
  }

  for (let i = 0; i < target.fallbacks.length; i += 1) {
    const locator = target.fallbacks[i];
    if (!locator) continue;
    const ref = await surface.find(locator, ctx, options);
    if (ref) {
      return { ref, resolution: { rung: "fallback", index: i, kind: locator.kind } };
    }
  }
  return null;
}

/**
 * Waits out the whole timeout on the primary before trying any fallback, so a
 * primary that is merely slow is not recorded as a fallback.
 */
export async function resolveWhenReady(
  surface: Surface,
  target: TargetSpec,
  ctx: BindingContext,
  timeoutMs: number,
  options?: FindOptions,
): Promise<ResolvedTarget | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ref = await surface.find(target.primary, ctx, options);
    if (ref) {
      return { ref, resolution: { rung: "primary", index: 0, kind: target.primary.kind } };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  for (let i = 0; i < target.fallbacks.length; i += 1) {
    const locator = target.fallbacks[i];
    if (!locator) continue;
    const ref = await surface.find(locator, ctx, options);
    if (ref) return { ref, resolution: { rung: "fallback", index: i, kind: locator.kind } };
  }
  return null;
}
