/**
 * A `Model` backed by any OpenAI-compatible chat endpoint.
 *
 * The seam exists so the decider can be swapped without the loop, the compiler
 * or the replay engine noticing, and this is the proof rather than the claim:
 * a second vendor, a different wire format, no change anywhere else. DeepSeek
 * serves this shape, and so do most self-hosted gateways — which matters for a
 * bank that will not send its screens to a vendor at all.
 *
 * Two things differ from Anthropic's shape and are the whole of the work here:
 * a tool call's arguments arrive as a JSON string rather than an object, and
 * the system prompt is a message rather than a field.
 *
 * Uses `fetch` and nothing else, so this file adds no dependency. It still
 * lives behind a subpath export: importing a schema should not pull in
 * something that talks to a model.
 */

import type { Model, ModelDecision, ModelRequest } from "../discovery/model.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-chat";

export interface OpenAICompatibleOptions {
  /** Never logged, never written to evidence, never put in a message. */
  apiKey: string;
  /** Origin plus any path prefix; `/chat/completions` is appended. */
  baseUrl?: string;
  model?: string;
  /**
   * `required` makes the endpoint answer with a tool call. A run is recording a
   * procedure, so a turn that produces prose instead is a wasted step.
   */
  toolChoice?: "auto" | "required";
  /** Injected in tests, so the mapping is covered without a key or a network. */
  fetch?: typeof globalThis.fetch;
}

interface ChatCompletion {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleModel implements Model {
  readonly name: string;
  private readonly apiKey: string;
  private readonly url: string;
  private toolChoice: "auto" | "required";
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleOptions) {
    if (options.apiKey.trim() === "") {
      // Names what is missing and quotes nothing: a message carrying a key is a
      // key in a log file.
      throw new Error("an API key is required; set it in .env rather than passing it on a command line");
    }
    this.apiKey = options.apiKey;
    this.name = options.model ?? DEEPSEEK_MODEL;
    this.url = `${(options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/$/, "")}/chat/completions`;
    this.toolChoice = options.toolChoice ?? "required";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async decide(request: ModelRequest): Promise<ModelDecision> {
    const response = await this.send(request, this.toolChoice);

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // DeepSeek's thinking models answer 400 "Thinking mode does not support
      // this tool_choice". Asking again without the constraint is better than
      // carrying a table of which models allow what, which would be wrong by
      // the next release.
      if (response.status === 400 && /tool_choice/i.test(detail) && this.toolChoice !== "auto") {
        this.toolChoice = "auto";
        return this.decide(request);
      }
      throw new Error(`the model endpoint answered ${response.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as ChatCompletion;
    const message = body.choices?.[0]?.message;
    // One action a turn, so anything after the first call is not acted on.
    const call = message?.tool_calls?.[0];

    return {
      text: (message?.content ?? "").trim(),
      toolCall: call
        ? {
            id: call.id,
            name: call.function?.name ?? "",
            // Arguments that will not parse are handed on as an empty object:
            // the action schema refuses it and the loop feeds that back, which
            // is a recoverable turn rather than a dead run.
            input: parseArguments(call.function?.arguments),
          }
        : null,
      tokensUsed: (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0),
    };
  }

  private async send(request: ModelRequest, toolChoice: "auto" | "required"): Promise<Response> {
    return this.fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.name,
        max_tokens: request.maxTokens,
        temperature: 0,
        tool_choice: toolChoice,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
    });
  }
}

function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** DeepSeek, which serves this shape. */
export function deepSeekModel(
  options: Omit<OpenAICompatibleOptions, "apiKey"> & { apiKey?: string } = {},
): OpenAICompatibleModel {
  return new OpenAICompatibleModel({
    ...options,
    apiKey: options.apiKey ?? process.env["DEEPSEEK_API_KEY"] ?? "",
    baseUrl: options.baseUrl ?? DEEPSEEK_BASE_URL,
    model: options.model ?? DEEPSEEK_MODEL,
  });
}
