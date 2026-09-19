/**
 * What the model is given, once per decision.
 *
 * A turn is self-contained: the goal, the contract it is aiming at, the values
 * it may use, an ordered account of what has already been tried, and the
 * current screen. Only the current screen is sent in full — re-sending every
 * screen would exhaust the context long before the step ceiling, and an
 * observation from six actions ago is not evidence about the one on screen.
 *
 * What survives compaction is each action and what came of it, mistakes
 * included. That account is the agent's entire memory, and an expectation that
 * did not hold is the most useful thing in it.
 */

import type { Capability } from "../artifact/schema.js";
import { renderObservation, type Observation } from "../surface/types.js";
import type { DiscoveryBudget } from "./budget.js";
import type { AgentAction } from "./actions.js";

/**
 * Rough conversion for the observation budget. `maxObservationTokens` is
 * counted in tokens because that is the unit a context window is sold in, and
 * `renderObservation` trims by characters because that is what it can count.
 * Four is the usual English ratio and erring low costs nothing but a shorter
 * screen.
 */
export const CHARS_PER_TOKEN = 4;

export function observationChars(budget: DiscoveryBudget): number {
  return budget.maxObservationTokens * CHARS_PER_TOKEN;
}

export interface Turn {
  action: AgentAction | null;
  /** What came of it, in one line: "ok", or why it did not work. */
  result: string;
}

export function systemPrompt(): string {
  return [
    "You are recording a reusable procedure for a legacy back-office web application.",
    "",
    "You perceive the screen through its accessibility tree: roles and names, frame by",
    "frame. You act only through the tools given to you. There is no other channel.",
    "",
    "How to identify a control, best first:",
    "  ax     — a role and an accessible name. Always try this first.",
    "  text   — visible text, when nothing carries a usable name.",
    "  dom    — a selector. This application generates its ids, so a selector that",
    "           contains a generated id will not survive the next release.",
    "  coords — a pixel position. Only when an element has no name, no stable text",
    "           and no stable selector.",
    "",
    "This application is built from frames. The screen you are shown is a list of",
    "them, each under a `## frame <name>` heading, and a control only exists inside",
    "one of them. Every locator therefore needs `framePath` — the name from that",
    "heading, as a list, e.g. [\"content\"]. Omitting it means the top-level document,",
    "which in a frameset holds no controls at all, so a locator without it matches",
    "nothing. The frame is the single most common thing to get wrong here: check the",
    "heading above the control you are aiming at, every time, for the target and for",
    "the expectation alike — they are often not the same frame.",
    "",
    "Use `scope` rather than a longer selector: `row` for a control inside the row",
    "that contains some text, `labelled` for the field a label points at, and",
    "`tableCell` for a cell at a named row and column. These read the way a person",
    "would describe the screen, and they survive a redesign that a selector does not.",
    "",
    "Every acting tool takes `expect`: what you believe will be on screen once the",
    "action lands. It is checked straight away and you are told whether it held, so",
    "name something that appears only when the action has actually worked — not the",
    "navigation that was already there. It becomes the step's checkpoint, which is",
    "what makes the recorded procedure safe to replay unattended.",
    "",
    "Call `read` once for every declared output, naming where its value is on screen.",
    "",
    "When you locate a value, locate the *place*, never the value. A locator that",
    "quotes the text it is reading works for this record and no other, which defeats",
    "the point of recording anything. Use the field's label, the column header above",
    "it, or a row identified by one of the supplied inputs — never by a name, an",
    "amount or a status you just read off the screen, because those change with every",
    "record the procedure is later run for.",
    "Call `done` only when every required output has been read. Call `abandon` if the",
    "goal cannot be reached, and say what stopped you — a wrong recorded procedure is",
    "worse than none.",
    "",
    "You are recording, not browsing. Take the shortest path that a later run could",
    "repeat, and do not act outside this application.",
  ].join("\n");
}

function describeAction(action: AgentAction): string {
  switch (action.kind) {
    case "click":
      return "click";
    case "type":
      return `type "${action.value}"`;
    case "select":
      return `select "${action.value}"`;
    case "press":
      return `press ${action.key}`;
    case "navigate":
      return `navigate ${action.path}`;
    case "read":
      return `read ${action.as}`;
    case "done":
      return "done";
    case "abandon":
      return "abandon";
  }
}

function history(turns: Turn[]): string {
  if (turns.length === 0) return "Nothing yet. This is the first action of the run.";
  return turns
    .map((turn, i) => {
      const what = turn.action ? describeAction(turn.action) : "no action";
      const why = turn.action ? ` — ${turn.action.why}` : "";
      return `${i + 1}. ${what}${why}\n   → ${turn.result}`;
    })
    .join("\n");
}

export function turnPrompt(input: {
  goal: string;
  contract: Capability;
  inputs: Record<string, unknown>;
  turns: Turn[];
  observation: Observation;
  budget: DiscoveryBudget;
}): string {
  const { contract } = input;
  return [
    `# Goal`,
    input.goal,
    ``,
    `# The contract this run is recording`,
    `${contract.id}@${contract.version} — ${contract.description}`,
    ``,
    `Inputs you may use (already supplied; type these values where the screen asks for them):`,
    "```json",
    JSON.stringify(input.inputs, null, 2),
    "```",
    ``,
    'Outputs you must locate and "read", with the shape each is promised in:',
    "```json",
    JSON.stringify(contract.outputs, null, 2),
    "```",
    ``,
    `# What has happened so far`,
    history(input.turns),
    ``,
    `# The screen now`,
    renderObservation(input.observation, observationChars(input.budget)),
    ``,
    `Call exactly one tool.`,
  ].join("\n");
}
