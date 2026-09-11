import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TenantConfigSchema } from "@icap/core";
import { repoRoot } from "../helpers/paths.js";

function loadNorthstar(): any {
  return JSON.parse(readFileSync(join(repoRoot, "config", "tenants", "northstar.json"), "utf8"));
}

function issuesOf(value: unknown): string {
  const result = TenantConfigSchema.safeParse(value);
  assert.equal(result.success, false, "expected this config to be rejected");
  return result.success ? "" : result.error.issues.map((i) => i.message).join(" | ");
}

test("the northstar profile is valid", () => {
  const result = TenantConfigSchema.safeParse(loadNorthstar());
  assert.equal(result.success, true, JSON.stringify(result));
});

test("every ambient outcome is global", () => {
  const tenant = TenantConfigSchema.parse(loadNorthstar());
  for (const outcome of tenant.ambientOutcomes) {
    assert.equal(outcome.after, undefined, `${outcome.code} should not bind to a step`);
  }
});

test("an ambient outcome may not bind to a step", () => {
  const config = loadNorthstar();
  config.ambientOutcomes[0].after = "search.submit";
  assert.match(issuesOf(config), /is global and must not set "after"/);
});

test("a credential must be an environment variable reference, not a value", () => {
  const config = loadNorthstar();
  config.auth.credentials.teller.password = "teller-pw";
  assert.equal(TenantConfigSchema.safeParse(config).success, false);
});

test("a recoverable ambient outcome must say how to recover", () => {
  const config = loadNorthstar();
  delete config.ambientOutcomes[0].recover;
  assert.match(issuesOf(config), /must declare a recover action/);
});

test("a hard_failure ambient outcome may not carry a recovery", () => {
  const config = loadNorthstar();
  const appError = config.ambientOutcomes.find((o: any) => o.code === "APP_ERROR");
  appError.recover = { action: "wait", ms: 1000 };
  assert.match(issuesOf(config), /must not declare a recover action/);
});

test("an override key must name a capability and a step", () => {
  const config = loadNorthstar();
  config.targetOverrides = { "member.lookup_savings_balance": { primary: { kind: "dom", selector: "a" } } };
  assert.match(issuesOf(config), /must be "<capabilityId>#<stepId>"/);
});

test("an inserted step is validated like any other step", () => {
  const config = loadNorthstar();
  config.stepInsertions = [
    {
      capabilityId: "member.lookup_savings_balance",
      beforeStepId: "search.submit",
      step: { id: "search.pick_branch", intent: "Choose the branch." },
    },
  ];
  assert.equal(TenantConfigSchema.safeParse(config).success, false, "a step with no action");
});

test("a well-formed inserted step is accepted", () => {
  const config = loadNorthstar();
  config.stepInsertions = [
    {
      capabilityId: "member.lookup_savings_balance",
      beforeStepId: "search.submit",
      step: {
        id: "search.pick_branch",
        intent: "Choose the branch this tenant requires.",
        action: { type: "select", value: "Downtown" },
        target: {
          primary: {
            kind: "ax",
            role: "combobox",
            name: { template: "Branch", match: "contains" },
            framePath: ["content"],
          },
        },
      },
    },
  ];
  assert.equal(TenantConfigSchema.safeParse(config).success, true);
});

test("a well-formed override key is accepted", () => {
  const config = loadNorthstar();
  config.targetOverrides = {
    "member.lookup_savings_balance#detail.open": {
      primary: { kind: "dom", selector: "a.view" },
    },
  };
  assert.equal(TenantConfigSchema.safeParse(config).success, true);
});
