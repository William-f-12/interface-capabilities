/**
 * Parse every capability artifact and tenant profile, and check that their
 * cross-file references resolve.
 *
 *   npm run validate
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CapabilitySchema, TenantConfigSchema, type Capability } from "@icap/core";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const capabilitiesDir = join(repoRoot, "capabilities");
const tenantsDir = join(repoRoot, "config", "tenants");

let failures = 0;

function report(label: string, err: unknown): void {
  failures += 1;
  console.error(`\n  FAIL  ${label}`);
  if (err instanceof z.ZodError) {
    for (const issue of err.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      console.error(`        ${path}: ${issue.message}`);
    }
  } else {
    console.error(`        ${String(err)}`);
  }
}

/* ── capabilities ────────────────────────────────────────────────────────── */

const capabilities = new Map<string, Capability>();

if (existsSync(capabilitiesDir)) {
  for (const dir of readdirSync(capabilitiesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(capabilitiesDir, dir.name))) {
      if (!file.endsWith(".json")) continue;
      const label = `capabilities/${dir.name}/${file}`;
      try {
        const raw = JSON.parse(readFileSync(join(capabilitiesDir, dir.name, file), "utf8"));
        const capability = CapabilitySchema.parse(raw);
        if (capability.id !== dir.name) {
          throw new Error(`id "${capability.id}" does not match its directory "${dir.name}"`);
        }
        capabilities.set(`${capability.id}@${capability.version}`, capability);
        const shape =
          capability.steps.length === 0 ? "contract only" : `${capability.steps.length} steps`;
        console.log(`  ok    ${label}  (${capability.risk}, ${capability.approval}, ${shape})`);
      } catch (err) {
        report(label, err);
      }
    }
  }
}

function findCapability(id: string): Capability | undefined {
  return [...capabilities.values()].find((c) => c.id === id);
}

/* ── tenants ─────────────────────────────────────────────────────────────── */

if (existsSync(tenantsDir)) {
  for (const file of readdirSync(tenantsDir)) {
    if (!file.endsWith(".json")) continue;
    const label = `config/tenants/${file}`;
    try {
      const raw = JSON.parse(readFileSync(join(tenantsDir, file), "utf8"));
      const tenant = TenantConfigSchema.parse(raw);

      // Overrides and insertions name a capability and a step in another file.
      for (const key of Object.keys(tenant.targetOverrides)) {
        const [capabilityId, stepId] = key.split("#");
        const capability = findCapability(capabilityId ?? "");
        if (!capability) {
          throw new Error(`targetOverrides "${key}" names unknown capability "${capabilityId}"`);
        }
        if (!capability.steps.some((s) => s.id === stepId)) {
          throw new Error(`targetOverrides "${key}" names unknown step "${stepId}"`);
        }
      }
      for (const insertion of tenant.stepInsertions) {
        const capability = findCapability(insertion.capabilityId);
        if (!capability) {
          throw new Error(`stepInsertion names unknown capability "${insertion.capabilityId}"`);
        }
        if (!capability.steps.some((s) => s.id === insertion.beforeStepId)) {
          throw new Error(`stepInsertion names unknown step "${insertion.beforeStepId}"`);
        }
      }

      const ambient = tenant.ambientOutcomes.map((o) => o.code).join(", ");
      console.log(`  ok    ${label}  (${tenant.app}@${tenant.appVersion}; ambient: ${ambient})`);
    } catch (err) {
      report(label, err);
    }
  }
}

/* ── summary ─────────────────────────────────────────────────────────────── */

console.log("");
if (failures > 0) {
  console.error(`${failures} file(s) failed validation.`);
  process.exit(1);
}
console.log(`${capabilities.size} capabilit(ies) and all tenant profiles validated.`);
