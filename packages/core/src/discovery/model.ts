/**
 * The seam between deciding and the thing that decides.
 *
 * Nothing here names a vendor, for the same reason `Surface` names no browser:
 * the discovery loop is the interesting part and it should be runnable against
 * a scripted stand-in, which is what keeps the whole loop testable without an
 * API key. The client that actually calls a model lives behind
 * `@icap/core/anthropic` so importing a schema never pulls in an SDK.
 *
 * Each decision is one self-contained request. A turn carries the goal, the
 * contract, what has happened so far and the current screen, so a decision can
 * be reproduced from the trace alone rather than depending on a conversation
 * the trace does not hold.
 */

import type { ToolSchema } from "./actions.js";

export interface ToolCall {
  id: string;
  name: string;
  /** Validated against `AgentActionSchema` by the caller, never trusted here. */
  input: unknown;
}

export interface ModelRequest {
  system: string;
  prompt: string;
  tools: ToolSchema[];
  maxTokens: number;
}

export interface ModelDecision {
  /** What it said before acting. Kept in the trace; it is the reasoning a reviewer reads. */
  text: string;
  toolCall: ToolCall | null;
  tokensUsed: number;
}

export interface Model {
  /** Identifies the decider in evidence and in an artifact's provenance. */
  readonly name: string;
  decide(request: ModelRequest): Promise<ModelDecision>;
}
