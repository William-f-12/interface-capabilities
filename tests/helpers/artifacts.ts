/** The repository's own artifacts and tenant profiles, parsed for tests. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilitySchema,
  TenantConfigSchema,
  type Capability,
  type TenantConfig,
} from "@icap/core";
import { repoRoot } from "./paths.js";

function read(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(repoRoot, ...parts), "utf8"));
}

export function loadCapability(
  id = "member.lookup_savings_balance",
  file = "v1.json",
): Capability {
  return CapabilitySchema.parse(read("capabilities", id, file));
}

export function loadTenant(id = "northstar"): TenantConfig {
  return TenantConfigSchema.parse(read("config", "tenants", `${id}.json`));
}
