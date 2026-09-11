# Design write-up

> **Status: in progress.** Headings are fixed and match the brief; the prose under
> each is written in phase 4. Notes below record what each section must answer so
> nothing is lost between now and then.

## 1. Architecture

<!-- Required: the architecture and the key decisions plus trade-offs.

Must cover:
- The one seam that matters: Surface ("how we perceive and act on a surface")
  vs. Capability artifact ("the recorded flow"). Why artifacts contain no
  Playwright concepts, and what that buys.
- Why replay was built before discovery, using a hand-written artifact.
- Package boundary: @icap/core has zero dependency on targets/*, enforced by
  workspaces, so "the system does not know the target exists" is checkable.
- Single process, synchronous. Why that is the right size here, and what would
  have to change first if it were not.
- Recording is not distillation. The trace holds every attempt the model made;
  the artifact holds only the path that worked, with concrete values lifted into
  parameters. An artifact that still reads like a transcript has not been
  distilled — this is what "decoupled from the raw model transcript" costs.
- Discovery's stop conditions are named in DiscoveryBudget rather than left as
  constants: maxSteps, wallClockMs, and dead-end detection by hashing the
  observation after each action (N consecutive unchanged hashes means the agent
  is pressing something inert — cheaper and more reliable than asking the model
  whether it is stuck).
- maxObservationTokens is a budget, not a constant. How much of the screen the
  model is shown is the decision most likely to be tuned by feel and never
  written down: too much and the context fills with chrome, too little and the
  agent is blind. Making it a budget makes it defensible and puts it in the
  trace when a run goes wrong.
-->

## 2. Artifact schema

<!-- Required: the schema and why it was shaped that way. This is a focal point
of the evaluation.

Must cover:
- A capability is a contract, not a step list: typed inputs/outputs as JSON
  Schema (so inputs is directly usable as a calling agent's tool input_schema),
  declared outcomes, checkpoints, versioning, approval state.
- Locating decomposed into two orthogonal axes: kind (ax / text / dom / coords —
  the fallback ladder) and scope (row / labelled / tableCell / section). Why the
  first draft's `anchor` and `cell` kinds were scopes in disguise.
- Content-addressed targeting: "the row containing {{inputs.member_id}}", never
  "the first row". Templates interpolate with the value escaped; regular
  expressions are a separate, load-time-validated form.
- Extractions hang off a step's reached state rather than being steps.
- Cross-file checks performed at load: outcome.after and escalate.resumeFrom
  resolve to real steps, every required output is extracted, every
  {{inputs.x}} reference is declared. Authoring errors surface on load.
- draft vs approved: a draft is a contract without a recorded flow. Authoring
  the contract first is how member.open_sub_account was specified.
- Money is a decimal string, never a float. Binary floating point cannot
  represent 0.10, and this is a banking system.
- The cross-file checks have their own tests, which feed the schema deliberately
  broken artifacts. A validator that only ever sees valid input is
  indistinguishable from one that returns true.
- Code comments in this repository describe behaviour only. Design rationale
  lives in this document, which is where a reviewer looks for it.
-->

## 3. Determinism & error handling

<!-- Required: how replay is made deterministic, and how runtime errors and
exceptional states are detected and handled. UI drift is secondary.

Must cover:
- No model in the decision loop on replay. What "deterministic" does and does
  not promise.
- The fallback ladder, and that the rung actually used is recorded every time.
- Waiting is driven entirely by checkpoints — there is no causesNavigation flag
  and no fixed sleep.
- The three classes the brief asks for are the schema's outcome `kind`
  one-to-one: business_outcome / recoverable / hard_failure. Undeclared
  breakage is a hard failure by default.
- The result contract has FOUR terminal states, not three. `suspended` is
  separate because a caller that cannot tell "a human is working on this" from
  "this failed" will retry work someone is in the middle of.
- Recovering from a recoverable condition does not change how a run ends, so it
  is not a status — it is reported in `recoveries`. A recoverable condition that
  exhausts its attempts stops being recoverable and becomes RECOVERY_EXHAUSTED.
- `status` and `observedOutcomes` are separate for a reason worth stating:
  ACCOUNT_RESTRICTED is declared `onDetect: "continue"`, so the run both
  succeeds and carries something the caller must know. A single status enum
  would have to drop one of those two facts.
- `resolvedBy` records which rung of the ladder actually resolved each target.
  A step that has always resolved by `ax` and starts resolving by `dom` is still
  passing, but the screen moved — the cheapest drift alarm available, and the
  basis a stability score would be computed from.
- `decisionSource: "artifact"` is an assertion carried in every result: no model
  took part in any decision. If bounded assisted recovery is ever enabled it
  reads "artifact+assisted" and names the affected step.
- `summarize()` exists so the four statuses render consistently and nobody
  flattens "halted" into "failed" at the presentation layer.
- The checkpoint anyOf case: after a search, both a results table and a
  "no members found" alert are legitimate. Asserting only the first is how a
  business outcome gets misreported as a failure — the most common way to get
  this wrong, and it happens in checkpoint design, not in a catch block.
- Coercion failures are hard failures. An unmapped account status is never
  handed back as null, because the caller will act on it.
- Budgets: per-condition maxAttempts is a property of the phenomenon and lives
  in the artifact; run-wide recovery count and wall-clock live in the run
  budget, because patience is a property of an execution context. The same
  outcome firing twice at one step escalates to a hard failure.
-->

## 4. Heterogeneity & multi-tenant

<!-- Required: how the design extends to legacy web and desktop surfaces, and to
reuse across institutions running the same app.

Must cover:
- The Surface interface as the extension point; why the accessibility tree is
  the primary locator axis (it exists on desktop too, and survives table-based
  markup with no test ids).
- Capabilities are tenant-agnostic by construction — there is no tenant field on
  an artifact.
- Ambient outcomes (session timeout, notice interstitial, permission denied, app
  error) belong to the deployment, not to "look up a balance", so they live in
  the tenant profile and are declared once for all capabilities.
- targetOverrides keyed by "<capabilityId>#<stepId>" and stepInsertions: the
  per-tenant patch. Onboarding institution #300 is one new file, not edits to 20
  artifacts. State the cost: a validated cross-file reference.
- Drift: appVersion range on the capability vs. appVersion on the tenant.
-->

## 5. Escalation & handoff

<!-- Required: how "stuck" is detected, how a human takes control of the live
session, and how control is handed back.

Must cover:
- Escalation is a recovery action in the same outcome taxonomy, not a special
  case bolted onto the engine — `{ action: "escalate", reason, requiredRole,
  resumeFrom }`.
- The motivating case is structural, not a limitation: a supervisor
  authorization code is something the automation must never hold. Detecting it
  is not the agent failing.
- Same live session, not a fresh one: headful persistent context, automation
  pauses, the person acts in the window that is already open, then signals
  resume and the run continues on the same page object.
- The control-transfer model: who holds control, how that is represented, how
  the human's actions are captured into evidence, what resumeFrom guarantees.
- What is mocked (the operator console) and what is real (the transfer).
-->

## 6. Safety

<!-- Required: the guardrail model and its limits.

Must cover:
- Allowlist: permitted origins/routes and permitted action types, checked before
  every act, not just at the start.
- risk: read_only / reversible / irreversible on the capability, and what each
  class is allowed to do unattended.
- Credentials exist only as env: indirection in tenant configs; resolved values
  are registered with the redactor and scrubbed from logs, traces, evidence and
  screenshots.
- Unmapped enum values fail hard rather than reaching the caller as null.
- Limits — say them plainly. Where the allowlist can be circumvented, what
  redaction cannot catch, what an approved artifact does not guarantee.
-->

## 7. Cuts

<!-- Required: what was deliberately left out, and what would come next.

Must cover:
- What was mocked and why, at which seam.
- The hand-written reference artifact and its role.
- Stretch goals not taken.
- The honest next three things.
-->
