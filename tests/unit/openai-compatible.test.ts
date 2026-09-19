/**
 * The second implementation of the `Model` seam.
 *
 * A seam is a claim until something else implements it. This one talks to any
 * OpenAI-compatible chat endpoint, which is what DeepSeek serves — and what it
 * has to get right is the part that differs from Anthropic's shape: a tool call
 * arrives as a JSON *string* that still has to be parsed, and a model that
 * answers with prose instead of calling a tool has to be reported as a turn
 * with no action rather than as a crash.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_TOOLS, type ModelRequest } from "@icap/core";
import { DEEPSEEK_BASE_URL, OpenAICompatibleModel, deepSeekModel } from "@icap/core/openai-compatible";

const request: ModelRequest = {
  system: "You are recording a procedure.",
  prompt: "# Goal\nRead a balance\n",
  tools: ACTION_TOOLS,
  maxTokens: 2000,
};

/** Stands in for the endpoint, and keeps what it was sent. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function completion(message: Record<string, unknown>) {
  return {
    choices: [{ message }],
    usage: { prompt_tokens: 1200, completion_tokens: 80 },
  };
}

const toolCall = {
  id: "call_abc",
  type: "function",
  function: {
    name: "click",
    // The arguments come back as a string, not an object. This is the difference.
    arguments: JSON.stringify({
      kind: "click",
      why: "Open the search screen",
      target: { kind: "dom", selector: "#open" },
    }),
  },
};

test("a tool call is parsed out of the string the endpoint returns", async () => {
  const { fetch } = stubFetch(completion({ content: "Opening search.", tool_calls: [toolCall] }));
  const model = new OpenAICompatibleModel({ apiKey: "k", fetch, model: "deepseek-chat" });

  const decision = await model.decide(request);
  assert.equal(decision.text, "Opening search.");
  assert.equal(decision.toolCall?.name, "click");
  assert.deepEqual(decision.toolCall?.input, {
    kind: "click",
    why: "Open the search screen",
    target: { kind: "dom", selector: "#open" },
  });
  assert.equal(decision.tokensUsed, 1280);
});

test("the tools are sent in the shape this API expects", async () => {
  const { calls, fetch } = stubFetch(completion({ content: "", tool_calls: [toolCall] }));
  await new OpenAICompatibleModel({ apiKey: "k", fetch }).decide(request);

  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.tools.length, ACTION_TOOLS.length);
  assert.equal(sent.tools[0].type, "function");
  assert.equal(sent.tools[0].function.name, "click");
  assert.ok(sent.tools[0].function.parameters, "the JSON Schema moves under `parameters`");
  assert.deepEqual(sent.messages[0], { role: "system", content: request.system });
  assert.deepEqual(sent.messages[1], { role: "user", content: request.prompt });
});

test("the model is asked to act rather than left free to chat", async () => {
  const { calls, fetch } = stubFetch(completion({ content: "", tool_calls: [toolCall] }));
  await new OpenAICompatibleModel({ apiKey: "k", fetch }).decide(request);

  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.tool_choice, "required");
  assert.equal(sent.temperature, 0, "a recording run should not be creative");
});

test("prose with no tool call is a turn with no action, not an exception", async () => {
  const { fetch } = stubFetch(completion({ content: "I am not sure what to do here." }));
  const decision = await new OpenAICompatibleModel({ apiKey: "k", fetch }).decide(request);

  assert.equal(decision.toolCall, null);
  assert.match(decision.text, /not sure/);
});

test("arguments that are not valid JSON become an action the schema will refuse", async () => {
  const broken = { ...toolCall, function: { name: "click", arguments: "{not json" } };
  const { fetch } = stubFetch(completion({ content: "", tool_calls: [broken] }));
  const decision = await new OpenAICompatibleModel({ apiKey: "k", fetch }).decide(request);

  // Handed back rather than thrown: the loop feeds a refused action to the model
  // as feedback, which is a better outcome than ending the run.
  assert.equal(decision.toolCall?.name, "click");
  assert.deepEqual(decision.toolCall?.input, {});
});

test("only the first tool call is taken, since the loop takes one action a turn", async () => {
  const second = { ...toolCall, id: "call_def", function: { ...toolCall.function, name: "press" } };
  const { fetch } = stubFetch(completion({ content: "", tool_calls: [toolCall, second] }));
  const decision = await new OpenAICompatibleModel({ apiKey: "k", fetch }).decide(request);
  assert.equal(decision.toolCall?.id, "call_abc");
});

test("an endpoint that cannot be told to act is asked again without the constraint", async () => {
  // Observed: DeepSeek's thinking models answer 400 "Thinking mode does not
  // support this tool_choice". Carrying a table of which model allows what
  // would be wrong by the next release; asking again is not.
  const sent: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body.tool_choice);
    if (body.tool_choice === "required") {
      return new Response(
        JSON.stringify({ error: { message: "Thinking mode does not support this tool_choice" } }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify(completion({ content: "", tool_calls: [toolCall] })), {
      status: 200,
    });
  }) as unknown as typeof globalThis.fetch;

  const model = new OpenAICompatibleModel({ apiKey: "k", fetch });
  const decision = await model.decide(request);

  assert.equal(decision.toolCall?.name, "click");
  assert.deepEqual(sent, ["required", "auto"]);

  await model.decide(request);
  assert.deepEqual(sent, ["required", "auto", "auto"], "and it does not relearn it every turn");
});

test("a refusal that is not about tool_choice is not retried", async () => {
  const { calls, fetch } = stubFetch({ error: { message: "insufficient balance" } }, 400);
  const model = new OpenAICompatibleModel({ apiKey: "k", fetch });
  await assert.rejects(() => model.decide(request), /insufficient balance/);
  assert.equal(calls.length, 1);
});

test("an endpoint that refuses says so in a way that names the status", async () => {
  const { fetch } = stubFetch({ error: { message: "model not found" } }, 404);
  const model = new OpenAICompatibleModel({ apiKey: "k", fetch });
  await assert.rejects(() => model.decide(request), /404/);
});

test("the key travels in the header and never in a message", async () => {
  const { calls, fetch } = stubFetch(completion({ content: "", tool_calls: [toolCall] }));
  await new OpenAICompatibleModel({ apiKey: "sk-secret", fetch }).decide(request);

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer sk-secret");
  assert.doesNotMatch(String(calls[0]?.init.body), /sk-secret/);
});

test("an empty key is refused before a request is made, naming the variable", () => {
  assert.throws(() => new OpenAICompatibleModel({ apiKey: "  " }), /API key/);
});

test("the DeepSeek preset points at DeepSeek and identifies itself as what it is", async () => {
  const { calls, fetch } = stubFetch(completion({ content: "", tool_calls: [toolCall] }));
  const model = deepSeekModel({ apiKey: "k", fetch });

  assert.equal(model.name, "deepseek-chat");
  await model.decide(request);
  assert.ok(String(calls[0]?.url).startsWith(DEEPSEEK_BASE_URL));
  assert.match(String(calls[0]?.url), /\/chat\/completions$/);
});
