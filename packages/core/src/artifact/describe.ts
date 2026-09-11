/**
 * Renderings of artifact vocabulary for people.
 *
 * A failure report is only useful if `expected` reads as a sentence. These turn
 * a locator or an assertion back into one, so the engine can stay about control
 * flow and a reviewer never has to read raw JSON to learn what was wanted.
 */

import type { ElementLocator, Scope, StateAssertion, TargetSpec, TextMatcher } from "./schema.js";

function describeMatcher(matcher: TextMatcher): string {
  if ("template" in matcher) {
    const relation = matcher.match === "equals" ? "" : `${matcher.match} `;
    return `${relation}"${matcher.template}"`;
  }
  return `matching /${matcher.pattern}/${matcher.flags}`;
}

function describeScope(scope: Scope): string {
  switch (scope.kind) {
    case "row":
      return ` in the row containing "${scope.containingText}"`;
    case "labelled":
      return ` labelled "${scope.labelText}"`;
    case "tableCell":
      return ` in the "${scope.columnHeader}" column of the row containing "${scope.rowContaining}"`;
  }
}

export function describeLocator(locator: ElementLocator): string {
  const scope = locator.scope ? describeScope(locator.scope) : "";
  const frame =
    locator.framePath.length > 0 ? ` in frame ${locator.framePath.join("/")}` : "";

  switch (locator.kind) {
    case "ax":
      return `${locator.role}${locator.name ? ` ${describeMatcher(locator.name)}` : ""}${scope}${frame}`;
    case "text":
      return `text ${describeMatcher(locator.text)}${scope}${frame}`;
    case "dom":
      return `an element matching "${locator.selector}"${scope}${frame}`;
    case "coords":
      return `the point (${locator.x}, ${locator.y})${locator.note ? ` — ${locator.note}` : ""}`;
  }
}

export function describeTarget(target: TargetSpec): string {
  const primary = describeLocator(target.primary);
  if (target.fallbacks.length === 0) return primary;
  return `${primary}, or any of ${target.fallbacks.length} declared fallback(s)`;
}

export function describeAssertion(assertion: StateAssertion): string {
  if ("anyOf" in assertion) {
    return `any of [${assertion.anyOf.map(describeAssertion).join("; ")}]`;
  }
  if ("allOf" in assertion) {
    return `all of [${assertion.allOf.map(describeAssertion).join("; ")}]`;
  }
  if ("absent" in assertion) {
    return `no ${describeLocator(assertion.absent)}`;
  }
  return describeLocator(assertion);
}
