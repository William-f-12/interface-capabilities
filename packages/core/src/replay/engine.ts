/**
 * The replay engine: it runs a capability and nothing else.
 *
 * No model takes part in any decision here. Every branch the engine can take is
 * one the artifact or the tenant profile declared in advance, which is what
 * makes a replay reproducible and what makes its result trustworthy enough to
 * hand back to a calling agent.
 *
 * The ordering that matters most: after a step acts, declared conditions are
 * read *before* a missing checkpoint is called a failure. A timed-out session
 * and a screen that never loaded look identical to a checkpoint — but only one
 * of them has a recovery, and only one of them is worth reporting as "the flow
 * broke".
 */

import { describeAssertion, describeLocator, describeTarget } from "../artifact/describe.js";
import type { Capability, Outcome, Step } from "../artifact/schema.js";
import type { TenantConfig } from "../artifact/tenant.js";
import { holds } from "../surface/assert.js";
import { resolveWhenReady } from "../surface/resolve.js";
import { render, type BindingContext } from "../surface/template.js";
import { renderObservation, type ElementRef, type Surface } from "../surface/types.js";
import { tenantSignIn, type SignIn } from "./authenticate.js";
import { coerce } from "./coerce.js";
import { checkOutputs, checkPreconditions } from "./preconditions.js";
import {
  ReplayResultSchema,
  RunBudgetSchema,
  type Escalation,
  type FailureCause,
  type FailureDetail,
  type OutcomeObservation,
  type RecoveryEvent,
  type ReplayResult,
  type Resolution,
  type RunBudget,
  type StepReport,
} from "./contract.js";

const POLL_MS = 200;

/** How much of the screen a failure report carries as `observed`. */
const OBSERVED_CHARS = 800;

/**
 * When several declared conditions hold at once, the most consequential reading
 * wins. A broken application makes everything else on the screen untrustworthy,
 * and a condition worth recovering from should be cleared before whatever is
 * underneath it is read as an answer.
 */
const PRECEDENCE = { hard_failure: 0, recoverable: 1, business_outcome: 2 } as const;

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ReplayRequest {
  capability: Capability;
  tenant: TenantConfig;
  inputs: Record<string, unknown>;
  surface: Surface;
  budget?: Partial<RunBudget>;
  runId?: string;
  evidenceRef?: string;
  /** Overridden in tests, and by a caller holding a session of its own. */
  signIn?: SignIn;
  /** Overridden so a test can run a whole flow without waiting for it. */
  clock?: Clock;
}

/** What one pass of a step decided about the run. */
type Verdict =
  | { kind: "next" }
  | { kind: "retry" }
  | { kind: "restart" }
  | { kind: "halt"; outcome: OutcomeObservation }
  | { kind: "suspend"; escalation: Escalation }
  | { kind: "fail"; failure: FailureDetail };

/** What a finished pass of a step decided. A retry never escapes the step. */
type StepVerdict = Exclude<Verdict, { kind: "retry" }>;

interface Detected {
  outcome: Outcome;
  origin: "capability" | "ambient";
}

/**
 * The flow this tenant actually runs: the capability's steps, with the tenant's
 * insertions placed and its target overrides applied.
 */
function effectiveSteps(capability: Capability, tenant: TenantConfig): Step[] {
  const steps = [...capability.steps];

  for (const insertion of tenant.stepInsertions) {
    if (insertion.capabilityId !== capability.id) continue;
    const at = steps.findIndex((s) => s.id === insertion.beforeStepId);
    if (at >= 0) steps.splice(at, 0, insertion.step);
  }

  return steps.map((step) => {
    const override = tenant.targetOverrides[`${capability.id}#${step.id}`];
    return override ? { ...step, target: override } : step;
  });
}

function needsTarget(step: Step): boolean {
  return ["click", "type", "select"].includes(step.action.type);
}

/**
 * Whether a detected condition answers the question "has this step landed yet?".
 *
 * A business outcome that says `continue` is worth recording but is not such an
 * answer: the flow still has work to do and still expects its checkpoint. Left
 * out, a condition that renders a moment before the screen it sits on would end
 * the wait early and report a checkpoint that was merely still on its way.
 */
function settlesTheStep(detected: Detected): boolean {
  return detected.outcome.kind !== "business_outcome" || detected.outcome.onDetect === "halt";
}

export async function replay(request: ReplayRequest): Promise<ReplayResult> {
  const { capability, tenant, inputs, surface } = request;
  const clock = request.clock ?? systemClock;
  const budget = RunBudgetSchema.parse(request.budget ?? {});
  const ctx: BindingContext = { inputs };

  const startedAt = clock.now();
  const deadline = startedAt.getTime() + budget.wallClockMs;
  // Compact and path-safe, because a run id names the directory its evidence
  // lands in: member.lookup_savings_balance-20260911T052110Z
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = request.runId ?? `${capability.id}-${stamp}`;
  const evidenceRef = request.evidenceRef ?? `replay/${runId}`;
  const signIn = request.signIn ?? tenantSignIn(surface, tenant);

  const stepReports: StepReport[] = [];
  const observedOutcomes: OutcomeObservation[] = [];
  const recoveries: RecoveryEvent[] = [];
  const outputs: Record<string, unknown> = {};
  const attemptsByCode = new Map<string, number>();
  let recoveryCount = 0;

  /* ── reporting ─────────────────────────────────────────────────────────── */

  async function describeScreen(): Promise<string> {
    try {
      return renderObservation(await surface.observe(), OBSERVED_CHARS);
    } catch (err) {
      return `the surface could not be observed: ${String(err)}`;
    }
  }

  async function failureAt(
    step: Step | null,
    cause: FailureCause,
    code: string | null,
    expected: string,
    message: string,
  ): Promise<FailureDetail> {
    return {
      cause,
      code,
      stepId: step?.id ?? null,
      stepIntent: step?.intent ?? null,
      expected,
      observed: await describeScreen(),
      message,
      snapshotRef: null,
    };
  }

  function common() {
    const finishedAt = clock.now();
    return {
      runId,
      capability: { id: capability.id, version: capability.version },
      tenantId: tenant.tenantId,
      inputs,
      decisionSource: "artifact" as const,
      budget,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      steps: stepReports,
      observedOutcomes,
      recoveries,
      evidenceRef,
    };
  }

  /** The engine is held to the same contract it publishes to its callers. */
  function settleResult(result: unknown): ReplayResult {
    return ReplayResultSchema.parse(result);
  }

  function failed(failure: FailureDetail): ReplayResult {
    return settleResult({ status: "failed", failure, ...common() });
  }

  /* ── detecting ─────────────────────────────────────────────────────────── */

  async function detect(step: Step): Promise<Detected[]> {
    const found: Detected[] = [];

    for (const outcome of capability.outcomes) {
      if (outcome.after !== step.id) continue;
      if (await holds(surface, outcome.detect, ctx)) {
        found.push({ outcome, origin: "capability" });
      }
    }

    // An ambient condition can render anywhere: a timeout replaces the whole
    // document, a notice opens over whichever frame had focus.
    for (const outcome of tenant.ambientOutcomes) {
      if (await holds(surface, outcome.detect, ctx, { anyFrame: true })) {
        found.push({ outcome, origin: "ambient" });
      }
    }

    // Sorting is stable, so a capability's own reading stays ahead of the
    // tenant's global one when the two are equally consequential.
    return found.sort((a, b) => PRECEDENCE[a.outcome.kind] - PRECEDENCE[b.outcome.kind]);
  }

  /**
   * Waits for the step to reach a state worth judging: its checkpoint holding,
   * or a declared condition appearing, or the per-step budget running out.
   */
  async function settle(step: Step): Promise<{ met: boolean | null; detected: Detected[] }> {
    const until = clock.now().getTime() + budget.perStepMs;
    for (;;) {
      if (step.checkpoint && (await holds(surface, step.checkpoint, ctx))) {
        // A met checkpoint does not end the question: a search that found
        // nobody satisfies its checkpoint and is still a business outcome.
        return { met: true, detected: await detect(step) };
      }

      const detected = await detect(step);
      if (detected.some(settlesTheStep)) return { met: step.checkpoint ? false : null, detected };
      if (!step.checkpoint) return { met: null, detected };
      if (clock.now().getTime() >= until) return { met: false, detected };
      await clock.sleep(POLL_MS);
    }
  }

  function record(detected: Detected, step: Step): OutcomeObservation {
    const observation: OutcomeObservation = {
      code: detected.outcome.code,
      kind: detected.outcome.kind,
      origin: detected.origin,
      atStepId: step.id,
      observedAt: clock.now().toISOString(),
      description: detected.outcome.description,
    };
    observedOutcomes.push(observation);
    return observation;
  }

  /* ── recovering ────────────────────────────────────────────────────────── */

  async function recover(detected: Detected, step: Step): Promise<Verdict> {
    const outcome = detected.outcome;
    const recovery = outcome.recover;
    if (!recovery) {
      return {
        kind: "fail",
        failure: await failureAt(
          step,
          "CONTRACT_VIOLATION",
          outcome.code,
          "a recoverable outcome to declare how to recover",
          `${outcome.code} is recoverable but declares no recovery action.`,
        ),
      };
    }

    const attempt = (attemptsByCode.get(outcome.code) ?? 0) + 1;
    attemptsByCode.set(outcome.code, attempt);

    if (attempt > outcome.maxAttempts || recoveryCount >= budget.maxRecoveries) {
      return {
        kind: "fail",
        failure: await failureAt(
          step,
          "RECOVERY_EXHAUSTED",
          outcome.code,
          `${outcome.code} to clear within ${outcome.maxAttempts} attempt(s)`,
          `${outcome.code} fired again at ${step.id}; the run has already recovered ${recoveryCount} time(s).`,
        ),
      };
    }
    recoveryCount += 1;

    let succeeded = false;
    let detail = "";
    let verdict: Verdict = { kind: "retry" };

    switch (recovery.action) {
      case "dismiss": {
        const control = await resolveWhenReady(surface, recovery.target, ctx, budget.perStepMs, {
          anyFrame: true,
        });
        if (control) {
          await surface.click(control.ref);
          succeeded = true;
        } else {
          detail = `no control matching ${describeTarget(recovery.target)}`;
        }
        break;
      }

      case "wait":
        await clock.sleep(recovery.ms);
        succeeded = true;
        break;

      case "retryStep":
        succeeded = true;
        break;

      case "reauthenticate": {
        const result = await signIn(capability.preconditions.role);
        succeeded = result.ok;
        if (!result.ok) detail = result.reason;
        // A flow half-finished under a session that has since died cannot be
        // assumed to have left anything behind, so it starts over.
        else if (recovery.restartFromStart) verdict = { kind: "restart" };
        break;
      }

      case "escalate":
        succeeded = true;
        verdict = {
          kind: "suspend",
          escalation: {
            escalationId: `${runId}#${outcome.code}`,
            reason: recovery.reason,
            requiredRole: recovery.requiredRole,
            raisedAtStepId: step.id,
            resumeFrom: recovery.resumeFrom,
            raisedAt: clock.now().toISOString(),
            // The person takes over the session this run is already holding.
            sessionRef: runId,
            contextRef: null,
          },
        };
        break;
    }

    recoveries.push({
      outcomeCode: outcome.code,
      atStepId: step.id,
      action: recovery.action,
      attempt,
      succeeded,
      at: clock.now().toISOString(),
    });

    if (succeeded) return verdict;
    return {
      kind: "fail",
      failure: await failureAt(
        step,
        "RECOVERY_EXHAUSTED",
        outcome.code,
        `the declared ${recovery.action} recovery for ${outcome.code} to work`,
        `${outcome.code} was detected, but recovering from it failed: ${detail || "no detail"}.`,
      ),
    };
  }

  /** Records everything detected, then acts on the most consequential of them. */
  async function judge(detected: Detected[], step: Step): Promise<Verdict | null> {
    if (detected.length === 0) return null;
    const recorded = detected.map((d) => ({ detected: d, observation: record(d, step) }));

    const decisive = recorded[0];
    if (!decisive) return null;

    switch (decisive.detected.outcome.kind) {
      case "hard_failure":
        return {
          kind: "fail",
          failure: await failureAt(
            step,
            "DECLARED_HARD_FAILURE",
            decisive.detected.outcome.code,
            "the flow to continue",
            decisive.detected.outcome.description,
          ),
        };

      case "recoverable":
        return recover(decisive.detected, step);

      case "business_outcome":
        // "continue" means the condition is worth reporting but the flow still
        // has work to do, so the caller gets the outcome and the outputs.
        if (decisive.detected.outcome.onDetect === "halt") {
          return { kind: "halt", outcome: decisive.observation };
        }
        return null;
    }
  }

  /* ── acting ────────────────────────────────────────────────────────────── */

  async function act(step: Step, ref: ElementRef | null): Promise<void> {
    switch (step.action.type) {
      case "click":
        if (ref) await surface.click(ref);
        break;
      case "type":
        if (ref) await surface.fill(ref, render(step.action.value, ctx), step.action.clearFirst);
        break;
      case "select":
        if (ref) await surface.selectOption(ref, render(step.action.value, ctx));
        break;
      case "navigate":
        await surface.navigate(render(step.action.path, ctx));
        break;
      case "press":
        await surface.press(step.action.key);
        break;
    }
  }

  async function extractInto(step: Step): Promise<Extract<Verdict, { kind: "fail" }> | null> {
    for (const extraction of step.extract) {
      const ref = await surface.find(extraction.target, ctx);

      if (!ref) {
        // "null" says the artifact tolerates having no value here at all.
        if (extraction.onCoerceFailure === "null") {
          outputs[extraction.to] = null;
          continue;
        }
        return {
          kind: "fail",
          failure: await failureAt(
            step,
            "TARGET_NOT_FOUND",
            null,
            `${describeLocator(extraction.target)}, to read "${extraction.to}" from`,
            `Step ${step.id} could not find the value it reads into "${extraction.to}".`,
          ),
        };
      }

      const raw = await surface.textOf(ref);
      const result = coerce(raw, extraction.coerce);
      if (result.ok) {
        outputs[extraction.to] = result.value;
        continue;
      }
      if (extraction.onCoerceFailure === "null") {
        outputs[extraction.to] = null;
        continue;
      }
      return {
        kind: "fail",
        failure: {
          ...(await failureAt(
            step,
            result.cause,
            null,
            result.expected,
            `Reading "${extraction.to}" at step ${step.id} found text that is not what the contract promises.`,
          )),
          // The offending text is the whole story here; a screen dump is noise.
          observed: raw,
        },
      };
    }
    return null;
  }

  /* ── one step ──────────────────────────────────────────────────────────── */

  async function runStep(step: Step): Promise<StepVerdict> {
    const stepStartedAt = clock.now();
    let attempts = 0;
    let resolvedBy: Resolution | null = null;
    let checkpointMet: boolean | null = null;

    const report = (status: "ok" | "failed"): void => {
      stepReports.push({
        stepId: step.id,
        intent: step.intent,
        status,
        startedAt: stepStartedAt.toISOString(),
        durationMs: Math.max(0, clock.now().getTime() - stepStartedAt.getTime()),
        resolvedBy,
        checkpointMet,
        attempts,
      });
    };

    for (;;) {
      attempts += 1;

      if (clock.now().getTime() >= deadline) {
        report("failed");
        return {
          kind: "fail",
          failure: await failureAt(
            step,
            "BUDGET_EXCEEDED",
            null,
            `the run to finish within ${budget.wallClockMs}ms`,
            `The wall-clock budget ran out at step ${step.id}.`,
          ),
        };
      }

      let ref: ElementRef | null = null;

      if (needsTarget(step)) {
        const target = step.target;
        if (!target) {
          report("failed");
          return {
            kind: "fail",
            failure: await failureAt(
              step,
              "CONTRACT_VIOLATION",
              null,
              `a target for a ${step.action.type} step`,
              `Step ${step.id} is a ${step.action.type} with nothing to act on.`,
            ),
          };
        }

        const resolved = await resolveWhenReady(surface, target, ctx, budget.perStepMs);
        if (!resolved) {
          // A declared condition explains an absent control better than "not
          // found" does: on a timed-out session the control is genuinely gone.
          const verdict = await judge(await detect(step), step);
          if (verdict?.kind === "retry") continue;
          report("failed");
          return (
            verdict ?? {
              kind: "fail",
              failure: await failureAt(
                step,
                "TARGET_NOT_FOUND",
                null,
                describeTarget(target),
                `No rung of the ladder for step ${step.id} resolved.`,
              ),
            }
          );
        }
        resolvedBy = resolved.resolution;
        ref = resolved.ref;
      }

      await act(step, ref);

      const settled = await settle(step);
      checkpointMet = settled.met;

      const verdict = await judge(settled.detected, step);
      if (verdict) {
        if (verdict.kind === "retry") continue;
        report(verdict.kind === "halt" && checkpointMet !== false ? "ok" : "failed");
        return verdict;
      }

      if (checkpointMet === false) {
        report("failed");
        return {
          kind: "fail",
          failure: await failureAt(
            step,
            "CHECKPOINT_NOT_MET",
            null,
            step.checkpoint ? describeAssertion(step.checkpoint) : "the step to land",
            `Step ${step.id} acted, but the state it expects never arrived.`,
          ),
        };
      }

      const extracted = await extractInto(step);
      if (extracted) {
        report("failed");
        return extracted;
      }

      report("ok");
      return { kind: "next" };
    }
  }

  /* ── the run ───────────────────────────────────────────────────────────── */

  const steps = effectiveSteps(capability, tenant);

  function skipFrom(index: number): void {
    for (const step of steps.slice(index)) {
      stepReports.push({
        stepId: step.id,
        intent: step.intent,
        status: "skipped",
        startedAt: clock.now().toISOString(),
        durationMs: 0,
        resolvedBy: null,
        checkpointMet: null,
        attempts: 0,
      });
    }
  }

  async function run(): Promise<ReplayResult> {
    const refusal = checkPreconditions(capability, tenant, inputs);
    if (refusal) {
      skipFrom(0);
      return failed(refusal);
    }

    if (capability.preconditions.authenticated && !(await holds(surface, tenant.auth.signedIn, ctx))) {
      const session = await signIn(capability.preconditions.role);
      if (!session.ok) {
        skipFrom(0);
        return failed({
          cause: "PRECONDITION_FAILED",
          code: null,
          stepId: null,
          stepIntent: null,
          expected: `a signed-in session on ${tenant.tenantId}`,
          observed: session.reason,
          message: "This capability requires a session and one could not be established.",
          snapshotRef: null,
        });
      }
    }

    let index = 0;
    while (index < steps.length) {
      const step = steps[index];
      if (!step) break;

      const verdict = await runStep(step);

      if (verdict.kind === "next") {
        index += 1;
        continue;
      }
      if (verdict.kind === "restart") {
        // A restart re-reads everything, so values from the abandoned pass
        // must not survive into the result.
        for (const key of Object.keys(outputs)) delete outputs[key];
        index = 0;
        continue;
      }

      skipFrom(index + 1);
      if (verdict.kind === "halt") {
        return settleResult({
          status: "halted",
          outcome: verdict.outcome,
          outputs: Object.keys(outputs).length > 0 ? outputs : null,
          ...common(),
        });
      }
      if (verdict.kind === "suspend") {
        return settleResult({ status: "suspended", escalation: verdict.escalation, ...common() });
      }
      return failed(verdict.failure);
    }

    const finalState = capability.successCondition.finalState;
    if (finalState && !(await holds(surface, finalState, ctx))) {
      return failed(
        await failureAt(
          null,
          "CHECKPOINT_NOT_MET",
          null,
          describeAssertion(finalState),
          "Every step ran, but the state the capability calls success is not the state on screen.",
        ),
      );
    }

    const broken = checkOutputs(capability, outputs);
    if (broken) return failed(broken);

    return settleResult({ status: "succeeded", outputs, ...common() });
  }

  try {
    return await run();
  } catch (err) {
    // The surface itself broke. A caller gets a result, never an exception.
    return failed({
      cause: "SURFACE_UNAVAILABLE",
      code: null,
      stepId: null,
      stepIntent: null,
      expected: "a surface that answers",
      observed: String(err),
      message: "The run stopped because the surface became unusable.",
      snapshotRef: null,
    });
  }
}
