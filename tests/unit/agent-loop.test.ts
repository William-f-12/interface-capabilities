/**
 * The observe / decide / act / verify loop.
 *
 * The loop takes no view of its own about what to do — that is the model's job.
 * What it owns is everything that keeps a run honest and finite: an action is
 * only part of the flow once the state the model predicted actually arrived,
 * and a run stops for a reason it can name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { discover, memoryTrace, type AgentAction, type TraceSink } from "@icap/core";
import { ScriptedSurface, testCapability, testTenant } from "../helpers/scripted.js";
import { MalformedModel, ScriptedModel } from "../helpers/scripted-model.js";

const budget = { maxSteps: 8, wallClockMs: 4000, maxConsecutiveNoProgress: 2, expectMs: 150 };

const dom = (selector: string) => ({ kind: "dom" as const, selector, framePath: [] });

function run(
  script: (AgentAction | null)[],
  surface: ScriptedSurface,
  options: { model?: MalformedModel; sink?: TraceSink } = {},
) {
  return discover({
    contract: testCapability(),
    tenant: testTenant(),
    inputs: { query: "100005" },
    goal: "Read the balance",
    surface,
    model: options.model ?? new ScriptedModel(script),
    budget,
    ...(options.sink ? { trace: options.sink } : {}),
    runId: "run-1",
  });
}

/** The screen the agent is meant to find its way across. */
function workingSurface(): ScriptedSurface {
  return new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": "$1,204.50" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#amount");
    },
  });
}

const openIt: AgentAction = {
  kind: "click",
  why: "Open the screen",
  target: dom("#open"),
  expect: dom("#form"),
};
const readIt: AgentAction = {
  kind: "read",
  why: "Read the balance",
  as: "amount",
  target: dom("#amount"),
};
const finish: AgentAction = { kind: "done", why: "The balance is read", summary: "Read a balance" };

test("a flow the agent walks to done is reported as reached, with its steps in order", async () => {
  const outcome = await run([openIt, readIt, finish], workingSurface());

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(outcome.steps.map((step) => step.action.kind), ["click", "read"]);
  assert.equal(outcome.steps[1]?.text, "$1,204.50", "a read keeps what it read");
});

/**
 * Found by a live run: the agent reached its goal and compiled to a flow that
 * skipped the search step, because the steps that did the searching had been
 * dropped for predicting the wrong result. An action that ran changed the
 * screen, and everything after it depends on that.
 */
test("an action that ran stays in the flow even when its prediction was wrong", async () => {
  const { events, sink } = memoryTrace();
  const outcome = await run(
    [{ ...openIt, expect: dom("#never") }, readIt, finish],
    workingSurface(),
    { sink },
  );

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(
    outcome.steps.map((step) => step.action.kind),
    ["click", "read"],
    "the click opened the screen the read depends on",
  );
  assert.equal(
    outcome.steps[0]?.action.kind === "click" && outcome.steps[0].action.expect,
    undefined,
    "but a prediction that never came true must not become a checkpoint",
  );
  assert.ok(events.some((event) => event.kind === "expectation" && !event.held));
});

test("a mispredicted action still tells the model what it got wrong", async () => {
  const model = new ScriptedModel([{ ...openIt, expect: dom("#never") }, readIt, finish]);
  await discover({
    contract: testCapability(),
    tenant: testTenant(),
    inputs: { query: "100005" },
    goal: "Read the balance",
    surface: workingSurface(),
    model,
    budget,
    runId: "run-1",
  });

  const second = model.requests[1]?.prompt ?? "";
  assert.match(second, /did not arrive/, "the next turn has to know the reading was off");
});

/**
 * Found by a live run: asked where the member's name was, the model answered
 * "the text that reads Priya Raman". The artifact compiled, replayed for that
 * member, and would have resolved for no other.
 */
test("a value located by quoting itself is refused, and the model is told why", async () => {
  const model = new ScriptedModel([
    openIt,
    // Narrowing to the row by the very amount the row is there to give.
    {
      kind: "read",
      why: "The balance is in the row showing that amount",
      as: "amount",
      target: {
        kind: "dom",
        selector: "#amount",
        scope: { kind: "row", containingText: "$1,204.50" },
        framePath: [],
      },
    },
    readIt,
    finish,
  ]);

  const outcome = await discover({
    contract: testCapability(),
    tenant: testTenant(),
    inputs: { query: "100005" },
    goal: "Read the balance",
    surface: workingSurface(),
    model,
    budget,
    runId: "run-1",
  });

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(
    outcome.steps.map((step) => step.action.kind),
    ["click", "read"],
    "the self-quoting read is not part of the flow",
  );
  assert.match(model.requests[2]?.prompt ?? "", /only ever work for this one record/);
});

/**
 * Found by a live run: the model typed `{{inputs.member_id}}` — which is the
 * right thing to write, since the step has to work for the next caller — and
 * the fixture searched for those literal braces, found nobody, and left the
 * model staring at a screen it could not explain.
 */
test("a value the model parameterises is interpolated, as the replay engine would", async () => {
  const surface = new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": "$1,204.50" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#amount");
    },
  });
  const outcome = await run(
    [
      openIt,
      {
        kind: "type",
        why: "Type the query the caller supplied",
        value: "{{inputs.query}}",
        clearFirst: true,
        target: dom("#query"),
      },
      readIt,
      finish,
    ],
    surface,
  );

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.ok(
    surface.actions.includes("fill #query=100005"),
    `the field received ${JSON.stringify(surface.actions)}`,
  );
});

test("a value naming an input nobody supplied is fed back, not typed literally", async () => {
  const outcome = await run(
    [
      openIt,
      {
        kind: "type",
        why: "Type something that was never supplied",
        value: "{{inputs.branch}}",
        clearFirst: true,
        target: dom("#query"),
      },
      { kind: "abandon", why: "I was wrong about the inputs", reason: "no such input" },
    ],
    workingSurface(),
  );
  assert.equal(outcome.result.stopReason, "agent_abandoned");
});

test("an action that never ran is not kept, since nothing happened", async () => {
  // The locator matches nothing, so the surface was never touched. This is the
  // trying that an artifact must not contain — as opposed to a step that ran.
  const outcome = await run(
    [
      { kind: "click", why: "Guess at a control", target: dom("#absent"), expect: dom("#form") },
      openIt,
      readIt,
      finish,
    ],
    workingSurface(),
  );

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(
    outcome.steps.map((step) => step.action.kind),
    ["click", "read"],
    "only one click ever happened",
  );
  assert.equal(
    outcome.steps[0]?.action.kind === "click" &&
      outcome.steps[0].action.target.kind === "dom" &&
      outcome.steps[0].action.target.selector,
    "#open",
    "and it was the one that resolved",
  );
});

test("reading several values in a row is not mistaken for a stalled run", async () => {
  // A read leaves the screen exactly as it found it, so counting reads as
  // no-progress would end a flow in the middle of succeeding.
  const surface = new ScriptedSurface({
    facts: ["#open"],
    text: { "#amount": "$1,204.50", "#status": "Active" },
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#amount").add("#status");
    },
  });
  const outcome = await run(
    [
      openIt,
      readIt,
      { kind: "read", why: "Read the status", as: "status", target: dom("#status") },
      finish,
    ],
    surface,
  );

  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(outcome.steps.map((step) => step.action.kind), ["click", "read", "read"]);
});

test("an abandoned run hands back no flow at all, however far it got", async () => {
  const outcome = await run(
    [openIt, { kind: "abandon", why: "The balance is not on this screen", reason: "not here" }],
    workingSurface(),
  );
  assert.equal(outcome.result.stopReason, "agent_abandoned");
  assert.deepEqual(outcome.steps, [], "a flow is only produced by a run that reached its goal");
});

test("an action with no expectation is kept, since there was nothing to disprove", async () => {
  const outcome = await run(
    [
      { kind: "click", why: "Open the screen", target: dom("#open") },
      readIt,
      finish,
    ],
    workingSurface(),
  );
  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.equal(outcome.steps.length, 2);
});

test("a target the agent invented is reported back to it, not thrown", async () => {
  const outcome = await run(
    [
      { kind: "click", why: "Click the thing", target: dom("#absent"), expect: dom("#x") },
      { kind: "abandon", why: "Nothing here", reason: "dead end" },
    ],
    new ScriptedSurface({ facts: [] }),
  );
  assert.equal(outcome.result.stopReason, "agent_abandoned");
  assert.deepEqual(outcome.steps, []);
});

test("an action the schema refuses is fed back rather than ending the run", async () => {
  const surface = workingSurface();
  const model = new MalformedModel(new ScriptedModel([openIt, readIt, finish]));
  const outcome = await run([], surface, { model });

  assert.equal(outcome.result.stopReason, "goal_reached", "the run recovered from a bad action");
  assert.deepEqual(outcome.steps.map((step) => step.action.kind), ["click", "read"]);
});

test("the step ceiling stops a loop that would otherwise keep going", async () => {
  let n = 0;
  // Every action changes the screen, so this is a live loop rather than a dead end.
  const surface = new ScriptedSurface({
    facts: ["#open"],
    onAction: (_entry, facts) => {
      n += 1;
      facts.add(`#fact${n}`);
    },
  });
  const forever: AgentAction[] = Array.from({ length: 20 }, () => ({
    kind: "press",
    why: "Try again",
    key: "Enter",
  }));

  const outcome = await run(forever, surface);
  assert.equal(outcome.result.stopReason, "max_steps");
  assert.ok(outcome.result.stepsTaken <= 8, `took ${outcome.result.stepsTaken} steps`);
});

test("a screen that stops changing ends the run rather than burning the budget", async () => {
  const outcome = await run(
    Array.from({ length: 6 }, () => ({ kind: "press", why: "Nothing changes", key: "Enter" })),
    new ScriptedSurface({ facts: ["#open"] }),
  );
  assert.equal(outcome.result.stopReason, "dead_end");
});

test("one answer with no tool call is a hiccup, not the end of the run", async () => {
  // A reasoning model that spends its output budget thinking answers with
  // nothing. Ending there would throw away a run over a single empty turn.
  const outcome = await run([null, openIt, readIt, finish], workingSurface());
  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(outcome.steps.map((step) => step.action.kind), ["click", "read"]);
});

test("a model that keeps suggesting nothing ends the run instead of spinning", async () => {
  const outcome = await run([null, null], workingSurface());
  assert.equal(outcome.result.stopReason, "agent_abandoned");
  assert.equal(outcome.result.stepsTaken, 2, "it did not spend the whole ceiling finding out");
});

test("navigating off the tenant's own application is refused", async () => {
  const outcome = await run(
    [{ kind: "navigate", why: "Look it up elsewhere", path: "https://example.com/" }],
    new ScriptedSurface({ facts: [] }),
  );
  assert.equal(outcome.result.stopReason, "policy_violation");
  assert.deepEqual(outcome.steps, []);
});

test("a path inside the application is allowed", async () => {
  const surface = new ScriptedSurface({
    facts: [],
    onAction: (entry, facts) => {
      if (entry === "navigate /search") facts.add("#form");
    },
  });
  const outcome = await run(
    [{ kind: "navigate", why: "Go to search", path: "/search", expect: dom("#form") }, finish],
    surface,
  );
  assert.equal(outcome.result.stopReason, "goal_reached");
  assert.deepEqual(outcome.steps.map((step) => step.action.kind), ["navigate"]);
});

test("the trace carries what the model said, not only what it did", async () => {
  const { events, sink } = memoryTrace();
  await run([openIt, readIt, finish], workingSurface(), { sink });

  const decided = events.filter((event) => event.kind === "decided");
  assert.ok(decided.length >= 3);
  assert.ok(decided.every((event) => event.text.length > 0));
  assert.equal(events[0]?.kind, "run_started");
  assert.equal(events.at(-1)?.kind, "run_finished");
});

test("the run reports what it cost and how long it took", async () => {
  const outcome = await run([openIt, readIt, finish], workingSurface());
  assert.equal(outcome.result.modelTokensUsed, 300, "three decisions at a hundred tokens each");
  assert.ok(outcome.result.durationMs >= 0);
  assert.equal(outcome.result.capabilityId, "demo.lookup");
  assert.equal(outcome.result.tenantId, "demo");
});

test("a run that wrote no trace says so rather than naming a path", async () => {
  const outcome = await run([openIt, readIt, finish], workingSurface());
  assert.equal(outcome.result.traceRef, null);
  assert.equal(outcome.result.artifactRef, null);
});

test("the model is shown the screen, the goal and the contract every turn", async () => {
  const model = new ScriptedModel([openIt, readIt, finish]);
  await discover({
    contract: testCapability(),
    tenant: testTenant(),
    inputs: { query: "100005" },
    goal: "Read the balance",
    surface: workingSurface(),
    model,
    budget,
    runId: "run-1",
  });

  assert.equal(model.requests.length, 3);
  for (const request of model.requests) {
    assert.match(request.prompt, /Read the balance/);
    assert.match(request.prompt, /100005/);
    assert.ok(request.tools.length >= 8, "every action stays available every turn");
  }
});
