/** Interpolation of `{{inputs.x}}` and conversion of TextMatcher to match options. */

import type { TextMatcher } from "../artifact/schema.js";

export interface BindingContext {
  inputs: Record<string, unknown>;
}

const TEMPLATE = /\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g;

export function render(template: string, ctx: BindingContext): string {
  return template.replace(TEMPLATE, (_match, name: string) => {
    const value = ctx.inputs[name];
    if (value === undefined) {
      throw new Error(`template references input "${name}", which was not supplied`);
    }
    return String(value);
  });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MatchOption {
  value: string | RegExp;
  exact: boolean;
}

/**
 * Templates produce a plain string, so an interpolated value is never parsed as
 * a pattern. `startsWith` is the one case that needs a regex, and the rendered
 * value is escaped before it goes in.
 */
export function toMatchOption(matcher: TextMatcher, ctx: BindingContext): MatchOption {
  if ("template" in matcher) {
    const rendered = render(matcher.template, ctx);
    switch (matcher.match) {
      case "equals":
        return { value: rendered, exact: true };
      case "startsWith":
        return { value: new RegExp(`^${escapeRegExp(rendered)}`, "i"), exact: false };
      default:
        return { value: rendered, exact: false };
    }
  }
  return { value: new RegExp(matcher.pattern, matcher.flags), exact: false };
}
