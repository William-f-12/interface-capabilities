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
