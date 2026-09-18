/**
 * Validation of a caller's inputs and a run's outputs against the JSON Schema
 * the artifact declares.
 *
 * Those two schemas are the capability's public contract — the same object is
 * meant to be handed to a calling agent as a tool's `input_schema` unchanged —
 * so they are checked as real JSON Schema rather than against a convenient
 * subset. Anything less would accept an artifact whose promises are never kept.
 */

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * Strict mode is off because these schemas carry annotations meant for a model
 * reading the tool definition, which are not validation keywords.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Compilation is the expensive part, and a replayed capability reuses one object. */
const compiled = new WeakMap<object, ValidateFunction>();

export interface SchemaCheck {
  ok: boolean;
  /** One readable line per violation, e.g. `savings_balance.amount must match pattern`. */
  errors: string[];
}

function validatorFor(schema: object): ValidateFunction {
  const cached = compiled.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(schema);
  compiled.set(schema, validate);
  return validate;
}

export function checkAgainstSchema(schema: object, value: unknown): SchemaCheck {
  let validate: ValidateFunction;
  try {
    validate = validatorFor(schema);
  } catch (err) {
    // An unusable schema is a defect in the artifact, reported like any other
    // contract violation rather than thrown at the caller.
    return { ok: false, errors: [`the declared schema cannot be compiled: ${String(err)}`] };
  }

  if (validate(value)) return { ok: true, errors: [] };

  const errors = (validate.errors ?? []).map((issue) => {
    const path = issue.instancePath.replace(/^\//, "").replace(/\//g, ".");
    // An unexpected property is named only in params, and it is the one thing
    // the reader needs, so it is folded into the path.
    const extra = (issue.params as { additionalProperty?: string }).additionalProperty;
    const where = [path, extra].filter((part) => part).join(".") || "<root>";
    return `${where} ${issue.message ?? "is invalid"}`;
  });
  return { ok: false, errors };
}
