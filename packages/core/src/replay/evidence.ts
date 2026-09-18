/**
 * What a run leaves behind.
 *
 * A result a caller can act on is not the same thing as a record a person can
 * audit. This writes the second: the result verbatim, a summary a reviewer can
 * read without parsing JSON, and the screen as the run last saw it — filed by
 * how the run ended, so "show me a business outcome" is a directory listing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplayResult } from "./contract.js";
import { summarize } from "./contract.js";
import { renderObservation, type Surface } from "../surface/types.js";

/** Directory under evidence/replay/ for each way a run can end. */
const CATEGORY = {
  succeeded: "success",
  halted: "business-outcome",
  suspended: "escalation",
  failed: "hard-failure",
} as const;

/** How much of the accessibility tree the saved screen dump keeps. */
const SCREEN_CHARS = 20_000;

export interface EvidenceOptions {
  /** The repository's evidence/ directory. */
  root: string;
  /** Captured for the record; omitted when the surface is already gone. */
  surface?: Surface;
  /** Input names whose values must not be written down. */
  redact?: string[];
}

function pathSafe(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-");
  // "." and ".." name a directory other than the one being created, and a run's
  // record belongs inside its own.
  return /^\.+$/.test(safe) ? safe.replace(/\./g, "_") : safe;
}

function redactInputs(
  inputs: Record<string, unknown>,
  redact: string[],
): Record<string, unknown> {
  if (redact.length === 0) return inputs;
  const safe: Record<string, unknown> = { ...inputs };
  for (const name of redact) {
    if (name in safe) safe[name] = "[redacted]";
  }
  return safe;
}

/** The shortest value that can be taken out of free text without wrecking it. */
const SCRUB_FLOOR = 3;

/**
 * Removes a redacted value from everywhere it could have been written, not only
 * from the field that carries its name. A failure report quotes the values it
 * interpolated into what it expected, and a screen dump quotes whatever stood on
 * the screen — labelling one copy redacted while writing the rest down is not
 * redaction.
 *
 * A one- or two-character value occurs all over an ordinary screen, so taking it
 * out would destroy the record it exists to preserve; a value that short is not
 * a secret either. A run id is the other limit: it names a real directory, so a
 * caller who builds one out of a sensitive value has already written it down.
 */
function scrubber(
  inputs: Record<string, unknown>,
  redact: string[],
): (text: string) => string {
  const values = redact
    .map((name) => inputs[name])
    .filter((value): value is string | number => ["string", "number"].includes(typeof value))
    .map(String)
    .filter((value) => value.length >= SCRUB_FLOOR)
    // Longest first, so a value that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);

  if (values.length === 0) return (text) => text;
  return (text) => values.reduce((out, value) => out.split(value).join("[redacted]"), text);
}

function stepTable(result: ReplayResult): string {
  const rows = result.steps.map((step) => {
    const rung = step.resolvedBy
      ? `${step.resolvedBy.rung}/${step.resolvedBy.kind}`
      : "—";
    const checkpoint =
      step.checkpointMet === null ? "—" : step.checkpointMet ? "met" : "not met";
    return `| ${step.stepId} | ${step.status} | ${step.attempts} | ${rung} | ${checkpoint} | ${step.durationMs}ms |`;
  });
  return [
    "| step | status | attempts | resolved by | checkpoint | duration |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function outcomeSection(result: ReplayResult): string {
  switch (result.status) {
    case "succeeded":
      return `## Outputs\n\n\`\`\`json\n${JSON.stringify(result.outputs, null, 2)}\n\`\`\``;
    case "halted":
      return [
        `## Business outcome\n`,
        `**${result.outcome.code}** (${result.outcome.origin}, after \`${result.outcome.atStepId ?? "—"}\`)`,
        ``,
        result.outcome.description,
        ``,
        `## Outputs read before the run stopped\n`,
        `\`\`\`json\n${JSON.stringify(result.outputs, null, 2)}\n\`\`\``,
      ].join("\n");
    case "suspended":
      return [
        `## Escalation\n`,
        `Waiting on a **${result.escalation.requiredRole}**, raised at \`${result.escalation.raisedAtStepId ?? "—"}\`.`,
        ``,
        result.escalation.reason,
        ``,
        `Resuming continues at \`${result.escalation.resumeFrom}\`.`,
      ].join("\n");
    case "failed":
      return [
        `## Failure\n`,
        `**${result.failure.cause}**${result.failure.code ? ` (${result.failure.code})` : ""}` +
          `${result.failure.stepId ? ` at \`${result.failure.stepId}\`` : ""}`,
        ``,
        result.failure.message,
        ``,
        `- expected: ${result.failure.expected}`,
        `- observed:`,
        ``,
        `\`\`\`\n${result.failure.observed}\n\`\`\``,
      ].join("\n");
  }
}

function summaryOf(result: ReplayResult): string {
  const sections = [
    `# ${summarize(result)}`,
    ``,
    `- run: \`${result.runId}\``,
    `- capability: \`${result.capability.id}@${result.capability.version}\``,
    `- tenant: \`${result.tenantId}\``,
    `- decided by: \`${result.decisionSource}\``,
    `- started: ${result.startedAt}`,
    `- duration: ${result.durationMs}ms`,
    ``,
    `## Inputs\n`,
    `\`\`\`json\n${JSON.stringify(result.inputs, null, 2)}\n\`\`\``,
    ``,
    outcomeSection(result),
    ``,
    `## Steps\n`,
    stepTable(result),
  ];

  if (result.observedOutcomes.length > 0) {
    sections.push(
      ``,
      `## Conditions detected\n`,
      ...result.observedOutcomes.map(
        (o) => `- **${o.code}** (${o.kind}, ${o.origin}) at \`${o.atStepId ?? "—"}\``,
      ),
    );
  }

  if (result.recoveries.length > 0) {
    sections.push(
      ``,
      `## Recoveries\n`,
      ...result.recoveries.map(
        (r) =>
          `- ${r.outcomeCode}: \`${r.action}\` attempt ${r.attempt} — ${r.succeeded ? "worked" : "did not work"}`,
      ),
    );
  }

  return `${sections.join("\n")}\n`;
}

/**
 * Writes the record and returns the result with `evidenceRef` — and a failure's
 * `snapshotRef` — pointing at what was actually written.
 */
export async function writeEvidence(
  result: ReplayResult,
  options: EvidenceOptions,
): Promise<ReplayResult> {
  const category = CATEGORY[result.status];
  const relative = `replay/${category}/${pathSafe(result.runId)}`;
  const directory = join(options.root, "replay", category, pathSafe(result.runId));
  mkdirSync(directory, { recursive: true });

  let screenshot: Buffer | null = null;
  let tree: string | null = null;
  if (options.surface) {
    screenshot = await options.surface.screenshot().catch(() => null);
    const observation = await options.surface.observe().catch(() => null);
    tree = observation ? renderObservation(observation, SCREEN_CHARS) : null;
  }

  const redact = options.redact ?? [];
  const scrub = scrubber(result.inputs, redact);
  const stamp = { inputs: redactInputs(result.inputs, redact), evidenceRef: relative };

  const stamped: ReplayResult =
    result.status === "failed"
      ? {
          ...result,
          ...stamp,
          failure: {
            ...result.failure,
            expected: scrub(result.failure.expected),
            observed: scrub(result.failure.observed),
            message: scrub(result.failure.message),
            snapshotRef: screenshot ? `${relative}/screen.png` : null,
          },
        }
      : { ...result, ...stamp };

  writeFileSync(join(directory, "result.json"), `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "summary.md"), scrub(summaryOf(stamped)), "utf8");
  if (screenshot) writeFileSync(join(directory, "screen.png"), screenshot);
  // The tree is quoted screen text; the screenshot is the one thing here that
  // cannot be scrubbed without reading pixels.
  if (tree) writeFileSync(join(directory, "screen.txt"), `${scrub(tree)}\n`, "utf8");

  return stamped;
}
