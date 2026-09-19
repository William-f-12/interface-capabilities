/**
 * What a discovery run leaves behind while it is still running.
 *
 * The artifact a run produces says what the flow is. The trace says how it was
 * arrived at, attempts that led nowhere included — and those attempts are the
 * reason the artifact can be clean: they are recorded here so that they do not
 * have to be recorded there.
 *
 * One JSON object per line, appended as it happens, so a run that is killed
 * still leaves everything up to the moment it stopped.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ElementLocatorSchema } from "../artifact/schema.js";
import { AgentActionSchema } from "./actions.js";
import { StopReasonSchema } from "./budget.js";

const at = z.string().datetime();
const seq = z.number().int().min(0);

export const TraceEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run_started"),
    at,
    runId: z.string(),
    goal: z.string(),
    capabilityId: z.string(),
    tenantId: z.string(),
    model: z.string(),
    inputs: z.record(z.unknown()),
  }),
  z.object({
    kind: z.literal("observed"),
    at,
    seq,
    url: z.string(),
    /** Identical hashes across turns are how a dead end is noticed. */
    hash: z.string(),
    chars: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("decided"),
    at,
    seq,
    /** The model's own words. This is the reasoning a reviewer reads. */
    text: z.string(),
    action: AgentActionSchema.nullable(),
    /**
     * What the model actually sent, when the action schema refused it.
     *
     * Without this a refused turn records `action: null` and nothing else, and
     * a run of them says only that something went wrong twenty times. The point
     * of a trace is that it answers the question afterwards.
     */
    rejected: z
      .object({ tool: z.string(), input: z.unknown(), reason: z.string() })
      .optional(),
    tokens: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal("acted"),
    at,
    seq,
    ok: z.boolean(),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal("expectation"),
    at,
    seq,
    held: z.boolean(),
    expected: ElementLocatorSchema,
  }),
  z.object({
    kind: z.literal("run_finished"),
    at,
    stopReason: StopReasonSchema,
    stepsTaken: z.number().int().min(0),
    tokensUsed: z.number().int().min(0),
  }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export interface TraceSink {
  write(event: TraceEvent): void;
}

export function memoryTrace(): { events: TraceEvent[]; sink: TraceSink } {
  const events: TraceEvent[] = [];
  return { events, sink: { write: (event) => void events.push(event) } };
}

export function fileTrace(path: string): TraceSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    write(event) {
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    },
  };
}
