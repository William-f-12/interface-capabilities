/**
 * A Model that replays decisions written by hand.
 *
 * The loop's job is to observe, act and check what it was told to expect, not
 * to think — so the thinking is scripted and every loop test is deterministic,
 * free, and runnable in CI where there is no API key.
 */

import type { AgentAction, Model, ModelDecision, ModelRequest } from "@icap/core";

export class ScriptedModel implements Model {
  readonly name = "scripted";
  /** Every request the loop made, so a test can assert what the model was shown. */
  readonly requests: ModelRequest[] = [];
  private next = 0;

  /** A `null` entry stands in for a turn where the model called no tool at all. */
  constructor(private readonly script: (AgentAction | null)[]) {}

  async decide(request: ModelRequest): Promise<ModelDecision> {
    this.requests.push(request);
    const action = this.script[this.next] ?? null;
    this.next += 1;

    return {
      text: action ? `Taking a ${action.kind} action: ${action.why}` : "I have nothing to suggest.",
      toolCall: action ? { id: `call-${this.next}`, name: action.kind, input: action } : null,
      tokensUsed: 100,
    };
  }
}

/** A model that answers with something the action schema will refuse. */
export class MalformedModel implements Model {
  readonly name = "malformed";
  private next = 0;

  constructor(private readonly then: Model) {}

  async decide(request: ModelRequest): Promise<ModelDecision> {
    this.next += 1;
    if (this.next > 1) return this.then.decide(request);
    return {
      text: "Clicking the thing.",
      toolCall: { id: "call-bad", name: "click", input: { kind: "click", why: "no target" } },
      tokensUsed: 10,
    };
  }
}
