/**
 * The discovery loop: observe, decide, act, check what was predicted.
 *
 * The model decides; the loop holds it to account. Everything here exists to
 * make a run finite and its output trustworthy:
 *
 *   - An action becomes part of the recorded flow only once the state the model
 *     said would follow actually arrived. A guess that did not pan out is
 *     feedback for the next turn and stays in the trace, but it is not a step.
 *   - Every way a run can stop has a name, and a run that stops for a reason
 *     other than reaching its goal produces no artifact at all.
 *   - A wrong action is data, not an exception: a locator that matches nothing,
 *     an action the schema refuses, a template naming an input that was never
 *     supplied. Each one goes back to the model as a sentence.
 *
 * The replay engine is untouched by any of this. Discovery borrows its
 * assertion evaluator and its locator vocabulary and gives nothing back.
 */

import type { Capability } from "../artifact/schema.js";
import type { TenantConfig } from "../artifact/tenant.js";
import { waitUntil } from "../surface/assert.js";
import { MissingInputError, render, type BindingContext } from "../surface/template.js";
import type { ElementRef, Observation, Surface } from "../surface/types.js";
import type { ElementLocator } from "../artifact/schema.js";
import type { Clock } from "../replay/engine.js";
import {
  ACTION_TOOLS,
  AgentActionSchema,
  locatesItselfBy,
  type AgentAction,
} from "./actions.js";
import {
  type DiscoveryBudget,
  DiscoveryBudgetSchema,
  type DiscoveryResult,
  DiscoveryResultSchema,
  type StopReason,
} from "./budget.js";
import type { Model } from "./model.js";
import { systemPrompt, turnPrompt, type Turn } from "./prompt.js";
import type { TraceEvent, TraceSink } from "./trace.js";

const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One action that earned its place in the flow. */
export interface RecordedStep {
  action: AgentAction;
  /** For a `read`, the text that was on screen. Kept so a reviewer can see it. */
  text?: string;
}

export interface DiscoverRequest {
  /** The contract being recorded. Its steps, if any, are ignored. */
  contract: Capability;
  tenant: TenantConfig;
  inputs: Record<string, unknown>;
  goal: string;
  surface: Surface;
  model: Model;
  budget?: Partial<DiscoveryBudget>;
  trace?: TraceSink;
  /**
   * Called with each screen as it is perceived. The loop keeps no filesystem of
   * its own; whoever wants the screens on disk writes them here.
   */
  onObservation?: (seq: number, observation: Observation) => Promise<void>;
  runId?: string;
  /** Overridden so a test can run a whole loop without waiting for it. */
  clock?: Clock;
}

export interface DiscoverOutcome {
  result: DiscoveryResult;
  /** The flow that was found, in order. Empty unless the goal was reached. */
  steps: RecordedStep[];
}

/** A path the tenant's own application would serve. */
function withinApplication(path: string, baseUrl: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(path)) return true;
  return path.startsWith(baseUrl.replace(/\/$/, ""));
}

export async function discover(request: DiscoverRequest): Promise<DiscoverOutcome> {
  const { contract, tenant, inputs, surface, model } = request;
  const clock = request.clock ?? systemClock;
  const budget = DiscoveryBudgetSchema.parse(request.budget ?? {});
  const ctx: BindingContext = { inputs };

  const startedAt = clock.now();
  const deadline = startedAt.getTime() + budget.wallClockMs;
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = request.runId ?? `${contract.id}-${stamp}`;

  const steps: RecordedStep[] = [];
  const turns: Turn[] = [];
  let tokensUsed = 0;
  let stepsTaken = 0;
  let noProgress = 0;
  let silentTurns = 0;

  function record(event: TraceEvent): void {
    request.trace?.write(event);
  }

  function remainingMs(): number {
    return Math.max(0, deadline - clock.now().getTime());
  }

  record({
    kind: "run_started",
    at: startedAt.toISOString(),
    runId,
    goal: request.goal,
    capabilityId: contract.id,
    tenantId: tenant.tenantId,
    model: model.name,
    inputs,
  });

  /**
   * Everything a turn can conclude, so the loop body reads as one decision.
   *
   * `kept` and `feedback` are not exclusive: an action can belong in the flow
   * and still have told the model something it got wrong.
   */
  type TurnResult =
    | { stop: StopReason }
    | { feedback: string }
    | { kept: RecordedStep; feedback?: string }
    | null;

  /**
   * The same action with its prediction dropped.
   *
   * A prediction that did not come true must not become a checkpoint — that
   * would be a step asserting a state that never arrives — but the action it
   * was attached to still ran, so it stays.
   */
  function withoutExpectation(action: AgentAction): AgentAction {
    const { expect: _dropped, ...rest } = action as AgentAction & { expect?: unknown };
    return rest as AgentAction;
  }

  /** Frame paths on the screen as it was last perceived. */
  let framePaths: string[][] = [];

  /**
   * Where a locator would have matched, had it looked in the right frame.
   *
   * A frameset is the one thing about these applications a model cannot infer
   * from a control: the nav link and the results table look alike in an
   * accessibility tree and live in different documents. "Nothing matched" sends
   * it guessing; naming the frame it should have looked in is a correction it
   * can act on in one turn, and the surface already knows the answer.
   */
  async function elsewhere(locator: ElementLocator): Promise<string[] | null> {
    for (const path of framePaths) {
      if (JSON.stringify(path) === JSON.stringify(locator.framePath)) continue;
      const found = await surface.find({ ...locator, framePath: path }, ctx).catch(() => null);
      if (found) return path;
    }
    return null;
  }

  function nameOf(path: string[]): string {
    return path.length === 0 ? "the top-level document" : `frame ${path.join(" > ")}`;
  }

  async function missed(locator: ElementLocator, what: string): Promise<string> {
    const found = await elsewhere(locator);
    if (!found) return `${what}, and nothing matching it is anywhere else on the screen either`;
    return (
      `${what} in ${nameOf(locator.framePath)} — but it is in ${nameOf(found)}. ` +
      `Set framePath to ${JSON.stringify(found)}.`
    );
  }

  async function take(action: AgentAction, seq: number): Promise<TurnResult> {
    if (action.kind === "done") return { stop: "goal_reached" };
    if (action.kind === "abandon") return { stop: "agent_abandoned" };

    if (action.kind === "navigate" && !withinApplication(action.path, tenant.baseUrl)) {
      record({
        kind: "acted",
        at: clock.now().toISOString(),
        seq,
        ok: false,
        detail: `refused: ${action.path} is outside ${tenant.baseUrl}`,
      });
      return { stop: "policy_violation" };
    }

    // A locator that matches nothing, or one naming an input nobody supplied,
    // is the model being wrong about the screen — which is its to correct.
    let ref: ElementRef | null = null;
    if ("target" in action) {
      try {
        ref = await surface.find(action.target, ctx);
      } catch (err) {
        if (!(err instanceof MissingInputError)) throw err;
        return { feedback: `that locator names an input nobody supplied: ${err.inputName}` };
      }
      if (!ref) {
        const feedback = await missed(action.target, "nothing matched that locator");
        record({ kind: "acted", at: clock.now().toISOString(), seq, ok: false, detail: feedback });
        return { feedback };
      }
    }

    if (action.kind === "read") {
      const text = (await surface.textOf(ref as ElementRef)).trim();

      // A locator that quotes the value it is reading resolves for this run and
      // for no other. Caught here rather than at compile time, the model gets to
      // fix it while it is still looking at the screen.
      if (locatesItselfBy(action.target, text)) {
        const feedback =
          `that locator finds "${text}" by quoting "${text}", so it would only ever work for ` +
          `this one record. Locate it by something that does not change with the data: its ` +
          `label, its column header, or a row identified by one of the supplied inputs.`;
        record({ kind: "acted", at: clock.now().toISOString(), seq, ok: false, detail: feedback });
        return { feedback };
      }

      record({ kind: "acted", at: clock.now().toISOString(), seq, ok: true, detail: `read "${text}"` });
      return { kept: { action, text } };
    }

    try {
      await act(action, ref);
    } catch (err) {
      if (err instanceof MissingInputError) {
        return { feedback: `that value names an input nobody supplied: ${err.inputName}` };
      }
      record({
        kind: "acted",
        at: clock.now().toISOString(),
        seq,
        ok: false,
        detail: `the surface refused it: ${String(err)}`,
      });
      return { feedback: `the surface could not do that: ${String(err)}` };
    }
    record({ kind: "acted", at: clock.now().toISOString(), seq, ok: true, detail: "done" });

    if (!action.expect) return { kept: { action } };

    // Never wait past the run's own deadline; a single patient wait would
    // otherwise spend a budget meant for the whole exploration.
    const held = await waitUntil(surface, action.expect, ctx, {
      timeoutMs: Math.min(budget.expectMs, remainingMs()),
    });
    record({
      kind: "expectation",
      at: clock.now().toISOString(),
      seq,
      held,
      expected: action.expect,
    });
    if (!held) {
      // The action ran and moved the screen; only the guess about what would
      // follow was wrong. Dropping it here would leave a flow that skips a step
      // everything after it depends on — which is how a run can reach its goal
      // and still compile to something that cannot be replayed.
      return {
        kept: { action: withoutExpectation(action) },
        feedback: await missed(action.expect, "the state you expected did not arrive"),
      };
    }
    return { kept: { action } };
  }

  /**
   * Values are interpolated here exactly as the replay engine interpolates
   * them.
   *
   * A model that answers `{{inputs.member_id}}` is doing the right thing — it
   * is writing a step that works for the next caller rather than for this run.
   * Typed literally, those braces go into the field and the search returns
   * nothing, which is a failure the model cannot diagnose from the screen and
   * would be right to find baffling. The rule is that the agent's world and the
   * replay world are the same world; this is part of keeping that true.
   */
  async function act(action: AgentAction, ref: ElementRef | null): Promise<void> {
    switch (action.kind) {
      case "click":
        await surface.click(ref as ElementRef);
        return;
      case "type":
        await surface.fill(ref as ElementRef, render(action.value, ctx), action.clearFirst);
        return;
      case "select":
        await surface.selectOption(ref as ElementRef, render(action.value, ctx));
        return;
      case "press":
        await surface.press(action.key);
        return;
      case "navigate":
        await surface.navigate(render(action.path, ctx));
        return;
      default:
        return;
    }
  }

  function finish(stopReason: StopReason): DiscoverOutcome {
    const finishedAt = clock.now();
    record({
      kind: "run_finished",
      at: finishedAt.toISOString(),
      stopReason,
      stepsTaken,
      tokensUsed,
    });

    const result = DiscoveryResultSchema.parse({
      runId,
      goal: request.goal,
      capabilityId: contract.id,
      tenantId: tenant.tenantId,
      stopReason,
      // Whoever writes the evidence stamps these; the loop invents no paths.
      artifactRef: null,
      traceRef: null,
      model: model.name,
      budget,
      stepsTaken,
      modelTokensUsed: tokensUsed,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    });

    return { result, steps: stopReason === "goal_reached" ? steps : [] };
  }

  for (;;) {
    if (stepsTaken >= budget.maxSteps) return finish("max_steps");
    if (clock.now().getTime() >= deadline) return finish("timeout");
    if (budget.maxModelTokens !== null && tokensUsed >= budget.maxModelTokens) {
      return finish("timeout");
    }

    const seq = stepsTaken + 1;

    let observation;
    try {
      observation = await surface.observe();
    } catch {
      return finish("surface_unavailable");
    }
    framePaths = observation.frames.map((frame) => frame.path);
    const rendered = turnPrompt({
      goal: request.goal,
      contract,
      inputs,
      turns,
      observation,
      budget,
    });
    record({
      kind: "observed",
      at: clock.now().toISOString(),
      seq,
      url: observation.url,
      hash: observation.hash,
      chars: rendered.length,
    });
    // Snapshots are written after the event, so a failure to save one costs a
    // picture rather than the run.
    await request.onObservation?.(seq, observation).catch(() => {});

    const decision = await model.decide({
      system: systemPrompt(),
      prompt: rendered,
      tools: ACTION_TOOLS,
      maxTokens: budget.maxDecisionTokens,
    });
    tokensUsed += decision.tokensUsed;
    stepsTaken += 1;

    const parsed = decision.toolCall
      ? AgentActionSchema.safeParse(decision.toolCall.input)
      : null;
    const action = parsed?.success ? parsed.data : null;
    // Naming the field is the difference between a correction and another
    // guess, so the reason the model is given is the reason a reader gets.
    const reason =
      parsed?.success === false
        ? parsed.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ")
        : "the tool call carried no arguments";

    record({
      kind: "decided",
      at: clock.now().toISOString(),
      seq,
      text: decision.text,
      action,
      ...(decision.toolCall && !action
        ? { rejected: { tool: decision.toolCall.name, input: decision.toolCall.input, reason } }
        : {}),
      tokens: decision.tokensUsed,
    });

    if (!decision.toolCall) {
      // A reasoning model that runs out of output budget mid-thought answers
      // with nothing at all. One of those is a hiccup worth another turn; a
      // second in a row is the model declining, and the run is over.
      silentTurns += 1;
      if (silentTurns >= 2) return finish("agent_abandoned");
      turns.push({ action: null, result: "you answered without calling a tool; call exactly one" });
      continue;
    }
    silentTurns = 0;
    if (!action) {
      turns.push({ action: null, result: `that action was refused — ${reason}` });
      continue;
    }

    const before = observation.hash;
    const outcome = await take(action, seq);

    if (outcome && "stop" in outcome) return finish(outcome.stop);

    if (outcome && "kept" in outcome) {
      steps.push(outcome.kept);
      // Kept, and still told what it got wrong: the flow needs the action, the
      // model needs to know its reading of the screen was off.
      turns.push({ action, result: outcome.feedback ?? "ok" });
    } else {
      turns.push({ action, result: outcome?.feedback ?? "nothing happened" });
    }

    // A screen that does not change after an action is the signature of a run
    // that has stopped getting anywhere, whatever the model believes.
    //
    // A `read` is exempt: it is an observation, not an attempt to move, and it
    // leaves the screen exactly as it found it. Counted, a flow that reads
    // several values would call itself stuck in the middle of succeeding.
    if (action.kind !== "read") {
      const after = await surface.observe().catch(() => null);
      if (after && after.hash === before) {
        noProgress += 1;
        if (noProgress >= budget.maxConsecutiveNoProgress) return finish("dead_end");
      } else {
        noProgress = 0;
      }
    }
  }
}
