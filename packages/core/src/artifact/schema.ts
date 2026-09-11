/**
 * Capability artifact schema.
 *
 * A capability describes a reusable flow: what a caller supplies, what it gets
 * back, the ordered steps, how each control is identified, and which conditions
 * count as legitimate answers rather than failures.
 *
 * Nothing here names a browser technology. `dom` and `coords` are the bottom two
 * rungs of the fallback ladder, not the vocabulary.
 */

import { z } from "zod";

/* ─────────────────────────── primitives ─────────────────────────── */

/** Amounts are decimal strings, never floats. */
export const MoneySchema = z.object({
  amount: z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'decimal string, e.g. "1234.56"'),
  currency: z.literal("USD"),
});
export type Money = z.infer<typeof MoneySchema>;

/** Matches text by interpolating `{{inputs.x}}`, with the value regex-escaped. */
export const TextTemplateSchema = z.object({
  template: z.string(),
  match: z.enum(["equals", "contains", "startsWith"]).default("contains"),
});

/** Matches text by regular expression, compiled and checked at load time. */
export const TextPatternSchema = z
  .object({
    pattern: z.string(),
    flags: z
      .string()
      .regex(/^[gimsuy]*$/)
      .default(""),
  })
  .refine(
    (v) => {
      try {
        new RegExp(v.pattern, v.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid regular expression" },
  );

export const TextMatcherSchema = z.union([TextTemplateSchema, TextPatternSchema]);
export type TextMatcher = z.infer<typeof TextMatcherSchema>;

/* ─────────────────────────── locating ─────────────────────────── */

/**
 * Narrows where to search; `kind` on a locator says how to recognise.
 *
 * `row` narrows a search area and the locator's `kind` applies inside it.
 * `labelled` and `tableCell` already name one element, so they resolve to it
 * and the locator's `kind` only states what is expected there.
 */
export const ScopeSchema = z.discriminatedUnion("kind", [
  /** The table row containing this text. */
  z.object({ kind: z.literal("row"), containingText: z.string() }),
  /** The control a label points at, or the cell following the label. */
  z.object({ kind: z.literal("labelled"), labelText: z.string() }),
  /** One cell, addressed by its row's content and its column's header. */
  z.object({
    kind: z.literal("tableCell"),
    rowContaining: z.string(),
    columnHeader: z.string(),
  }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

const locatorCommon = {
  /** Frame ancestry, outermost first. Empty means the top-level document. */
  framePath: z.array(z.string()).default([]),
  scope: ScopeSchema.optional(),
};

/**
 * ARIA roles a surface can resolve. A role outside this set is an authoring
 * mistake, and it is caught when the artifact loads rather than at the click.
 */
export const ARIA_ROLES = [
  "alert", "alertdialog", "application", "article", "banner", "blockquote",
  "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "deletion", "dialog",
  "directory", "document", "emphasis", "feed", "figure", "form", "generic",
  "grid", "gridcell", "group", "heading", "img", "insertion", "link", "list",
  "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar",
  "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation",
  "none", "note", "option", "paragraph", "presentation", "progressbar",
  "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar",
  "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist",
  "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree",
  "treegrid", "treeitem",
] as const;

export const AriaRoleSchema = z.enum(ARIA_ROLES);
export type AriaRole = z.infer<typeof AriaRoleSchema>;

/**
 * The fallback ladder, most trustworthy first.
 *
 *   ax     — accessibility role and name; also available on desktop surfaces
 *   text   — visible text
 *   dom    — a selector
 *   coords — recorded pixel position
 */
export const ElementLocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ax"),
    role: AriaRoleSchema,
    name: TextMatcherSchema.optional(),
    ...locatorCommon,
  }),
  z.object({ kind: z.literal("text"), text: TextMatcherSchema, ...locatorCommon }),
  z.object({ kind: z.literal("dom"), selector: z.string(), ...locatorCommon }),
  z.object({
    kind: z.literal("coords"),
    x: z.number(),
    y: z.number(),
    note: z.string().optional(),
    ...locatorCommon,
  }),
]);
export type ElementLocator = z.infer<typeof ElementLocatorSchema>;

export const TargetSpecSchema = z.object({
  primary: ElementLocatorSchema,
  fallbacks: z.array(ElementLocatorSchema).default([]),
});
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

/* ─────────────────────────── asserting ─────────────────────────── */

/** A condition on the current state. A bare locator asserts presence. */
export type StateAssertion =
  | ElementLocator
  | { anyOf: StateAssertion[] }
  | { allOf: StateAssertion[] }
  | { absent: ElementLocator };

/** `framePath` has a default, so the on-disk and parsed shapes differ. */
type ElementLocatorInput = z.input<typeof ElementLocatorSchema>;

type StateAssertionInput =
  | ElementLocatorInput
  | { anyOf: StateAssertionInput[] }
  | { allOf: StateAssertionInput[] }
  | { absent: ElementLocatorInput };

export const StateAssertionSchema: z.ZodType<
  StateAssertion,
  z.ZodTypeDef,
  StateAssertionInput
> = z.lazy(() =>
  z.union([
    z.object({ anyOf: z.array(StateAssertionSchema).min(1) }),
    z.object({ allOf: z.array(StateAssertionSchema).min(1) }),
    z.object({ absent: ElementLocatorSchema }),
    ElementLocatorSchema,
  ]),
);

/* ─────────────────────────── acting ─────────────────────────── */

export const StepActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click") }),
  z.object({
    type: z.literal("type"),
    /** Literal text, or a `{{inputs.x}}` template. */
    value: z.string(),
    clearFirst: z.boolean().default(true),
  }),
  z.object({ type: z.literal("select"), value: z.string() }),
  z.object({ type: z.literal("navigate"), path: z.string() }),
  z.object({ type: z.literal("press"), key: z.string() }),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

/* ─────────────────────────── reading ─────────────────────────── */

export const CoercionSchema = z.discriminatedUnion("as", [
  z.object({ as: z.literal("string"), trim: z.boolean().default(true) }),
  z.object({ as: z.literal("Money"), locale: z.string().default("en-US") }),
  z.object({ as: z.literal("integer") }),
  z.object({ as: z.literal("date"), format: z.string() }),
  z.object({
    as: z.literal("enum"),
    /** Display text on screen -> the value promised in `outputs`. */
    map: z.record(z.string()),
    /** What to do with a display value the map does not cover. */
    onUnmapped: z.enum(["hard_failure", "null"]).default("hard_failure"),
  }),
]);

/** Reads one value out of the state a step reaches and types it. */
export const ExtractionSchema = z.object({
  /** Property name in `outputs.properties`. Checked at load time. */
  to: z.string(),
  target: ElementLocatorSchema,
  coerce: CoercionSchema,
  onCoerceFailure: z.enum(["hard_failure", "null"]).default("hard_failure"),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/* ─────────────────────────── steps ─────────────────────────── */

export const StepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  /** Human-readable summary, read by reviewers and by a calling agent. */
  intent: z.string().min(1),
  action: StepActionSchema,
  target: TargetSpecSchema.optional(),
  /** Waited for after the action; also the step's proof that the action landed. */
  checkpoint: StateAssertionSchema.optional(),
  /** Read once the checkpoint holds. */
  extract: z.array(ExtractionSchema).default([]),
});
export type Step = z.infer<typeof StepSchema>;

/* ─────────────────────────── outcomes ─────────────────────────── */

/**
 * How a detected condition is classified.
 *
 *   business_outcome — a legitimate answer for the caller
 *   recoverable      — the run can continue after acting on it
 *   hard_failure     — stop and report
 *
 * Undeclared breakage is a hard failure by default.
 */
export const OutcomeKindSchema = z.enum(["business_outcome", "recoverable", "hard_failure"]);

export const RecoverySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dismiss"), target: TargetSpecSchema }),
  z.object({
    action: z.literal("reauthenticate"),
    restartFromStart: z.boolean().default(true),
  }),
  z.object({ action: z.literal("wait"), ms: z.number().int().positive() }),
  z.object({ action: z.literal("retryStep") }),
  /** Hands the live session to a person, then continues at `resumeFrom`. */
  z.object({
    action: z.literal("escalate"),
    /** Shown to the operator. */
    reason: z.string().min(1),
    requiredRole: z.string(),
    resumeFrom: z.string(),
  }),
]);
export type Recovery = z.infer<typeof RecoverySchema>;

const outcomeBase = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: OutcomeKindSchema,
  /** Caller-facing documentation for this outcome. */
  description: z.string().min(1),
  detect: StateAssertionSchema,
  /** Step id after which to check. Set on capability outcomes, never on ambient ones. */
  after: z.string().optional(),
  /** For business_outcome: stop at once, or finish the remaining steps first. */
  onDetect: z.enum(["halt", "continue"]).optional(),
  recover: RecoverySchema.optional(),
  /** Times this condition may fire before it becomes a hard failure. */
  maxAttempts: z.number().int().min(0).default(1),
});

function checkOutcomeShape(o: z.infer<typeof outcomeBase>, ctx: z.RefinementCtx) {
  if (o.kind === "business_outcome" && !o.onDetect) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `business_outcome ${o.code} must set onDetect ("halt" or "continue")`,
    });
  }
  if (o.kind === "recoverable" && !o.recover) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `recoverable outcome ${o.code} must declare a recover action`,
    });
  }
  if (o.kind === "hard_failure" && o.recover) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `hard_failure ${o.code} must not declare a recover action`,
    });
  }
}

/**
 * An outcome declared by a capability. Its binding to a step is checked by
 * CapabilitySchema, because a draft may declare outcomes before it has steps.
 */
export const CapabilityOutcomeSchema = outcomeBase.superRefine(checkOutcomeShape);

/** An outcome declared by a tenant profile: global, checked after every step. */
export const AmbientOutcomeSchema = outcomeBase.superRefine((o, ctx) => {
  checkOutcomeShape(o, ctx);
  if (o.after) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ambient outcome ${o.code} is global and must not set "after"`,
    });
  }
});

export type Outcome = z.infer<typeof outcomeBase>;

/* ─────────────────────────── provenance ─────────────────────────── */

/** Where an artifact came from, and who has edited it since. */
export const ProvenanceSchema = z.object({
  source: z.enum(["handwritten", "llm_discovery", "llm_discovery+human_edit"]),
  createdAt: z.string().datetime(),
  model: z.string().nullable(),
  /** Path under evidence/discovery/ for the run that produced this. */
  traceRef: z.string().nullable(),
  humanEdits: z
    .array(
      z.object({
        at: z.string().datetime(),
        by: z.string(),
        note: z.string(),
      }),
    )
    .default([]),
  note: z.string().optional(),
});

/* ─────────────────────────── the capability ─────────────────────────── */

/** Plain JSON Schema, usable as a calling agent's tool `input_schema` unchanged. */
const JsonSchemaObject = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.unknown()).default({}),
    required: z.array(z.string()).default([]),
  })
  .passthrough();

export const CapabilitySchema = z
  .object({
    apiVersion: z.literal("capability/v1"),
    /** `domain.action`, e.g. member.lookup_savings_balance */
    id: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
    /**
     * semver over the contract:
     *   major — breaking contract change
     *   minor — backwards-compatible addition
     *   patch — implementation only; a caller need not react
     */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1),
    description: z.string().min(1),

    /** Which product and which build range. The tenant is not part of this. */
    target: z.object({
      app: z.string(),
      appVersion: z.string(),
    }),

    /** Checked before the first step runs. */
    preconditions: z.object({
      authenticated: z.boolean().default(true),
      role: z.string().optional(),
    }),

    risk: z.enum(["read_only", "reversible", "irreversible"]),
    approval: z.enum(["draft", "approved"]),
    provenance: ProvenanceSchema,

    inputs: JsonSchemaObject,
    outputs: JsonSchemaObject,

    outcomes: z.array(CapabilityOutcomeSchema).default([]),
    /** Empty on a draft, whose contract is set but whose flow is not recorded. */
    steps: z.array(StepSchema).default([]),

    successCondition: z.object({
      allRequiredOutputsPresent: z.boolean().default(true),
      finalState: StateAssertionSchema.optional(),
    }),
  })
  .superRefine((cap, ctx) => {
    const fail = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    const stepIds = cap.steps.map((s) => s.id);
    const knownSteps = new Set(stepIds);
    if (knownSteps.size !== stepIds.length) fail("duplicate step ids");

    // navigate and press act on the surface as a whole; everything else needs
    // to know which control it is acting on.
    for (const step of cap.steps) {
      const needsTarget = ["click", "type", "select"].includes(step.action.type);
      if (needsTarget && !step.target) {
        fail(`step ${step.id} is a ${step.action.type} with no target`);
      }
    }

    if (cap.approval === "approved" && cap.steps.length === 0) {
      fail("an approved capability must have at least one step");
    }

    // Step bindings only apply once there are steps to bind to.
    for (const outcome of cap.outcomes) {
      if (cap.steps.length === 0) continue;
      if (!outcome.after) {
        fail(`outcome ${outcome.code} must set "after" (a step id)`);
      } else if (!knownSteps.has(outcome.after)) {
        fail(`outcome ${outcome.code}.after references unknown step "${outcome.after}"`);
      }
      const recover = outcome.recover;
      if (recover?.action === "escalate" && !knownSteps.has(recover.resumeFrom)) {
        fail(`outcome ${outcome.code} escalates to unknown resumeFrom "${recover.resumeFrom}"`);
      }
    }

    const declaredOutputs = new Set(Object.keys(cap.outputs.properties));
    const extracted = new Set<string>();
    for (const step of cap.steps) {
      for (const extraction of step.extract) {
        if (!declaredOutputs.has(extraction.to)) {
          fail(`step ${step.id} extracts "${extraction.to}", which is not a declared output`);
        }
        extracted.add(extraction.to);
      }
    }
    if (cap.steps.length > 0) {
      for (const required of cap.outputs.required) {
        if (!extracted.has(required)) {
          fail(`required output "${required}" is never extracted by any step`);
        }
      }
    }

    // Catch a mistyped template reference on load rather than mid-replay.
    const declaredInputs = new Set(Object.keys(cap.inputs.properties));
    const templateRefs = JSON.stringify(cap).matchAll(/\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g);
    for (const match of templateRefs) {
      const name = match[1];
      if (name && !declaredInputs.has(name)) {
        fail(`template references undeclared input "${name}"`);
      }
    }
  });

export type Capability = z.infer<typeof CapabilitySchema>;
