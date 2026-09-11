/**
 * Drives the fixture through the Surface. The locators come from the
 * hand-written capability, so a pass also says that artifact resolves against
 * the real screens.
 *
 *   npm run target              # in another terminal
 *   npm run test:integration    # SURFACE_HEADED=1 to watch it
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilitySchema,
  TenantConfigSchema,
  holds,
  resolveWhenReady,
  waitUntil,
  type AriaRole,
  type BindingContext,
  type Capability,
  type Step,
  type TargetSpec,
  type TenantConfig,
} from "@icap/core";
import { WebSurface } from "@icap/core/web";
import { repoRoot } from "../helpers/paths.js";

const capability: Capability = CapabilitySchema.parse(
  JSON.parse(
    readFileSync(
      join(repoRoot, "capabilities", "member.lookup_savings_balance", "v1.json"),
      "utf8",
    ),
  ),
);
const tenant: TenantConfig = TenantConfigSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, "config", "tenants", "northstar.json"), "utf8")),
);

const ctx: BindingContext = { inputs: { member_id: "100005" } };
const TIMEOUT = 5000;

let surface: WebSurface;

function stepOf(id: string): Step {
  const step = capability.steps.find((s) => s.id === id);
  if (!step) throw new Error(`capability has no step "${id}"`);
  return step;
}

function targetOf(id: string): TargetSpec {
  const target = stepOf(id).target;
  if (!target) throw new Error(`step "${id}" has no target`);
  return target;
}

function contextFor(memberId: string): BindingContext {
  return { inputs: { member_id: memberId } };
}

async function clickTarget(id: string, context: BindingContext = ctx): Promise<string> {
  const resolved = await resolveWhenReady(surface, targetOf(id), context, TIMEOUT);
  assert.ok(resolved, `could not resolve the target of step "${id}"`);
  const description = await surface.describe(resolved.ref);
  await surface.click(resolved.ref);
  return description;
}

async function checkpointOf(id: string, context: BindingContext = ctx): Promise<boolean> {
  const checkpoint = stepOf(id).checkpoint;
  assert.ok(checkpoint, `step "${id}" has no checkpoint`);
  return waitUntil(surface, checkpoint, context, { timeoutMs: TIMEOUT });
}

function outcomeOf(code: string) {
  const outcome =
    capability.outcomes.find((o) => o.code === code) ??
    tenant.ambientOutcomes.find((o) => o.code === code);
  assert.ok(outcome, `no outcome named ${code}`);
  return outcome;
}

async function findByRole(role: AriaRole, name: string, framePath: string[]) {
  return surface.find(
    { kind: "ax", role, name: { template: name, match: "contains" }, framePath },
    ctx,
  );
}

async function signIn(): Promise<void> {
  await surface.navigate("/login");
  const user = await findByRole("textbox", "User ID", []);
  const password = await findByRole("textbox", "Password", []);
  assert.ok(user && password, "sign-in fields not found");
  await surface.fill(user, "teller", true);
  await surface.fill(password, "teller-pw", true);
  const button = await findByRole("button", "Sign In", []);
  assert.ok(button);
  await surface.click(button);
  await surface.page.waitForLoadState("domcontentloaded");
}

async function openSearchScreen(): Promise<void> {
  await clickTarget("nav.member_search");
  assert.equal(await checkpointOf("nav.member_search"), true);
}

async function searchFor(memberId: string, lastName: string): Promise<void> {
  const idField = await resolveWhenReady(surface, targetOf("search.fill_member_id"), ctx, TIMEOUT);
  assert.ok(idField, "member id field not found");
  await surface.fill(idField.ref, memberId, true);

  if (lastName) {
    const nameField = await findByRole("textbox", "Last Name", ["content"]);
    assert.ok(nameField);
    await surface.fill(nameField, lastName, true);
  }

  await clickTarget("search.submit");
  assert.equal(await checkpointOf("search.submit"), true);
}

async function armChaos(mode: string, times = "1"): Promise<void> {
  const cookies = await surface.page.context().cookies();
  await fetch(`${tenant.baseUrl}/_chaos?mode=${mode}&times=${times}`, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
  });
}

before(async () => {
  const probe = await fetch(`${tenant.baseUrl}/login`).catch(() => null);
  if (!probe?.ok) {
    throw new Error(`The fixture is not answering at ${tenant.baseUrl}. Run: npm run target`);
  }
  surface = await WebSurface.launch({
    baseUrl: tenant.baseUrl,
    headless: process.env.SURFACE_HEADED !== "1",
  });
  await signIn();
});

after(async () => {
  await surface?.close();
});

test("the accessibility snapshot names controls the markup does not", async () => {
  await surface.navigate("/login");
  const observation = await surface.observe();
  const tree = observation.frames[0]?.tree ?? "";

  assert.match(tree, /heading "Please sign in"/);
  assert.match(tree, /textbox "User ID"/);
  // The sign-in control is an <input type="image">, with no text of its own.
  assert.match(tree, /button "Sign In"/);
  await signIn();
});

test("an unchanged screen produces an unchanged hash", async () => {
  const first = await surface.observe();
  const second = await surface.observe();
  assert.equal(first.hash, second.hash);
});

test("frames are traversed and addressed by name", async () => {
  const observation = await surface.observe();
  const paths = observation.frames.map((f) => f.path.join("/"));
  assert.deepEqual(paths, ["", "nav", "content"]);
});

test("a locator for a frame that is not there returns null instead of throwing", async () => {
  const found = await surface.find(
    { kind: "ax", role: "heading", framePath: ["nowhere"] },
    ctx,
  );
  assert.equal(found, null);
});

test("the artifact's locators resolve on the real screens", async () => {
  await openSearchScreen();
  const resolved = await resolveWhenReady(surface, targetOf("search.fill_member_id"), ctx, TIMEOUT);
  assert.equal(resolved?.resolution.rung, "primary");
  assert.equal(resolved?.resolution.kind, "ax");
});

test("the same control is hit through two different generated ids", async () => {
  const seen: string[] = [];

  await openSearchScreen();
  await searchFor("100005", "");
  seen.push(await clickTarget("detail.open"));
  assert.equal(await checkpointOf("detail.open"), true);

  await openSearchScreen();
  await searchFor("", "a");
  seen.push(await clickTarget("detail.open"));
  assert.equal(await checkpointOf("detail.open"), true);

  assert.notEqual(seen[0], seen[1], "the fixture should have renumbered the control");
  assert.match(seen[0] ?? "", /grdMembers_ctl\d+_lnkView/);
  assert.match(seen[1] ?? "", /grdMembers_ctl\d+_lnkView/);
});

test("typed values are read out of a table-layout screen", async () => {
  await openSearchScreen();
  await searchFor("100005", "");
  await clickTarget("detail.open");
  assert.equal(await checkpointOf("detail.open"), true);

  await clickTarget("detail.open_accounts_tab");
  assert.equal(await checkpointOf("detail.open_accounts_tab"), true);

  const values = new Map<string, string>();
  for (const extraction of stepOf("detail.open_accounts_tab").extract) {
    const ref = await surface.find(extraction.target, ctx);
    assert.ok(ref, `could not locate ${extraction.to}`);
    values.set(extraction.to, await surface.textOf(ref));
  }

  assert.equal(values.get("member_name"), "Priya Raman");
  assert.equal(values.get("savings_balance"), "$45,000.00");
  assert.equal(values.get("account_status"), "Active");
});

test("a search with no matches shows the alert the artifact declares", async () => {
  await openSearchScreen();
  await searchFor("999999", "");
  assert.equal(await holds(surface, outcomeOf("MEMBER_NOT_FOUND").detect, ctx), true);
});

test("the not-found detector does not fire on a search that found someone", async () => {
  await openSearchScreen();
  await searchFor("100005", "");
  assert.equal(await holds(surface, outcomeOf("MEMBER_NOT_FOUND").detect, ctx), false);
});

test("a restricted account is detected while the balance stays readable", async () => {
  const restricted = contextFor("100002");
  await openSearchScreen();
  await searchFor("100002", "");
  await clickTarget("detail.open", restricted);
  assert.equal(await checkpointOf("detail.open", restricted), true);

  assert.equal(await holds(surface, outcomeOf("ACCOUNT_RESTRICTED").detect, restricted), true);

  await clickTarget("detail.open_accounts_tab", restricted);
  assert.equal(await checkpointOf("detail.open_accounts_tab", restricted), true);
  const balance = stepOf("detail.open_accounts_tab").extract.find(
    (e) => e.to === "savings_balance",
  );
  assert.ok(balance);
  const ref = await surface.find(balance.target, restricted);
  assert.ok(ref, "the balance should still be readable on a restricted account");
  assert.equal(await surface.textOf(ref), "$3,205.00");
});

test("a restricted account is not reported for an unrestricted one", async () => {
  await openSearchScreen();
  await searchFor("100005", "");
  await clickTarget("detail.open");
  assert.equal(await checkpointOf("detail.open"), true);
  assert.equal(await holds(surface, outcomeOf("ACCOUNT_RESTRICTED").detect, ctx), false);
});

test("a permission denial is detected as a business outcome, not a crash", async () => {
  const denied = outcomeOf("PERMISSION_DENIED");
  assert.equal(denied.kind, "business_outcome");

  await armChaos("permission_denied");
  await clickTarget("nav.member_search");
  assert.equal(
    await waitUntil(surface, denied.detect, ctx, { timeoutMs: TIMEOUT, anyFrame: true }),
    true,
  );
});

test("a session timeout is detected wherever the sign-in form renders", async () => {
  const expired = outcomeOf("SESSION_EXPIRED");

  await armChaos("session_expired");
  await clickTarget("nav.member_search");
  assert.equal(
    await waitUntil(surface, expired.detect, ctx, { timeoutMs: TIMEOUT, anyFrame: true }),
    true,
  );
  await signIn();
});

test("an ambient detector with no framePath finds a condition inside a frame", async () => {
  const notice = tenant.ambientOutcomes.find((o) => o.code === "SYSTEM_NOTICE_INTERSTITIAL");
  assert.ok(notice);

  await openSearchScreen();
  assert.equal(await holds(surface, notice.detect, ctx, { anyFrame: true }), false);

  await armChaos("notice");
  await clickTarget("nav.member_search");
  assert.equal(
    await waitUntil(surface, notice.detect, ctx, { timeoutMs: TIMEOUT, anyFrame: true }),
    true,
  );

  const dismiss = notice.recover;
  assert.ok(dismiss?.action === "dismiss");
  const button = await resolveWhenReady(surface, dismiss.target, ctx, TIMEOUT, { anyFrame: true });
  assert.ok(button, "the notice's Continue button should resolve");
  await surface.click(button.ref);
  assert.equal(await checkpointOf("nav.member_search"), true);
});

test("an injected application error is detected as the declared hard failure", async () => {
  const appError = outcomeOf("APP_ERROR");

  await armChaos("app_error");
  await clickTarget("nav.member_search");
  assert.equal(
    await waitUntil(surface, appError.detect, ctx, { timeoutMs: TIMEOUT, anyFrame: true }),
    true,
  );
});

test("a non-numeric times still arms exactly one render", async () => {
  const appError = outcomeOf("APP_ERROR");

  await armChaos("app_error", "abc");
  await clickTarget("nav.member_search");
  assert.equal(
    await waitUntil(surface, appError.detect, ctx, { timeoutMs: TIMEOUT, anyFrame: true }),
    true,
    "the fault should still fire once",
  );

  await clickTarget("nav.member_search");
  assert.equal(await checkpointOf("nav.member_search"), true, "and clear itself afterwards");
});
