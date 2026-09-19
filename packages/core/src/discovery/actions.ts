/**
 * What a discovery agent is allowed to say.
 *
 * Deliberately the artifact's own vocabulary: a locator here is an
 * `ElementLocator` the replay engine already resolves, so a recorded decision
 * needs no translation to become a step, and the rule that keeps artifacts
 * portable — no browser concepts — holds for discovery without enforcing it.
 *
 * `expect` is the model stating what it believes will be on screen once the
 * action lands. It is checked immediately, which turns a wrong guess into
 * feedback rather than a silent mistake, and it is what becomes the step's
 * checkpoint. A step needs an intent, an action, a target and a checkpoint;
 * every one of them is here, so distillation has nothing left to invent.
 */

import { z } from "zod";
import { ARIA_ROLES, ElementLocatorSchema, type ElementLocator } from "../artifact/schema.js";

/* ─────────────────────────── meeting a model halfway ─────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalises the two deviations a model reliably makes, both unambiguous.
 *
 * A name or a visible string is written as a string — `name: "Member Search"`
 * rather than `name: { template: "Member Search" }` — which is the obvious
 * thing to write and is what a JSON Schema with a nested matcher does not ask
 * for. And a frame path is written on the action rather than on the locator,
 * because the frame is a property of where you are looking, not of the control.
 *
 * Both were observed on every turn of a real run, with the intent correct every
 * time. Rejecting them costs a round trip per turn and teaches nothing that
 * this function cannot do once. What is *not* normalised is vocabulary: a role
 * that is not an ARIA role is still refused, because guessing what was meant
 * would be inventing a locator rather than repairing one.
 */
function asMatcher(value: unknown): unknown {
  return typeof value === "string" ? { template: value } : value;
}

function normaliseLocator(value: unknown, framePath: unknown): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  if ("name" in next) next["name"] = asMatcher(next["name"]);
  if ("text" in next) next["text"] = asMatcher(next["text"]);
  // A path the locator states itself is the more specific statement, so it wins.
  if (next["framePath"] === undefined && Array.isArray(framePath)) next["framePath"] = framePath;
  return next;
}

function normaliseAction(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { framePath, ...rest } = value;
  const next: Record<string, unknown> = { ...rest };
  if ("target" in next) next["target"] = normaliseLocator(next["target"], framePath);
  if ("expect" in next) next["expect"] = normaliseLocator(next["expect"], framePath);
  return next;
}

const why = z.string().min(1);
const expect = ElementLocatorSchema.optional();

const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), why, target: ElementLocatorSchema, expect }),
  z.object({
    kind: z.literal("type"),
    why,
    target: ElementLocatorSchema,
    value: z.string(),
    clearFirst: z.boolean().default(true),
    expect,
  }),
  z.object({
    kind: z.literal("select"),
    why,
    target: ElementLocatorSchema,
    value: z.string(),
    expect,
  }),
  z.object({ kind: z.literal("press"), why, key: z.string().min(1), expect }),
  z.object({ kind: z.literal("navigate"), why, path: z.string().min(1), expect }),
  /** Names one declared output and where its value is read from. */
  z.object({ kind: z.literal("read"), why, target: ElementLocatorSchema, as: z.string().min(1) }),
  z.object({ kind: z.literal("done"), why, summary: z.string().min(1) }),
  z.object({ kind: z.literal("abandon"), why, reason: z.string().min(1) }),
]);

export const AgentActionSchema = z.preprocess(normaliseAction, ActionSchema);
export type AgentAction = z.infer<typeof ActionSchema>;

/** One tool definition as a model is given it. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The literal strings a locator matches on — templates and scope text, but not
 * patterns, which describe a shape rather than a value.
 */
export function locatorLiterals(locator: ElementLocator): string[] {
  const found: string[] = [];
  const matcher = locator.kind === "ax" ? locator.name : locator.kind === "text" ? locator.text : undefined;
  if (matcher && "template" in matcher) found.push(matcher.template);

  const scope = locator.scope;
  if (scope?.kind === "row") found.push(scope.containingText);
  if (scope?.kind === "labelled") found.push(scope.labelText);
  if (scope?.kind === "tableCell") found.push(scope.rowContaining, scope.columnHeader);
  return found.map((text) => text.trim()).filter((text) => text.length > 0);
}

/**
 * Whether a locator finds a value by quoting the value itself.
 *
 * Observed on a live run: asked where the member's name was, the model answered
 * "the text that reads Priya Raman". That resolves perfectly for the member it
 * was recorded against and for no other, which is the whole failure mode a
 * recorded procedure exists to avoid. A label, a column header or a row the
 * caller's own input identifies all survive the next member; the answer does
 * not.
 */
export function locatesItselfBy(locator: ElementLocator, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (wanted.length === 0) return false;
  return locatorLiterals(locator).some((literal) => literal.toLowerCase() === wanted);
}

/* ─────────────────────────── the locator, as JSON Schema ─────────────────── */

const TEXT_MATCHER = {
  description: 'The text to match. A plain string means "contains this text".',
  oneOf: [
    { type: "string" },
    {
      type: "object",
      additionalProperties: false,
      required: ["template"],
      properties: {
        template: {
          type: "string",
          description: 'Literal text. May interpolate a declared input as "{{inputs.name}}".',
        },
        match: { enum: ["equals", "contains", "startsWith"], default: "contains" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "A regular expression." },
        flags: { type: "string", pattern: "^[gimsuy]*$" },
      },
    },
  ],
};

const SCOPE = {
  description: "Narrows where to look before the locator is applied.",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "containingText"],
      properties: { kind: { const: "row" }, containingText: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "labelText"],
      properties: { kind: { const: "labelled" }, labelText: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "rowContaining", "columnHeader"],
      properties: {
        kind: { const: "tableCell" },
        rowContaining: { type: "string" },
        columnHeader: { type: "string" },
      },
    },
  ],
};

const FRAME_PATH = {
  type: "array",
  items: { type: "string" },
  description: "Frame ancestry, outermost first. Omit for the top-level document.",
};

/**
 * Mirrors `ElementLocatorSchema`. Written out rather than generated so the
 * model reads descriptions written for it; `agent-actions.test.ts` checks that
 * the two agree on every action kind, which is what keeps them from drifting.
 */
const LOCATOR = {
  description: "How to recognise one element. Prefer ax, then text, then dom; coords last.",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "role"],
      properties: {
        kind: { const: "ax" },
        role: { enum: [...ARIA_ROLES] },
        name: TEXT_MATCHER,
        scope: SCOPE,
        framePath: FRAME_PATH,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text"],
      properties: {
        kind: { const: "text" },
        text: TEXT_MATCHER,
        scope: SCOPE,
        framePath: FRAME_PATH,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "selector"],
      properties: {
        kind: { const: "dom" },
        selector: { type: "string" },
        scope: SCOPE,
        framePath: FRAME_PATH,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "x", "y"],
      properties: {
        kind: { const: "coords" },
        x: { type: "number" },
        y: { type: "number" },
        note: { type: "string" },
        scope: SCOPE,
        framePath: FRAME_PATH,
      },
    },
  ],
};

const WHY = {
  type: "string",
  description: "Why this action, in one sentence. It becomes the step's intent.",
};

const EXPECT = {
  ...LOCATOR,
  description:
    "What you expect on screen once this lands. It is checked immediately and becomes the " +
    "step's checkpoint, so name something that appears only when the action has worked.",
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "why", ...required],
      properties: { kind: { const: name }, why: WHY, ...properties },
    },
  };
}

export const ACTION_TOOLS: ToolSchema[] = [
  tool(
    "click",
    "Click one element. Use this for links, buttons and anything that navigates.",
    { target: LOCATOR, expect: EXPECT },
    ["target"],
  ),
  tool(
    "type",
    "Type text into a field. Use a declared input's value when the field is asking for it.",
    {
      target: LOCATOR,
      value: { type: "string" },
      clearFirst: { type: "boolean", description: "Replace what is there. Defaults to true." },
      expect: EXPECT,
    },
    ["target", "value"],
  ),
  tool(
    "select",
    "Choose an option in a dropdown, by the option's visible text or value.",
    { target: LOCATOR, value: { type: "string" }, expect: EXPECT },
    ["target", "value"],
  ),
  tool(
    "press",
    "Press one key on the keyboard, such as Enter or Tab, without naming an element.",
    { key: { type: "string" }, expect: EXPECT },
    ["key"],
  ),
  tool(
    "navigate",
    "Go straight to a path in the application, such as /search. Stay within the application.",
    { path: { type: "string" }, expect: EXPECT },
    ["path"],
  ),
  tool(
    "read",
    "Record where one declared output is read from. Call this once for each declared output.",
    {
      target: LOCATOR,
      as: { type: "string", description: "The declared output this element holds." },
    },
    ["target", "as"],
  ),
  tool(
    "done",
    "The goal is reached and every required output has been read. Nothing runs after this.",
    { summary: { type: "string", description: "What the flow does, in one sentence." } },
    ["summary"],
  ),
  tool(
    "abandon",
    "The goal cannot be reached from here. Say what stopped you.",
    { reason: { type: "string" } },
    ["reason"],
  ),
];
