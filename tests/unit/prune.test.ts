/**
 * Sweeping the evidence tree.
 *
 * The risk here is a tool that tidies away the thing CI reads. The guard is
 * that git says what to keep: a run someone force-added is tracked, and the
 * sweep is told about it before it decides anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRuns, planPrune, prune } from "@icap/core";

/** Seconds apart, so a run's age does not depend on the clock's resolution. */
function write(root: string, path: string, at: number): void {
  const full = join(root, ...path.split("/"));
  mkdirSync(full, { recursive: true });
  const file = join(full, "result.json");
  writeFileSync(file, "{}\n", "utf8");
  utimesSync(file, at, at);
}

function tree(runs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "icap-prune-"));
  runs.forEach((path, index) => write(root, path, 1_000_000 + index * 60));
  return root;
}

const RUNS = [
  "replay/success/lookup-1",
  "replay/success/lookup-2",
  "replay/success/lookup-3",
  "replay/success/lookup-4",
  "replay/hard-failure/lookup-5",
  "discovery/2026-09-18-lookup",
  "discovery/2026-09-19-lookup",
];

function paths(runs: { path: string }[]): string[] {
  return runs.map((run) => run.path).sort();
}

test("a run is found at the depth its writer files it", () => {
  const found = findRuns(tree(RUNS));
  assert.deepEqual(paths(found), [...RUNS].sort());
});

test("the steps a discovery run saved are part of that run, not runs of their own", () => {
  const root = tree(["discovery/2026-09-19-lookup"]);
  write(root, "discovery/2026-09-19-lookup/steps", 1_000_100);
  const found = findRuns(root);
  assert.deepEqual(paths(found), ["discovery/2026-09-19-lookup"]);
  assert.equal(found[0]?.files, 2, "the screenshots count towards the run that took them");
});

test("the newest few survive and the rest are swept", () => {
  const { kept, swept } = planPrune({ root: tree(RUNS), keep: 2 });
  assert.deepEqual(paths(kept), [
    "discovery/2026-09-18-lookup",
    "discovery/2026-09-19-lookup",
    "replay/hard-failure/lookup-5",
    "replay/success/lookup-3",
    "replay/success/lookup-4",
  ]);
  assert.deepEqual(paths(swept), ["replay/success/lookup-1", "replay/success/lookup-2"]);
});

test("the count is per family, so one busy directory does not evict the others", () => {
  // Four successes were written after the only hard failure. Counting across
  // the tree would sweep the one run that shows what a failure looks like.
  const { kept } = planPrune({ root: tree(RUNS), keep: 1 });
  assert.ok(paths(kept).includes("replay/hard-failure/lookup-5"));
});

test("a run git tracks survives however old it is", () => {
  // The whole safety property. The oldest run in the tree is the one the
  // integration suite reads.
  const { kept, swept } = planPrune({
    root: tree(RUNS),
    keep: 0,
    pin: ["discovery/2026-09-18-lookup/result.json"],
  });
  assert.deepEqual(paths(kept), ["discovery/2026-09-18-lookup"]);
  assert.equal(swept.length, RUNS.length - 1, "and nothing else was spared");
});

test("git's own listing goes in unchanged, separators and all", () => {
  const { kept } = planPrune({
    root: tree(RUNS),
    keep: 0,
    pin: ["replay\\success\\lookup-1\\result.json"],
  });
  assert.deepEqual(paths(kept), ["replay/success/lookup-1"]);
});

test("a pinned run does not use up a slot a leftover could have had", () => {
  const { kept } = planPrune({
    root: tree(RUNS),
    keep: 2,
    pin: ["replay/success/lookup-1"],
  });
  assert.deepEqual(paths(kept).filter((path) => path.startsWith("replay/success/")), [
    "replay/success/lookup-1",
    "replay/success/lookup-3",
    "replay/success/lookup-4",
  ]);
});

test("the husk of a run that crashed before writing anything is always swept", () => {
  const root = tree(RUNS);
  mkdirSync(join(root, "discovery", "2026-09-20-lookup", "steps"), { recursive: true });
  const { kept, swept } = planPrune({ root, keep: 10 });
  assert.ok(paths(swept).includes("discovery/2026-09-20-lookup"));
  assert.ok(!paths(kept).includes("discovery/2026-09-20-lookup"), "there is nothing in it to read");
});

test("planning touches nothing", () => {
  const root = tree(RUNS);
  planPrune({ root, keep: 0 });
  for (const path of RUNS) assert.ok(existsSync(join(root, ...path.split("/"))), path);
});

test("sweeping removes what it planned to and leaves the rest standing", () => {
  const root = tree(RUNS);
  const { kept, swept } = prune({ root, keep: 1 });
  for (const run of swept) assert.equal(existsSync(join(root, ...run.path.split("/"))), false);
  for (const run of kept) assert.equal(existsSync(join(root, ...run.path.split("/"))), true);
});

test("an evidence directory nobody has written to yet is an empty plan", () => {
  const { kept, swept } = planPrune({ root: join(tmpdir(), "icap-prune-absent"), keep: 0 });
  assert.deepEqual([kept, swept], [[], []]);
});
