/**
 * Keeping the evidence tree readable.
 *
 * Every replay and every discovery run leaves a directory behind, so the tree
 * grows with each debugging session while only a handful of runs are ever worth
 * reading. Git already knows which handful: a run worth keeping was force-added
 * once and stays tracked, because .gitignore has no say over a file git already
 * tracks. So the caller names those, and everything else is a leftover — the
 * newest few stay for whoever is mid-investigation, the rest go.
 *
 * Deciding what is old is this module's job. Finding out what is pinned is not,
 * so the caller passes it in and nothing here shells out to git.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where each writer files its runs, and how far below it a run directory sits. */
const LAYOUT = [
  /** replay/<how it ended>/<run> */
  { family: "replay", depth: 2 },
  /** discovery/<run> */
  { family: "discovery", depth: 1 },
] as const;

const DEFAULT_KEEP = 3;

export interface EvidenceRun {
  /** Relative to the evidence root, with forward slashes. */
  path: string;
  /** The directory it was filed under: `replay/success`, `discovery`. */
  family: string;
  /** Newest file inside it. Zero when it holds none. */
  writtenAt: number;
  files: number;
  bytes: number;
  /** Named by the caller as worth keeping, whatever its age. */
  pinned: boolean;
}

export interface PruneOptions {
  /** The repository's evidence/ directory. */
  root: string;
  /** Unpinned runs to keep per family, newest first. Zero keeps none. */
  keep?: number;
  /**
   * Paths that must survive, relative to the root. A path inside a run pins the
   * whole run, so the output of `git ls-files evidence` goes in unchanged.
   */
  pin?: readonly string[];
}

export interface PrunePlan {
  kept: EvidenceRun[];
  swept: EvidenceRun[];
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // A family nobody has written to yet holds no runs, which is not a problem
    // to report — it is the answer.
    return [];
  }
}

function measure(path: string): Pick<EvidenceRun, "files" | "bytes" | "writtenAt"> {
  let files = 0;
  let bytes = 0;
  let writtenAt = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      const stat = statSync(child);
      files += 1;
      bytes += stat.size;
      writtenAt = Math.max(writtenAt, stat.mtimeMs);
    }
  };

  walk(path);
  return { files, bytes, writtenAt };
}

/** Every run directory under the root, at the depth its writer files them. */
export function findRuns(root: string): EvidenceRun[] {
  const runs: EvidenceRun[] = [];

  for (const { family, depth } of LAYOUT) {
    let level: string[] = [family];
    for (let below = 0; below < depth; below += 1) {
      level = level.flatMap((path) =>
        directories(join(root, path)).map((name) => `${path}/${name}`),
      );
    }
    for (const path of level) {
      runs.push({
        path,
        family: path.slice(0, path.lastIndexOf("/")),
        ...measure(join(root, path)),
        pinned: false,
      });
    }
  }

  return runs;
}

function slashed(path: string): string {
  return path.split(/[\\/]/).join("/");
}

function pinnedBy(run: EvidenceRun, pin: readonly string[]): boolean {
  return pin.some((path) => path === run.path || path.startsWith(`${run.path}/`));
}

/** What a sweep would keep and what it would take, without touching anything. */
export function planPrune(options: PruneOptions): PrunePlan {
  const keep = options.keep ?? DEFAULT_KEEP;
  const pin = (options.pin ?? []).map(slashed);

  const runs = findRuns(options.root)
    .map((run) => ({ ...run, pinned: pinnedBy(run, pin) }))
    // Newest first, and by name when two were written in the same millisecond,
    // so a sweep takes the same runs whatever order the directory listed them.
    .sort((a, b) => b.writtenAt - a.writtenAt || b.path.localeCompare(a.path));

  const kept: EvidenceRun[] = [];
  const swept: EvidenceRun[] = [];
  const taken = new Map<string, number>();

  for (const run of runs) {
    if (run.pinned) {
      kept.push(run);
      continue;
    }
    // The husk of a run that crashed before writing anything. There is nothing
    // in it to read, so it never occupies one of the slots.
    if (run.files === 0) {
      swept.push(run);
      continue;
    }
    const used = taken.get(run.family) ?? 0;
    if (used < keep) {
      taken.set(run.family, used + 1);
      kept.push(run);
    } else {
      swept.push(run);
    }
  }

  return { kept, swept };
}

/** Carries out the plan, and reports what it did. */
export function prune(options: PruneOptions): PrunePlan {
  const plan = planPrune(options);
  for (const run of plan.swept) {
    rmSync(join(options.root, run.path), { recursive: true, force: true });
  }
  return plan;
}
