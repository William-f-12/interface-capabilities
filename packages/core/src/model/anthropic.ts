/**
 * The `Model` the discovery loop actually talks to.
 *
 * Kept behind `@icap/core/anthropic` for the same reason `WebSurface` is kept
 * behind `@icap/core/web`: importing a schema, a contract or the replay engine
 * should not pull in a vendor SDK. Replay never calls a model at all, and that
 * claim is worth being able to see in the import graph rather than in a
 * sentence — `architecture.test.ts` checks it.
 *
 * One decision is one request. Nothing is carried between them but what the
 * prompt already says, so a decision in the trace can be understood, and
 * reproduced, from the trace alone.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Model, ModelDecision, ModelRequest } from "../discovery/model.js";

/**
 * Sonnet reads an accessibility tree and picks a control well, and a discovery
 * run spends a decision per step — so the cheaper, faster model is the default
 * and a harder screen is a `--model` away.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

export interface AnthropicModelOptions {
  /** Defaults to ANTHROPIC_API_KEY. Never logged, never written to evidence. */
  apiKey?: string;
  model?: string;
}

export class AnthropicModel implements Model {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (apiKey.trim() === "") {
      // Names the variable and nothing else: a message that quotes a key is a
      // key in a log file.
      throw new Error("ANTHROPIC_API_KEY is not set; a discovery run needs model access");
    }
    this.name = options.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey });
  }

  async decide(request: ModelRequest): Promise<ModelDecision> {
    const response = await this.client.messages.create({
      model: this.name,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
      })),
      messages: [{ role: "user", content: request.prompt }],
    });

    let text = "";
    let toolCall: ModelDecision["toolCall"] = null;
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      // The first tool call is the decision; the loop takes one action a turn.
      if (block.type === "tool_use" && !toolCall) {
        toolCall = { id: block.id, name: block.name, input: block.input };
      }
    }

    return {
      text: text.trim(),
      toolCall,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    };
  }
}
