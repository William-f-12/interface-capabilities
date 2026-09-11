/**
 * The replay contract: what an invocation takes, and what the caller gets back.
 *
 * A run ends in one of four states.
 *
 *   succeeded — the success condition held and every required output is present
 *   halted    — a declared business outcome stopped the run early; not a failure
 *   suspended — escalated and waiting on a person; resumable
 *   failed    — a hard failure, with the step, the expectation and the observation
 *
 * Recovering from a recoverable condition does not change how a run ends, so it
 * is reported in `recoveries` rather than in `status`. A recoverable condition
 * that exhausts its attempts becomes `failed` with cause RECOVERY_EXHAUSTED.
 */

import { z } from "zod";

/* ─────────────────────────── run budget ─────────────────────────── */

/**
 * How patient one invocation may be. Per-condition `maxAttempts` lives on the
 * outcome in the artifact; `maxRecoveries` caps the run as a whole.
 */
export const RunBudgetSchema = z.object({
  wallClockMs: z.number().int().positive().default(60_000),
  perStepMs: z.number().int().positive().default(15_000),
  maxRecoveries: z.number().int().min(0).default(3),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

/* ─────────────────────────── per-step reporting ─────────────────────────── */

/** Which rung of the fallback ladder resolved the target. */
export const ResolutionSchema = z.object({
  rung: z.enum(["primary", "fallback"]),
  /** Index into `fallbacks`; 0 for the primary. */
  index: z.number().int().min(0),
  kind: z.enum(["ax", "text", "dom", "coords"]),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

export const StepReportSchema = z.object({
  stepId: z.string(),
  intent: z.string(),
  status: z.enum(["ok", "skipped", "failed"]),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  /** Null when the step needs no target, or never resolved one. */
  resolvedBy: ResolutionSchema.nullable(),
  /** Null when the step declares no checkpoint. */
  checkpointMet: z.boolean().nullable(),
  /** Zero on a step that was skipped because the run ended before it. */
  attempts: z.number().int().min(0),
});
export type StepReport = z.infer<typeof StepReportSchema>;

/* ─────────────────────────── observations ─────────────────────────── */

/** One declared condition, detected during the run. */
export const OutcomeObservationSchema = z.object({
  code: z.string(),
  kind: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  /** Declared by the capability, or by the tenant's ambient set. */
  origin: z.enum(["capability", "ambient"]),
  atStepId: z.string().nullable(),
  observedAt: z.string().datetime(),
  /** Copied from the declaration so the result reads on its own. */
  description: z.string(),
});
export type OutcomeObservation = z.infer<typeof OutcomeObservationSchema>;

export const RecoveryEventSchema = z.object({
  outcomeCode: z.string(),
  atStepId: z.string().nullable(),
  action: z.enum(["dismiss", "reauthenticate", "wait", "retryStep", "escalate"]),
  attempt: z.number().int().min(1),
  succeeded: z.boolean(),
  at: z.string().datetime(),
});
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>;

/* ─────────────────────────── failure ─────────────────────────── */

export const FailureCauseSchema = z.enum([
  /** Every rung of the ladder failed. */
  "TARGET_NOT_FOUND",
  /** The action ran but the expected state never arrived. */
  "CHECKPOINT_NOT_MET",
  /** Found the value, could not turn it into the declared type. */
  "COERCION_FAILED",
  /** A display value the extraction's map does not cover. */
  "UNMAPPED_ENUM_VALUE",
  /** Matched an outcome declared as hard_failure. */
  "DECLARED_HARD_FAILURE",
  /** A recoverable condition fired past maxAttempts, or past maxRecoveries. */
  "RECOVERY_EXHAUSTED",
  /** Wall clock or per-step budget. */
  "BUDGET_EXCEEDED",
  /** The allowlist refused an action. */
  "POLICY_VIOLATION",
  /** Not authenticated, wrong role, or app version outside the declared range. */
  "PRECONDITION_FAILED",
  /** Draft capability, or inputs or outputs failing their schema. */
  "CONTRACT_VIOLATION",
  /** The surface itself broke. */
  "SURFACE_UNAVAILABLE",
]);
export type FailureCause = z.infer<typeof FailureCauseSchema>;

/** `expected` and `observed` are rendered for a human to read directly. */
export const FailureDetailSchema = z.object({
  cause: FailureCauseSchema,
  /** Declared outcome code when one matched, else null. */
  code: z.string().nullable(),
  stepId: z.string().nullable(),
  stepIntent: z.string().nullable(),
  expected: z.string(),
  observed: z.string(),
  message: z.string(),
  /** Path under evidence/ to the screenshot and accessibility dump. */
  snapshotRef: z.string().nullable(),
});
export type FailureDetail = z.infer<typeof FailureDetailSchema>;

/* ─────────────────────────── escalation ─────────────────────────── */

/** Raised when a recoverable outcome's recovery action is `escalate`. */
export const EscalationSchema = z.object({
  escalationId: z.string(),
  reason: z.string(),
  requiredRole: z.string(),
  raisedAtStepId: z.string().nullable(),
  /** Step to continue at after handback. */
  resumeFrom: z.string(),
  raisedAt: z.string().datetime(),
  /** Addresses the live session the automation is already using. */
  sessionRef: z.string(),
  /** Screenshot and accessibility dump at the moment control was offered. */
  contextRef: z.string().nullable(),

  /** Filled in on handback; absent while the run is still suspended. */
  resolution: z
    .object({
      resolvedAt: z.string().datetime(),
      resolvedBy: z.string(),
      disposition: z.enum(["resume", "abort"]),
      /** Captured from the live session while the person held control. */
      humanActions: z.array(
        z.object({
          at: z.string().datetime(),
          kind: z.string(),
          summary: z.string(),
        }),
      ),
      note: z.string().optional(),
    })
    .optional(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

/* ─────────────────────────── the result ─────────────────────────── */

const resultCommon = {
  runId: z.string(),
  capability: z.object({ id: z.string(), version: z.string() }),
  tenantId: z.string(),

  /** Echoed for correlation. The evidence writer redacts before persisting. */
  inputs: z.record(z.unknown()),

  /** `artifact` means no model took part in any decision. */
  decisionSource: z.enum(["artifact", "artifact+assisted"]).default("artifact"),

  budget: RunBudgetSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),

  steps: z.array(StepReportSchema),
  /** Everything detected, including conditions that were recovered from. */
  observedOutcomes: z.array(OutcomeObservationSchema).default([]),
  recoveries: z.array(RecoveryEventSchema).default([]),

  /** Directory under evidence/replay/ holding the log and snapshots. */
  evidenceRef: z.string(),
};

export const ReplayResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    /** Validated against the capability's `outputs` schema before returning. */
    outputs: z.record(z.unknown()),
    ...resultCommon,
  }),
  z.object({
    status: z.literal("halted"),
    /** The business outcome that stopped the run. */
    outcome: OutcomeObservationSchema,
    /** Non-null when the halting outcome came after the extractions. */
    outputs: z.record(z.unknown()).nullable(),
    ...resultCommon,
  }),
  z.object({
    status: z.literal("suspended"),
    escalation: EscalationSchema,
    ...resultCommon,
  }),
  z.object({
    status: z.literal("failed"),
    failure: FailureDetailSchema,
    ...resultCommon,
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

/** One-line rendering of a result, for logs and messages. */
export function summarize(result: ReplayResult): string {
  const head = `${result.capability.id}@${result.capability.version} [${result.tenantId}]`;
  switch (result.status) {
    case "succeeded":
      return `${head} succeeded in ${result.durationMs}ms`;
    case "halted":
      return `${head} halted: ${result.outcome.code} — ${result.outcome.description}`;
    case "suspended":
      return `${head} suspended awaiting ${result.escalation.requiredRole}: ${result.escalation.reason}`;
    case "failed":
      return `${head} failed at ${result.failure.stepId ?? "<no step>"} (${result.failure.cause}): ${result.failure.message}`;
  }
}
