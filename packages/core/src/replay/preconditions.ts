/**
 * What is checked before the first step runs, and what is checked about the
 * values a run produced.
 *
 * These are the cheap refusals. An artifact recorded against a build the tenant
 * does not run, or a caller supplying a member id with letters in it, should
 * cost nothing to reject — and should be reported as a contract problem rather
 * than as a locator that mysteriously failed on step three.
 */

import type { Capability } from "../artifact/schema.js";
import type { TenantConfig } from "../artifact/tenant.js";
import { satisfies } from "../artifact/version.js";
import { TEMPLATE } from "../surface/template.js";
import type { FailureCause, FailureDetail } from "./contract.js";
import { checkAgainstSchema } from "./jsonschema.js";

function refuse(
  cause: FailureCause,
  expected: string,
  observed: string,
  message: string,
): FailureDetail {
  return {
    cause,
    code: null,
    stepId: null,
    stepIntent: null,
    expected,
    observed,
    message,
    snapshotRef: null,
  };
}

/** Names every input the capability interpolates anywhere, cached per artifact. */
const interpolated = new WeakMap<object, Set<string>>();

function templateInputs(capability: Capability): Set<string> {
  const cached = interpolated.get(capability);
  if (cached) return cached;

  const names = new Set<string>();
  for (const match of JSON.stringify(capability).matchAll(TEMPLATE)) {
    if (match[1]) names.add(match[1]);
  }
  interpolated.set(capability, names);
  return names;
}

/** The reason this run must not start, or null if nothing stands in the way. */
export function checkPreconditions(
  capability: Capability,
  tenant: TenantConfig,
  inputs: Record<string, unknown>,
): FailureDetail | null {
  if (capability.approval !== "approved") {
    return refuse(
      "CONTRACT_VIOLATION",
      "an approved capability",
      `${capability.id}@${capability.version} is a draft`,
      "A draft capability states a contract but has not been signed off for replay.",
    );
  }

  if (capability.steps.length === 0) {
    return refuse(
      "CONTRACT_VIOLATION",
      "a recorded flow",
      "the capability has no steps",
      "This capability declares a contract but no flow to run.",
    );
  }

  if (capability.target.app !== tenant.app) {
    return refuse(
      "PRECONDITION_FAILED",
      `the ${capability.target.app} application`,
      `tenant ${tenant.tenantId} runs ${tenant.app}`,
      "This capability was recorded against a different application.",
    );
  }

  if (!satisfies(tenant.appVersion, capability.target.appVersion)) {
    return refuse(
      "PRECONDITION_FAILED",
      `${capability.target.app} ${capability.target.appVersion}`,
      `tenant ${tenant.tenantId} runs ${tenant.app} ${tenant.appVersion}`,
      "The screens this capability was recorded against are not the screens this tenant runs.",
    );
  }

  const role = capability.preconditions.role;
  if (capability.preconditions.authenticated && role && !tenant.auth.credentials[role]) {
    return refuse(
      "PRECONDITION_FAILED",
      `credentials for the "${role}" role`,
      `tenant ${tenant.tenantId} declares: ${Object.keys(tenant.auth.credentials).join(", ") || "none"}`,
      `This capability must run as "${role}", and this tenant has no such sign-in.`,
    );
  }

  const check = checkAgainstSchema(capability.inputs, inputs);
  if (!check.ok) {
    return refuse(
      "CONTRACT_VIOLATION",
      "inputs matching the declared input schema",
      check.errors.join("; "),
      `The caller's inputs do not satisfy ${capability.id}'s contract.`,
    );
  }

  // A tenant patch naming a step this capability does not have would otherwise
  // be dropped in silence — and a tenant that needs an extra step needs it.
  const stepIds = new Set(capability.steps.map((step) => step.id));

  for (const insertion of tenant.stepInsertions) {
    if (insertion.capabilityId !== capability.id) continue;
    if (!stepIds.has(insertion.beforeStepId)) {
      return refuse(
        "CONTRACT_VIOLATION",
        `a step named "${insertion.beforeStepId}" to insert "${insertion.step.id}" before`,
        `${capability.id}@${capability.version} has: ${[...stepIds].join(", ")}`,
        `Tenant ${tenant.tenantId} patches a step this version of the capability does not have.`,
      );
    }
  }

  for (const key of Object.keys(tenant.targetOverrides)) {
    const [id, stepId] = key.split("#");
    if (id !== capability.id) continue;
    if (!stepId || !stepIds.has(stepId)) {
      return refuse(
        "CONTRACT_VIOLATION",
        `a step named "${stepId ?? ""}" for override "${key}"`,
        `${capability.id}@${capability.version} has: ${[...stepIds].join(", ")}`,
        `Tenant ${tenant.tenantId} overrides a step this version of the capability does not have.`,
      );
    }
  }

  // The schema can be satisfied while a template is still unfillable: an input
  // that is declared but not required, referenced by a step, and left out. That
  // would otherwise surface as an exception from the middle of the flow.
  const missing = [...templateInputs(capability)].filter((name) => inputs[name] === undefined);
  if (missing.length > 0) {
    return refuse(
      "CONTRACT_VIOLATION",
      `a value for every input the flow interpolates: ${missing.join(", ")}`,
      `not supplied: ${missing.join(", ")}`,
      `${capability.id} interpolates inputs the caller did not supply.`,
    );
  }

  return null;
}

/** Relaxed variants, kept so repeated runs of one capability compile once. */
const relaxed = new WeakMap<object, object>();

function outputSchemaFor(capability: Capability): object {
  if (capability.successCondition.allRequiredOutputsPresent) return capability.outputs;
  const cached = relaxed.get(capability.outputs);
  if (cached) return cached;
  const schema = { ...capability.outputs, required: [] };
  relaxed.set(capability.outputs, schema);
  return schema;
}

/**
 * Whether what the run read back is what the capability promised.
 *
 * `allRequiredOutputsPresent: false` says a run may succeed having read only
 * some of its outputs, so the required list is relaxed — but every value that
 * is present is still held to its declared type.
 */
export function checkOutputs(
  capability: Capability,
  outputs: Record<string, unknown>,
): FailureDetail | null {
  const check = checkAgainstSchema(outputSchemaFor(capability), outputs);
  if (check.ok) return null;

  return refuse(
    "CONTRACT_VIOLATION",
    "outputs matching the declared output schema",
    check.errors.join("; "),
    `The run finished but did not produce what ${capability.id} promises.`,
  );
}
