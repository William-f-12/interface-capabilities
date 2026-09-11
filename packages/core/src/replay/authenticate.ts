/**
 * Establishing a session, from the tenant profile alone.
 *
 * Sign-in is the one flow no capability describes, because every capability
 * assumes it. It is described by the tenant instead, in the same locator
 * vocabulary as everything else, so recovering from a session timeout is the
 * engine walking a declared flow rather than a special case inside it.
 */

import type { TenantConfig } from "../artifact/tenant.js";
import { waitUntil } from "../surface/assert.js";
import { resolveWhenReady } from "../surface/resolve.js";
import type { Surface } from "../surface/types.js";

export type SignInResult = { ok: true } | { ok: false; reason: string };

/** Signs in as a role, or says why it could not. Never throws at the caller. */
export type SignIn = (role: string | undefined) => Promise<SignInResult>;

export interface SignInOptions {
  timeoutMs?: number;
  /** Overridden in tests; credential values are never read from the profile. */
  env?: Record<string, string | undefined>;
}

function readEnvRef(ref: string, env: Record<string, string | undefined>): string | null {
  const name = ref.slice("env:".length);
  const value = env[name];
  return value === undefined || value === "" ? null : value;
}

export function tenantSignIn(
  surface: Surface,
  tenant: TenantConfig,
  options: SignInOptions = {},
): SignIn {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env = options.env ?? process.env;
  const ctx = { inputs: {} };

  return async (role) => {
    const roles = Object.keys(tenant.auth.credentials);
    // A capability that names no role is unambiguous only when the tenant has
    // exactly one sign-in to offer.
    const chosen = role ?? (roles.length === 1 ? roles[0] : undefined);
    if (!chosen) {
      return {
        ok: false,
        reason: `the capability names no role and ${tenant.tenantId} declares ${roles.length}: ${roles.join(", ")}`,
      };
    }

    const credentials = tenant.auth.credentials[chosen];
    if (!credentials) {
      return { ok: false, reason: `${tenant.tenantId} has no credentials for role "${chosen}"` };
    }

    const username = readEnvRef(credentials.username, env);
    const password = readEnvRef(credentials.password, env);
    if (username === null || password === null) {
      const missing = [
        username === null ? credentials.username : null,
        password === null ? credentials.password : null,
      ].filter((ref) => ref !== null);
      return { ok: false, reason: `not set in the environment: ${missing.join(", ")}` };
    }

    await surface.navigate(tenant.auth.loginPath);

    const form = tenant.auth.form;
    const userField = await resolveWhenReady(surface, form.username, ctx, timeoutMs);
    if (!userField) return { ok: false, reason: "the sign-in screen has no user field" };
    await surface.fill(userField.ref, username, true);

    const passwordField = await resolveWhenReady(surface, form.password, ctx, timeoutMs);
    if (!passwordField) return { ok: false, reason: "the sign-in screen has no password field" };
    await surface.fill(passwordField.ref, password, true);

    const submit = await resolveWhenReady(surface, form.submit, ctx, timeoutMs);
    if (!submit) return { ok: false, reason: "the sign-in screen has no submit control" };
    await surface.click(submit.ref);

    // The profile says where a session shows itself, so that is where it is
    // looked for — no wider search that a stray control could satisfy.
    const signedIn = await waitUntil(surface, tenant.auth.signedIn, ctx, { timeoutMs });
    if (!signedIn) {
      return { ok: false, reason: `signing in as "${chosen}" did not produce a session` };
    }
    return { ok: true };
  };
}
