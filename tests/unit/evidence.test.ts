/** What a run leaves on disk, and where. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay, writeEvidence, type ReplayResult } from "@icap/core";
import {
  ScriptedSurface,
  fastBudget,
  happyPathSurface,
  testCapability,
  testTenant,
} from "../helpers/scripted.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "icap-evidence-"));
}

async function runWith(surface: ScriptedSurface, runId = "run-1"): Promise<ReplayResult> {
  return replay({
    capability: testCapability({
      outcomes: [
        {
          code: "NOT_FOUND",
          kind: "business_outcome",
          description: "Nothing matched the query.",
          after: "submit",
          onDetect: "halt",
          detect: { kind: "dom", selector: "#empty" },
        },
      ],
    }),
    tenant: testTenant(),
    inputs: { query: "100005" },
    surface,
    budget: fastBudget,
    runId,
  });
}

function emptyResultSurface(): ScriptedSurface {
  return new ScriptedSurface({
    facts: ["#open"],
    onAction: (entry, facts) => {
      if (entry === "click #open") facts.add("#form").add("#query").add("#submit");
      if (entry === "click #submit") facts.add("#empty");
    },
  });
}

test("a run that succeeded is filed under success", async () => {
  const root = scratch();
  const surface = happyPathSurface();
  const written = await writeEvidence(await runWith(surface), { root, surface });

  assert.equal(written.evidenceRef, "replay/success/run-1");
  for (const file of ["result.json", "summary.md", "screen.png", "screen.txt"]) {
    assert.ok(existsSync(join(root, "replay", "success", "run-1", file)), `missing ${file}`);
  }
});

test("the record on disk points at where it is, not at where it might have gone", async () => {
  const root = scratch();
  const surface = happyPathSurface();
  await writeEvidence(await runWith(surface), { root, surface });

  const saved = JSON.parse(
    readFileSync(join(root, "replay", "success", "run-1", "result.json"), "utf8"),
  );
  assert.equal(saved.evidenceRef, "replay/success/run-1");
  assert.equal(saved.status, "succeeded");
});

test("a business outcome is filed apart from a failure, so it can be found", async () => {
  const root = scratch();
  const surface = emptyResultSurface();
  const written = await writeEvidence(await runWith(surface), { root, surface });

  assert.equal(written.status, "halted");
  assert.equal(written.evidenceRef, "replay/business-outcome/run-1");
});

test("a failure is filed under hard-failure and its summary says what went wrong", async () => {
  const root = scratch();
  const surface = new ScriptedSurface({ facts: [] });
  const written = await writeEvidence(await runWith(surface), { root, surface });

  assert.ok(written.status === "failed");
  assert.equal(written.evidenceRef, "replay/hard-failure/run-1");
  assert.equal(written.failure.snapshotRef, "replay/hard-failure/run-1/screen.png");

  const summary = readFileSync(join(root, "replay", "hard-failure", "run-1", "summary.md"), "utf8");
  assert.match(summary, /TARGET_NOT_FOUND/);
  assert.match(summary, /#open/);
});

test("a step table shows which rung answered and whether the checkpoint held", async () => {
  const root = scratch();
  const surface = happyPathSurface();
  await writeEvidence(await runWith(surface), { root, surface });

  const summary = readFileSync(join(root, "replay", "success", "run-1", "summary.md"), "utf8");
  assert.match(summary, /\| open \| ok \| 1 \| primary\/dom \| met \|/);
  assert.match(summary, /\| fill \| ok \| 1 \| primary\/dom \| — \|/);
});

test("a named input is redacted in the result and in the summary alike", async () => {
  const root = scratch();
  const surface = happyPathSurface();
  const written = await writeEvidence(await runWith(surface), {
    root,
    surface,
    redact: ["query"],
  });

  assert.deepEqual(written.inputs, { query: "[redacted]" });
  const directory = join(root, "replay", "success", "run-1");
  for (const file of ["result.json", "summary.md"]) {
    const text = readFileSync(join(directory, file), "utf8");
    assert.match(text, /\[redacted\]/);
    assert.doesNotMatch(text, /100005/, `${file} still carries the value`);
  }
});

test("nothing is redacted unless it is asked for", async () => {
  const root = scratch();
  const surface = happyPathSurface();
  const written = await writeEvidence(await runWith(surface), { root, surface });
  assert.deepEqual(written.inputs, { query: "100005" });
});

test("a run id that is not a legal directory name is made into one", async () => {
  const root = scratch();
  const surface = happyPathSurface();
  const written = await writeEvidence(await runWith(surface, "2026-09-11T06:06:11.827Z"), {
    root,
    surface,
  });

  assert.equal(written.evidenceRef, "replay/success/2026-09-11T06-06-11.827Z");
  assert.ok(existsSync(join(root, "replay", "success", "2026-09-11T06-06-11.827Z", "result.json")));
});

test("a record can be written without a surface to photograph", async () => {
  const root = scratch();
  const surface = new ScriptedSurface({ facts: [] });
  const result = await runWith(surface);
  const written = await writeEvidence(result, { root });

  assert.ok(written.status === "failed");
  assert.equal(written.failure.snapshotRef, null);
  assert.ok(existsSync(join(root, "replay", "hard-failure", "run-1", "result.json")));
  assert.equal(existsSync(join(root, "replay", "hard-failure", "run-1", "screen.png")), false);
});
