/**
 * Record a capability by letting a model find it, and leave the evidence.
 *
 *   npm run discover -- --contract capabilities/member.lookup_savings_balance/v1.json \
 *                       --input member_id=100005
 *
 * The contract comes first and the flow is what gets discovered: the file named
 * by --contract supplies the id, the version, the inputs and the outputs, and
 * its steps — if it has any — are ignored. That is what makes the run's output
 * comparable with a hand-written one, and it is what tells the compiler which
 * values on screen were parameters rather than coincidences.
 *
 * Exit status:
 *   0  the goal was reached and an artifact was compiled
 *   1  it stopped for any other reason, and no artifact was written
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilitySchema,
  TenantConfigSchema,
  compileArtifact,
  discover,
  fileTrace,
  renderObservation,
  tenantSignIn,
  type Capability,
  type DiscoverOutcome,
  type Model,
  type Observation,
  type TenantConfig,
} from "@icap/core";
import { AnthropicModel, DEFAULT_MODEL as ANTHROPIC_MODEL } from "@icap/core/anthropic";
import { DEEPSEEK_MODEL, deepSeekModel } from "@icap/core/openai-compatible";
import { WebSurface } from "@icap/core/web";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

const USAGE = `Usage:
  npm run discover -- --contract <path> --input k=v [options]

Options:
  --contract <path>   a capability artifact supplying the contract; its steps are ignored
  --tenant <id>       profile under config/tenants/ (default: northstar)
  --goal <text>       what to achieve (default: taken from the contract's description)
  --input k=v         one caller input, as a string; repeat for more
  --input-json k=json one caller input that is not a string
  --provider <name>   anthropic | deepseek (default: whichever key is present)
  --model <id>        model to decide with (default: ${ANTHROPIC_MODEL} or ${DEEPSEEK_MODEL})
  --max-steps <n>     ceiling on observe/decide/act iterations (default: 40)
  --headed            show the browser
  --help              print this
`;

class HelpRequested extends Error {}

type Provider = "anthropic" | "deepseek";

interface Args {
  contract: string;
  tenant: string;
  goal: string | null;
  inputs: Record<string, unknown>;
  provider: Provider | null;
  model: string | null;
  maxSteps: number | null;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    contract: "",
    tenant: "northstar",
    goal: null,
    inputs: {},
    provider: null,
    model: null,
    maxSteps: null,
    headed: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--contract":
        args.contract = value ?? "";
        i += 1;
        break;
      case "--tenant":
        args.tenant = value ?? args.tenant;
        i += 1;
        break;
      case "--goal":
        args.goal = value ?? null;
        i += 1;
        break;
      case "--provider":
        if (value !== "anthropic" && value !== "deepseek") {
          throw new Error(`--provider wants anthropic or deepseek, got "${value}"`);
        }
        args.provider = value;
        i += 1;
        break;
      case "--model":
        args.model = value ?? null;
        i += 1;
        break;
      case "--max-steps": {
        const steps = Number(value);
        if (!Number.isInteger(steps) || steps < 1) throw new Error(`--max-steps wants a count`);
        args.maxSteps = steps;
        i += 1;
        break;
      }
      case "--input":
      case "--input-json": {
        const [name, ...rest] = (value ?? "").split("=");
        if (!name || rest.length === 0) throw new Error(`${flag} wants k=v, got "${value}"`);
        const raw = rest.join("=");
        args.inputs[name] = flag === "--input" ? raw : JSON.parse(raw);
        i += 1;
        break;
      }
      case "--headed":
        args.headed = true;
        break;
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        throw new Error(`unknown option "${flag}"`);
    }
  }

  if (!args.contract) throw new Error("--contract is required");
  return args;
}

function loadContract(path: string): Capability {
  return CapabilitySchema.parse(JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")));
}

function loadTenant(id: string): TenantConfig {
  return TenantConfigSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, "config", "tenants", `${id}.json`), "utf8")),
  );
}

/* ── the record a reviewer reads ─────────────────────────────────────────── */

function summaryOf(
  outcome: DiscoverOutcome,
  args: Args,
  compiled: string | null,
  reason: string | null,
): string {
  const { result } = outcome;
  const lines = [
    `# Discovery — ${result.capabilityId} on ${result.tenantId}`,
    ``,
    `- goal: ${result.goal}`,
    `- stopped because: **${result.stopReason}**`,
    `- decided by: \`${result.model}\``,
    `- steps taken: ${result.stepsTaken} of ${result.budget.maxSteps}`,
    `- model tokens: ${result.modelTokensUsed}`,
    `- duration: ${result.durationMs}ms`,
    `- inputs: \`${JSON.stringify(args.inputs)}\``,
    ``,
    `## The flow that was found`,
    ``,
  ];

  if (outcome.steps.length === 0) {
    lines.push("None. A run that does not reach its goal produces no flow.");
  } else {
    lines.push("| # | action | why |", "| --- | --- | --- |");
    outcome.steps.forEach((step, i) => {
      lines.push(`| ${i + 1} | ${step.action.kind} | ${step.action.why} |`);
    });
  }

  lines.push(
    ``,
    `## Artifact`,
    ``,
    compiled
      ? `Compiled to \`artifact.json\`. It is a **draft**: nothing a model wrote is approved by writing it.`
      : `Not compiled — ${reason ?? "the run did not reach its goal"}.`,
    ``,
    `## What this run did not establish`,
    ``,
    `- **No outcomes.** The run walked one path with one set of inputs, so it saw no`,
    `  business outcome and the artifact declares none. Replaying it against an input`,
    `  that produces one will report a missing checkpoint rather than the outcome.`,
    `- **Enum maps cover only what was on screen.** A display value this run never saw`,
    `  is left unmapped and fails loudly rather than being guessed at.`,
    `- **The full attempt history is in \`trace.jsonl\`,** including the guesses that did`,
    `  not work out. The artifact deliberately contains none of them.`,
    ``,
  );
  return lines.join("\n");
}

/* ── who decides ─────────────────────────────────────────────────────────── */

/**
 * The `Model` seam is why this is a choice at all: the loop, the compiler and
 * the replay engine are unchanged by it. Defaulting to whichever key is present
 * means a clone with either one works without a flag.
 */
function chooseModel(args: Args): Model {
  const has = (name: string): boolean => (process.env[name] ?? "").trim() !== "";
  const provider: Provider | null =
    args.provider ??
    (has("ANTHROPIC_API_KEY") ? "anthropic" : has("DEEPSEEK_API_KEY") ? "deepseek" : null);

  if (provider === null) {
    throw new Error(
      "no model key found — set ANTHROPIC_API_KEY or DEEPSEEK_API_KEY in .env " +
        "(replay needs neither; only discovery calls a model)",
    );
  }
  if (provider === "deepseek") {
    return deepSeekModel(args.model ? { model: args.model } : {});
  }
  return new AnthropicModel(args.model ? { model: args.model } : {});
}

/* ── running ─────────────────────────────────────────────────────────────── */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const contract = loadContract(args.contract);
  const tenant = loadTenant(args.tenant);
  const goal = args.goal ?? contract.description;

  // Down to the second, so a second run today writes beside the first rather
  // than over it. Evidence that a run can overwrite is not evidence.
  const clock = new Date().toISOString();
  const runId = `${clock.slice(0, 10)}T${clock.slice(11, 19).replace(/:/g, "")}Z-${contract.id}`;
  const relative = join("discovery", runId);
  const directory = join(repoRoot, "evidence", relative);
  mkdirSync(join(directory, "steps"), { recursive: true });

  const model = chooseModel(args);
  const surface = await WebSurface.launch({ baseUrl: tenant.baseUrl, headless: !args.headed });

  try {
    if (contract.preconditions.authenticated) {
      const session = await tenantSignIn(surface, tenant, { timeoutMs: 15_000 })(
        contract.preconditions.role,
      );
      if (!session.ok) throw new Error(`could not sign in: ${session.reason}`);
    }

    const outcome = await discover({
      contract,
      tenant,
      inputs: args.inputs,
      goal,
      surface,
      model,
      ...(args.maxSteps === null ? {} : { budget: { maxSteps: args.maxSteps } }),
      trace: fileTrace(join(directory, "trace.jsonl")),
      onObservation: async (seq: number, observation: Observation) => {
        const n = String(seq).padStart(2, "0");
        writeFileSync(
          join(directory, "steps", `${n}-screen.txt`),
          `${renderObservation(observation, 20_000)}\n`,
          "utf8",
        );
        writeFileSync(join(directory, "steps", `${n}-screen.png`), await surface.screenshot());
      },
      runId,
    });

    const compiled = compileArtifact(contract, outcome.steps, args.inputs, {
      model: model.name,
      traceRef: relative.split(/[\\/]/).join("/"),
    });

    const artifactPath = compiled.ok ? join(directory, "artifact.json") : null;
    if (compiled.ok && artifactPath) {
      writeFileSync(artifactPath, `${JSON.stringify(compiled.capability, null, 2)}\n`, "utf8");
    }
    writeFileSync(
      join(directory, "summary.md"),
      summaryOf(outcome, args, artifactPath, compiled.ok ? null : compiled.reason),
      "utf8",
    );

    console.log(`\n${outcome.result.stopReason} after ${outcome.result.stepsTaken} step(s)`);
    console.log(`evidence: evidence/${relative.split(/[\\/]/).join("/")}`);
    if (!compiled.ok) {
      console.error(`\nno artifact: ${compiled.reason}`);
      return 1;
    }
    console.log(`artifact: ${compiled.capability.steps.length} step(s), draft, awaiting review`);
    return outcome.result.stopReason === "goal_reached" ? 0 : 1;
  } finally {
    await surface.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof HelpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    console.error(USAGE);
    process.exit(1);
  });
