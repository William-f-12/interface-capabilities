/**
 * Tenant profile: everything about one institution's deployment of an app that
 * a capability does not describe.
 *
 * Capabilities carry no tenant field. What varies per institution lives here —
 * the base URL, where credentials come from, the conditions every capability on
 * this app can meet, and the per-tenant patches to individual steps.
 */

import { z } from "zod";
import {
  AmbientOutcomeSchema,
  StateAssertionSchema,
  StepSchema,
  TargetSpecSchema,
} from "./schema.js";
import { isVersion } from "./version.js";

/** Names an environment variable. Credential values are never stored here. */
const CredentialRefSchema = z.object({
  username: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
  password: z.string().regex(/^env:[A-Z][A-Z0-9_]*$/),
});

export const TenantConfigSchema = z
  .object({
    apiVersion: z.literal("tenant/v1"),
    tenantId: z.string().regex(/^[a-z][a-z0-9_]*$/),
    displayName: z.string().min(1),

    /** Matched against a capability's `target.appVersion` range before a run. */
    app: z.string(),
    appVersion: z.string().refine(isVersion, { message: "not a version, e.g. 2.1.0" }),

    baseUrl: z.string().url(),

    auth: z.object({
      loginPath: z.string(),
      /** Role name -> where to read that role's credentials. */
      credentials: z.record(CredentialRefSchema),
      /**
       * The sign-in screen's controls, described the same way any other screen
       * is. Re-authenticating after a timeout is then the engine walking a
       * declared flow, not a branch of app-specific code inside it.
       */
      form: z.object({
        username: TargetSpecSchema,
        password: TargetSpecSchema,
        submit: TargetSpecSchema,
      }),
      /** Holds exactly when a session exists, and not on the sign-in screen. */
      signedIn: StateAssertionSchema,
    }),

    /** Conditions checked after every step, for every capability on this app. */
    ambientOutcomes: z.array(AmbientOutcomeSchema).default([]),

    /** "<capabilityId>#<stepId>" -> a replacement target for that step. */
    targetOverrides: z.record(TargetSpecSchema).default({}),

    /** Extra steps this tenant needs, inserted before the named step on load. */
    stepInsertions: z
      .array(
        z.object({
          capabilityId: z.string(),
          beforeStepId: z.string(),
          step: StepSchema,
        }),
      )
      .default([]),
  })
  .superRefine((cfg, ctx) => {
    for (const key of Object.keys(cfg.targetOverrides)) {
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*#[a-z][a-z0-9_.]*$/.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `targetOverrides key "${key}" must be "<capabilityId>#<stepId>"`,
        });
      }
    }
  });

export type TenantConfig = z.infer<typeof TenantConfigSchema>;
