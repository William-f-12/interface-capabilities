/**
 * The record of how a flow was found, as one JSON object per line.
 *
 * The artifact says what the flow is; the trace says how it was arrived at,
 * including the attempts that went nowhere. Keeping the two apart is what lets
 * the artifact be a clean contract and still be auditable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceEventSchema, fileTrace, memoryTrace, type TraceEvent } from "@icap/core";

const decided: TraceEvent = {
  kind: "decided",
  at: "2026-09-18T10:00:00.000Z",
  seq: 2,
  text: "The search box is labelled Member #.",
  action: {
    kind: "type",
    why: "Enter the member number",
    value: "100005",
    clearFirst: true,
    target: { kind: "dom", selector: "#id", framePath: [] },
  },
  tokens: 812,
};

test("a decision keeps what was said as well as what was done", () => {
  const parsed = TraceEventSchema.parse(decided);
  assert.equal(parsed.kind === "decided" && parsed.text.length > 0, true);
});

test("a turn where the model chose nothing is still a recorded turn", () => {
  const parsed = TraceEventSchema.parse({ ...decided, action: null });
  assert.equal(parsed.kind === "decided" && parsed.action, null);
});

test("an expectation that did not hold is recorded as such, not dropped", () => {
  const parsed = TraceEventSchema.parse({
    kind: "expectation",
    at: "2026-09-18T10:00:01.000Z",
    seq: 3,
    held: false,
    expected: { kind: "dom", selector: "#results", framePath: [] },
  });
  assert.equal(parsed.kind === "expectation" && parsed.held, false);
});

test("the run's own bookends carry what identifies it", () => {
  const started = TraceEventSchema.parse({
    kind: "run_started",
    at: "2026-09-18T10:00:00.000Z",
    runId: "2026-09-18-member.lookup_savings_balance",
    goal: "Look up a balance",
    capabilityId: "member.lookup_savings_balance",
    tenantId: "northstar",
    model: "claude-sonnet-5",
    inputs: { member_id: "100005" },
  });
  assert.equal(started.kind, "run_started");

  const finished = TraceEventSchema.parse({
    kind: "run_finished",
    at: "2026-09-18T10:02:00.000Z",
    stopReason: "goal_reached",
    stepsTaken: 5,
    tokensUsed: 4210,
  });
  assert.equal(finished.kind === "run_finished" && finished.stopReason, "goal_reached");
});

test("a stop reason outside the declared set is refused", () => {
  const bad = {
    kind: "run_finished",
    at: "2026-09-18T10:02:00.000Z",
    stopReason: "gave_up",
    stepsTaken: 1,
    tokensUsed: 1,
  };
  assert.equal(TraceEventSchema.safeParse(bad).success, false);
});

test("the file sink writes one parseable object per line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "icap-trace-")), "trace.jsonl");
  const sink = fileTrace(path);
  sink.write(decided);
  sink.write({ ...decided, seq: 3 });

  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(TraceEventSchema.safeParse(JSON.parse(line)).success, true, line);
  }
});

test("the file sink appends as it goes, so a killed run still leaves what it had", () => {
  const path = join(mkdtempSync(join(tmpdir(), "icap-trace-")), "trace.jsonl");
  const sink = fileTrace(path);
  sink.write(decided);
  assert.match(readFileSync(path, "utf8"), /Member #/, "nothing was buffered until close");
});

test("the memory sink is the same contract, so a test never touches disk", () => {
  const { events, sink } = memoryTrace();
  sink.write(decided);
  const seqs = events.filter((event) => event.kind === "decided").map((event) => event.seq);
  assert.deepEqual(seqs, [2]);
});
