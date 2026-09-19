/**
 * Turning what an agent walked into a contract somebody else can run.
 *
 * The thing this must not become is a transcript. An agent reaches a goal by
 * trying things; an artifact that records the trying is neither reusable nor
 * reviewable, and "the model was told not to include its mistakes" is not a
 * mechanism. So the filter is structural and lives in two places: the loop only
 * hands over actions whose predicted state actually arrived, and everything
 * here is computed from those actions rather than copied from anywhere.
 *
 * Nothing is invented. Every field is either taken from the contract, derived
 * from an action, or derived from text that was genuinely on screen — and where
 * none of those is possible, compilation refuses instead of guessing.
 */

import { locatesItselfBy, type AgentAction } from "../discovery/actions.js";
import type { RecordedStep } from "../discovery/agent.js";
import {
  CapabilitySchema,
  type Capability,
  type Coercion,
  type ElementLocator,
  type Extraction,
  type Step,
} from "./schema.js";

export interface CompileOptions {
  /** Identifies the decider, for provenance. */
  model: string;
  /** Where the run that produced this is recorded. */
  traceRef: string;
  now?: Date;
}

export type CompileResult =
  | { ok: true; capability: Capability }
  | { ok: false; reason: string };

/* ─────────────────────────── parameterising ─────────────────────────── */

/**
 * Values this run happened to use, longest first so that a value containing
 * another is lifted whole.
 */
function parameters(inputs: Record<string, unknown>): { value: string; token: string }[] {
  return Object.entries(inputs)
    .filter(([, value]) => ["string", "number"].includes(typeof value))
    .map(([name, value]) => ({ value: String(value), token: `{{inputs.${name}}}` }))
    .filter((entry) => entry.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
}

function lift(text: string, params: { value: string; token: string }[]): string {
  return params.reduce((out, param) => out.split(param.value).join(param.token), text);
}

/**
 * A locator with the run's own values lifted into parameters.
 *
 * `selector` and a coordinate note are left alone: neither is interpolated when
 * a locator is resolved, so a parameter placed there would simply stop matching.
 */
function liftLocator(
  locator: ElementLocator,
  params: { value: string; token: string }[],
): ElementLocator {
  const scope = locator.scope;
  const lifted =
    scope === undefined
      ? undefined
      : scope.kind === "row"
        ? { ...scope, containingText: lift(scope.containingText, params) }
        : scope.kind === "labelled"
          ? { ...scope, labelText: lift(scope.labelText, params) }
          : {
              ...scope,
              rowContaining: lift(scope.rowContaining, params),
              columnHeader: lift(scope.columnHeader, params),
            };

  const withScope = <T extends ElementLocator>(next: T): T =>
    lifted === undefined ? next : { ...next, scope: lifted };

  switch (locator.kind) {
    case "ax":
      return withScope(
        locator.name && "template" in locator.name
          ? { ...locator, name: { ...locator.name, template: lift(locator.name.template, params) } }
          : locator,
      );
    case "text":
      return withScope(
        "template" in locator.text
          ? { ...locator, text: { ...locator.text, template: lift(locator.text.template, params) } }
          : locator,
      );
    default:
      return withScope(locator);
  }
}

/* ─────────────────────────── typing what was read ─────────────────────────── */

function isMoney(schema: Record<string, unknown>): boolean {
  const ref = schema["$ref"];
  if (typeof ref === "string" && /Money$/.test(ref)) return true;
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null) return false;
  return "amount" in properties && "currency" in properties;
}

/**
 * How the text on screen becomes the type the contract promises.
 *
 * An enum's map is built from the display value this run actually saw, and
 * `onUnmapped` is left at `hard_failure` on purpose: a value the run never
 * encountered would have to be guessed at, and a wrong guess reads as a
 * legitimate answer rather than as a gap.
 */
function coercionFor(declared: unknown, observed: string | undefined): Coercion {
  const schema = (declared ?? {}) as Record<string, unknown>;

  const values = schema["enum"];
  if (Array.isArray(values)) {
    const map: Record<string, string> = {};
    const seen = observed?.trim();
    const match = values.find(
      (value) => typeof value === "string" && value.toLowerCase() === seen?.toLowerCase(),
    );
    if (seen && typeof match === "string") map[seen] = match;
    return { as: "enum", map, onUnmapped: "hard_failure" };
  }

  if (isMoney(schema)) return { as: "Money", locale: "en-US" };
  if (schema["type"] === "integer") return { as: "integer" };
  return { as: "string", trim: true };
}

/* ─────────────────────────── naming ─────────────────────────── */

/** A legal step id that still says what the step was for. */
function slug(why: string): string {
  const id = why
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("_")
    .replace(/^[^a-z]+/, "");
  return id.length > 0 ? id : "step";
}

function uniqueId(why: string, taken: Set<string>): string {
  const base = slug(why);
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  taken.add(id);
  return id;
}

/* ─────────────────────────── the compiler ─────────────────────────── */

function sameTarget(a: AgentAction, b: AgentAction): boolean {
  if (!("target" in a) || !("target" in b)) return false;
  return JSON.stringify(a.target) === JSON.stringify(b.target);
}

export function compileArtifact(
  contract: Capability,
  walked: RecordedStep[],
  inputs: Record<string, unknown>,
  options: CompileOptions,
): CompileResult {
  const params = parameters(inputs);
  const declared = contract.outputs.properties;

  const steps: Step[] = [];
  const taken = new Set<string>();
  const readInto = new Set<string>();

  for (let i = 0; i < walked.length; i += 1) {
    const recorded = walked[i] as RecordedStep;
    const action = recorded.action;

    if (action.kind === "done" || action.kind === "abandon") continue;

    if (action.kind === "read") {
      if (!(action.as in declared)) {
        return { ok: false, reason: `the run read "${action.as}", which the contract does not declare` };
      }
      // The loop feeds this back while the run is still going; if one reaches
      // here anyway, an artifact that only works for one record must not ship.
      if (recorded.text !== undefined && locatesItselfBy(action.target, recorded.text)) {
        return {
          ok: false,
          reason:
            `the locator for "${action.as}" finds its value by quoting that value, ` +
            `so the artifact would resolve only for the record it was recorded against`,
        };
      }

      const step = steps.at(-1);
      if (!step) {
        return {
          ok: false,
          reason: `the run read "${action.as}" before any step had run; there is nothing to attach it to`,
        };
      }
      const extraction: Extraction = {
        to: action.as,
        target: liftLocator(action.target, params),
        coerce: coercionFor(declared[action.as], recorded.text),
        onCoerceFailure: "hard_failure",
      };
      step.extract.push(extraction);
      readInto.add(action.as);
      continue;
    }

    // Typing again into the same control is one intent that took two goes, and
    // only the value it ended on is part of the flow.
    const previous = steps.at(-1);
    const last = walked[i - 1]?.action;
    if (
      action.kind === "type" &&
      previous?.action.type === "type" &&
      last &&
      sameTarget(action, last)
    ) {
      previous.action = { type: "type", value: lift(action.value, params), clearFirst: action.clearFirst };
      if (action.expect) previous.checkpoint = liftLocator(action.expect, params);
      continue;
    }

    const step: Step = {
      id: uniqueId(action.why, taken),
      // The prose is lifted too. "Search for member 100005" on a capability
      // that takes a member number describes the recording run, not the flow,
      // and a reviewer reading it would be told something untrue.
      intent: lift(action.why, params),
      action: stepAction(action, params),
      extract: [],
      ...("target" in action
        ? { target: { primary: liftLocator(action.target, params), fallbacks: [] } }
        : {}),
      ...(action.expect ? { checkpoint: liftLocator(action.expect, params) } : {}),
    };
    steps.push(step);
  }

  const missing = contract.outputs.required.filter((name) => !readInto.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `the run never read ${missing.map((name) => `"${name}"`).join(", ")}, which the contract requires`,
    };
  }

  const parsed = CapabilitySchema.safeParse({
    ...contract,
    approval: "draft",
    // A declared condition is bound to a step id, and none of the contract's
    // step ids survived. This run observed no conditions of its own.
    outcomes: [],
    provenance: {
      source: "llm_discovery",
      createdAt: (options.now ?? new Date()).toISOString(),
      model: options.model,
      traceRef: options.traceRef,
      humanEdits: [],
    },
    steps,
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, reason: `the compiled artifact is not valid — ${where}${issue?.message ?? ""}` };
  }
  return { ok: true, capability: parsed.data };
}

function stepAction(action: AgentAction, params: { value: string; token: string }[]): Step["action"] {
  switch (action.kind) {
    case "click":
      return { type: "click" };
    case "type":
      return { type: "type", value: lift(action.value, params), clearFirst: action.clearFirst };
    case "select":
      return { type: "select", value: lift(action.value, params) };
    case "press":
      return { type: "press", key: action.key };
    default:
      return { type: "navigate", path: lift((action as { path: string }).path, params) };
  }
}
