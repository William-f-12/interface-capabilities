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
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
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

  const stamp = {
    inputs: redactInputs(result.inputs, options.redact ?? []),
    evidenceRef: relative,
  };

  const stamped: ReplayResult =
    result.status === "failed"
      ? {
          ...result,
          ...stamp,
          failure: {
            ...result.failure,
            snapshotRef: screenshot ? `${relative}/screen.png` : null,
          },
        }
      : { ...result, ...stamp };

  writeFileSync(join(directory, "result.json"), `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, "summary.md"), summaryOf(stamped), "utf8");
  if (screenshot) writeFileSync(join(directory, "screen.png"), screenshot);
  if (tree) writeFileSync(join(directory, "screen.txt"), `${tree}\n`, "utf8");

  return stamped;
}
