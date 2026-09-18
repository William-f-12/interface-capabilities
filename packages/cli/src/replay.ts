/**
 * Invoke a capability the way a production agent would, and leave evidence.
 *
 *   npm run replay -- --capability member.lookup_savings_balance \
 *                     --tenant northstar --input member_id=100005
 *
 * Exit status is the shape of the answer, not the shape of the run:
 *   0  the capability answered — it succeeded, or a declared business outcome
 *      stopped it, which is still an answer the caller asked for
 *   1  it failed
 *   2  it is suspended, waiting on a person
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilitySchema,
  TenantConfigSchema,
  replay,
  summarize,
  writeEvidence,
  type Capability,
  type TenantConfig,
} from "@icap/core";
import { WebSurface } from "@icap/core/web";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

const USAGE = `Usage:
  npm run replay -- --capability <id> --tenant <id> --input k=v [--input k=v] [options]

Options:
  --capability <id>   capability directory under capabilities/
  --version <file>    artifact file within it (default: the highest vN.json)
  --tenant <id>       profile under config/tenants/ (default: northstar)
  --input k=v         one caller input, as a string; repeat for more
  --input-json k=json one caller input that is not a string, e.g.
                      --input-json 'initial_deposit={"amount":"50.00","currency":"USD"}'
  --headed            show the browser
  --no-evidence       run without writing anything to evidence/
  --help              print this
`;

/* ── arguments ───────────────────────────────────────────────────────────── */

/** Thrown for --help, so usage prints without looking like a failure. */
class HelpRequested extends Error {}

interface Args {
  capability: string;
  version: string | null;
  tenant: string;
  inputs: Record<string, unknown>;
  headed: boolean;
  evidence: boolean;
}

function parseJsonInput(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`--input-json ${name}= is not valid JSON: ${raw}`);
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    capability: "",
    version: null,
    tenant: "northstar",
    inputs: {},
    headed: false,
    evidence: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--capability":
        args.capability = value ?? "";
        i += 1;
        break;
      case "--version":
        args.version = value ?? null;
        i += 1;
        break;
      case "--tenant":
        args.tenant = value ?? args.tenant;
        i += 1;
        break;
      case "--input":
      case "--input-json": {
        const [name, ...rest] = (value ?? "").split("=");
        if (!name || rest.length === 0) throw new Error(`${flag} wants k=v, got "${value}"`);
        const raw = rest.join("=");
        // A string stays a string: parsing every value would turn a member
        // number into a number and fail a contract that asks for digits.
        args.inputs[name] = flag === "--input" ? raw : parseJsonInput(name, raw);
        i += 1;
        break;
      }
      case "--headed":
        args.headed = true;
        break;
      case "--no-evidence":
        args.evidence = false;
        break;
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        throw new Error(`unknown option "${flag}"`);
    }
  }

  if (!args.capability) throw new Error("--capability is required");
  return args;
}

/* ── loading ─────────────────────────────────────────────────────────────── */

/** The highest vN.json, so a caller gets the current contract by default. */
function latestVersionFile(directory: string): string {
  const files = readdirSync(directory)
    .filter((name) => /^v\d+\.json$/.test(name))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
  const latest = files[files.length - 1];
  if (!latest) throw new Error(`no vN.json artifact in ${directory}`);
  return latest;
}

function loadCapability(id: string, version: string | null): Capability {
  const directory = join(repoRoot, "capabilities", id);
  const file = version ?? latestVersionFile(directory);
  return CapabilitySchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
}

function loadTenant(id: string): TenantConfig {
  const path = join(repoRoot, "config", "tenants", `${id}.json`);
  return TenantConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/* ── running ─────────────────────────────────────────────────────────────── */

const EXIT = { succeeded: 0, halted: 0, failed: 1, suspended: 2 } as const;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const capability = loadCapability(args.capability, args.version);
  const tenant = loadTenant(args.tenant);

  const surface = await WebSurface.launch({ baseUrl: tenant.baseUrl, headless: !args.headed });
  try {
    let result = await replay({ capability, tenant, inputs: args.inputs, surface });

    if (args.evidence) {
      result = await writeEvidence(result, { root: join(repoRoot, "evidence"), surface });
    }

    console.log(`\n${summarize(result)}`);
    if (result.status === "succeeded" || result.status === "halted") {
      console.log(`\n${JSON.stringify(result.outputs, null, 2)}`);
    }
    if (result.status === "failed") {
      console.error(`\nexpected: ${result.failure.expected}`);
      console.error(`observed: ${result.failure.observed}`);
    }
    if (result.evidenceRef) console.log(`\nevidence: evidence/${result.evidenceRef}`);

    return EXIT[result.status];
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
