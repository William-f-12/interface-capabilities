/**
 * Renderings of artifact vocabulary for people.
 *
 * A failure report is only useful if `expected` reads as a sentence. These turn
 * a locator or an assertion back into one, so the engine can stay about control
 * flow and a reviewer never has to read raw JSON to learn what was wanted.
 */

import { TEMPLATE } from "../surface/template.js";
import type { ElementLocator, Scope, StateAssertion, TargetSpec, TextMatcher } from "./schema.js";

/** The values a report is describing the flow against. */
export type Bindings = Record<string, unknown>;

/**
 * Fills in what the caller supplied and leaves anything else visible as it was
 * written. A report saying `Member #100005` is the point; one saying
 * `Member #{{inputs.member_id}}` makes the reader do the substitution, and one
 * that threw over a missing input would say nothing at all.
 */
function fill(text: string, inputs?: Bindings): string {
  if (!inputs) return text;
  return text.replace(TEMPLATE, (whole, name: string) =>
    inputs[name] === undefined ? whole : String(inputs[name]),
  );
}

function describeMatcher(matcher: TextMatcher, inputs?: Bindings): string {
  if ("template" in matcher) {
    const relation = matcher.match === "equals" ? "" : `${matcher.match} `;
    return `${relation}"${fill(matcher.template, inputs)}"`;
  }
  return `matching /${matcher.pattern}/${matcher.flags}`;
}

function describeScope(scope: Scope, inputs?: Bindings): string {
  switch (scope.kind) {
    case "row":
      return ` in the row containing "${fill(scope.containingText, inputs)}"`;
    case "labelled":
      return ` labelled "${fill(scope.labelText, inputs)}"`;
    case "tableCell":
      return (
        ` in the "${fill(scope.columnHeader, inputs)}" column of the row containing` +
        ` "${fill(scope.rowContaining, inputs)}"`
      );
  }
}

export function describeLocator(locator: ElementLocator, inputs?: Bindings): string {
  const scope = locator.scope ? describeScope(locator.scope, inputs) : "";
  const frame = locator.framePath.length > 0 ? ` in frame ${locator.framePath.join("/")}` : "";

  switch (locator.kind) {
    case "ax": {
      const name = locator.name ? ` ${describeMatcher(locator.name, inputs)}` : "";
      return `${locator.role}${name}${scope}${frame}`;
    }
    case "text":
      return `text ${describeMatcher(locator.text, inputs)}${scope}${frame}`;
    case "dom":
      return `an element matching "${locator.selector}"${scope}${frame}`;
    case "coords":
      return `the point (${locator.x}, ${locator.y})${locator.note ? ` — ${locator.note}` : ""}`;
  }
}

export function describeTarget(target: TargetSpec, inputs?: Bindings): string {
  const primary = describeLocator(target.primary, inputs);
  if (target.fallbacks.length === 0) return primary;
  return `${primary}, or any of ${target.fallbacks.length} declared fallback(s)`;
}

export function describeAssertion(assertion: StateAssertion, inputs?: Bindings): string {
  if ("anyOf" in assertion) {
    return `any of [${assertion.anyOf.map((a) => describeAssertion(a, inputs)).join("; ")}]`;
  }
  if ("allOf" in assertion) {
    return `all of [${assertion.allOf.map((a) => describeAssertion(a, inputs)).join("; ")}]`;
  }
  if ("absent" in assertion) {
    return `no ${describeLocator(assertion.absent, inputs)}`;
  }
  return describeLocator(assertion, inputs);
}
