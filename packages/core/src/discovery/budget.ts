/** Limits and stop conditions for a discovery run. */

import { z } from "zod";

export const DiscoveryBudgetSchema = z.object({
  /** Ceiling on observe/decide/act iterations. */
  maxSteps: z.number().int().positive().default(40),

  wallClockMs: z.number().int().positive().default(300_000),

  /**
   * Dead-end detection. The observation is hashed after each action; this many
   * consecutive actions that leave the hash unchanged stop the run.
   */
  maxConsecutiveNoProgress: z.number().int().positive().default(3),

  /**
   * Size of the observation handed to the model, after pruning. Counted in
   * tokens, while `renderObservation` is given a character budget — whoever
   * wires the two together converts rather than passing this number straight in.
   */
  maxObservationTokens: z.number().int().positive().default(4_000),

  /**
   * How long the state the model predicted is given to arrive before the
   * prediction is called wrong. Clamped to what is left of the wall clock, so
   * one patient wait cannot carry a run past the budget it was given.
   */
  expectMs: z.number().int().positive().default(4_000),

  /**
   * Output budget for one decision. A reasoning model spends this on thinking
   * before it answers, and one that runs out mid-thought returns nothing at
   * all — an empty turn that costs a step and twenty thousand tokens. Generous
   * on purpose: the ceiling that matters is `maxSteps`, not this.
   */
  maxDecisionTokens: z.number().int().positive().default(8_000),

  /** Whole-run ceiling on model spend. Null disables the check. */
  maxModelTokens: z.number().int().positive().nullable().default(null),
});
export type DiscoveryBudget = z.infer<typeof DiscoveryBudgetSchema>;

/** Why the loop stopped. Only `goal_reached` can produce an artifact. */
export const StopReasonSchema = z.enum([
  "goal_reached",
  "max_steps",
  "timeout",
  "dead_end",
  /** The model tried to act outside the allowlist. */
  "policy_violation",
  /** The agent reached a state only a person may act on. */
  "escalated",
  /** The model reported that it could not proceed. */
  "agent_abandoned",
  "surface_unavailable",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const DiscoveryResultSchema = z.object({
  runId: z.string(),
  goal: z.string(),
  capabilityId: z.string(),
  tenantId: z.string(),

  stopReason: StopReasonSchema,

  /**
   * Path to the artifact distilled from this run, or null. Distillation keeps
   * only the path that worked and lifts concrete values into parameters; the
   * full attempt history stays in the trace.
   */
  artifactRef: z.string().nullable(),

  /** Directory under evidence/discovery/ holding the trace and snapshots. */
  traceRef: z.string().nullable(),

  model: z.string(),
  budget: DiscoveryBudgetSchema,
  stepsTaken: z.number().int().min(0),
  modelTokensUsed: z.number().int().min(0),

  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
});
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;
