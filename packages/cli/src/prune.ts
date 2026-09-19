/**
 * Sweep the evidence directory.
 *
 *   npm run prune               keep the newest few runs of each kind
 *   npm run prune -- --all      keep only what git tracks
 *   npm run prune -- --dry-run  say what would go, take nothing
 *
 * Every replay and every discovery run leaves a directory behind, so a week of
 * debugging buries the handful of runs worth reading. Git is the record of
 * which handful: those were force-added once and stay tracked. So this asks git
 * rather than guessing, and a run it cannot ask about is a run it will not take.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planPrune, prune, type EvidenceRun, type PrunePlan } from "@icap/core";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const EVIDENCE = join(repoRoot, "evidence");

const USAGE = `Usage:
  npm run prune -- [options]

Options:
  --keep <n>   untracked runs to keep of each kind (default 3)
  --all        keep none of them; the same as --keep 0
  --dry-run    print what a sweep would take, and take nothing
  --help       print this

A run git tracks is never swept, whatever its age. That is how the evidence
checked into the repository survives: it was force-added, so git knows it.
`;

/* ── arguments ───────────────────────────────────────────────────────────── */

/** Thrown for --help, so usage prints without looking like a failure. */
class HelpRequested extends Error {}

interface Args {
  keep: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { keep: 3, dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };

    switch (flag) {
      case "--keep": {
        const keep = Number(value());
        if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep needs a whole number");
        args.keep = keep;
        break;
      }
      case "--all":
        args.keep = 0;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        throw new Error(`unknown option: ${String(flag)}`);
    }
  }

  return args;
}

/* ── what git tracks ─────────────────────────────────────────────────────── */

/**
 * Paths under evidence/ that git tracks, relative to it. Null when git cannot
 * say — no repository, or no git — which is not the same answer as "nothing is
 * tracked" and must not be treated like it.
 */
function trackedPaths(): string[] | null {
  try {
    const listing = execFileSync("git", ["ls-files", "-z", "--", "evidence"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return listing
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => path.replace(/^evidence[\\/]/, ""));
  } catch {
    return null;
  }
}

/* ── reporting ───────────────────────────────────────────────────────────── */

function kilobytes(runs: EvidenceRun[]): string {
  const bytes = runs.reduce((total, run) => total + run.bytes, 0);
  return `${Math.round(bytes / 1024)} KB`;
}

function byPath(a: EvidenceRun, b: EvidenceRun): number {
  return a.path.localeCompare(b.path);
}

function report(plan: PrunePlan, dryRun: boolean): void {
  for (const run of [...plan.kept].sort(byPath)) {
    console.log(`  keep   ${run.path}${run.pinned ? "   (tracked)" : ""}`);
  }
  for (const run of [...plan.swept].sort(byPath)) {
    const note = run.files === 0 ? "   (empty)" : "";
    console.log(`  ${dryRun ? "would sweep" : "swept"} ${run.path}${note}`);
  }

  const verb = dryRun ? "would free" : "freed";
  console.log(
    `\n${plan.kept.length} run(s) kept, ${plan.swept.length} swept, ${verb} ${kilobytes(plan.swept)}`,
  );
}

/* ── running ─────────────────────────────────────────────────────────────── */

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const pin = trackedPaths();

  if (pin === null && !args.dryRun) {
    console.error("git could not say which runs are tracked, so nothing was swept.");
    console.error("Use --dry-run to see what a sweep would take.");
    return 1;
  }

  const options = { root: EVIDENCE, keep: args.keep, pin: pin ?? [] };
  report(args.dryRun ? planPrune(options) : prune(options), args.dryRun);
  return 0;
}

try {
  process.exit(main());
} catch (err: unknown) {
  if (err instanceof HelpRequested) {
    console.log(USAGE);
    process.exit(0);
  }
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  console.error(USAGE);
  process.exit(1);
}
