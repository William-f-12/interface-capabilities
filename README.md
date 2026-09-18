# interface-capabilities

Record-once, replay-many computer-use automation for back-office applications
that have no API.

A model drives a real UI to accomplish a goal the first time. The successful run
is distilled into a **capability** — a typed, versioned contract describing the
flow, how each control is identified, what inputs it takes and what it returns.
After that the capability is replayed with no model in the decision loop, which
is how a production agent invokes it: reliably, cheaply, and without re-reasoning
about the screen every time.

> **Status: in progress.** The capability schema, the target fixture and the
> replay engine are done — a hand-written artifact replays deterministically and
> returns typed outputs, and every declared condition lands in one of the four
> result states. The discovery agent and the human-handoff path are next. See
> `REPORT.md` for the design write-up.

## Layout

| Path | What it is |
| --- | --- |
| `packages/core/` | The system: surfaces, artifacts, discovery, replay, policy, handoff. Has **no dependency** on `targets/*`. |
| `packages/cli/` | Entry points — `discover`, `replay`, `operator`, `catalog`. |
| `capabilities/` | Saved capability artifacts, versioned. Also the catalogue a calling agent would browse. |
| `config/tenants/` | Per-institution profiles: base URL, credential references, ambient outcomes, per-tenant overrides. |
| `targets/legacy-core/` | **A test fixture, not the deliverable.** A deliberately hostile stand-in for a legacy core banking UI — framesets, generated element ids, table layout, no test ids, full-page postbacks, injectable runtime failures. Fabricated data only. |
| `evidence/` | Logs, screenshots and artifacts from real discovery and replay runs. |

## Setup

Node 22.11 or later.

```
npm install
npx playwright install chromium
cp .env.example .env      # the fixture's published demo credentials
```

Windows works too. In `cmd.exe` the third line is `copy .env.example .env`;
PowerShell and Git Bash take `cp` as written.

`ANTHROPIC_API_KEY` is required **only** for a discovery run. Replay never calls a
model, so the demo's replay half runs with no key and no network.

### What runs today

```
npm run lint                 # ESLint over every TypeScript source
npm run typecheck            # every package plus the tests, strict
npm run validate             # parse every capability and tenant profile, and
                             # check their cross-references resolve
npm test                     # unit tests; no browser, no server
```

Integration tests and replay need the fixture running:

```
npm run target               # terminal 1 — http://localhost:4173, Ctrl+C to stop
npm run test:integration     # terminal 2 — SURFACE_HEADED=1 to watch it
npm run replay -- --help     # terminal 2 — invoke a capability; see Demo path
```

`validate` is worth running on every change: half of what makes an artifact
reviewable is that its internal references hold — an outcome pointing at a step
that exists, a required output that something actually extracts — and none of
that is visible by reading the JSON.

### Tests

| Path | Needs | Covers |
| --- | --- | --- |
| `tests/unit/` | nothing | schema guards, version ranges, template interpolation and escaping, assertion evaluation, the fallback ladder, type coercion, contract checks, the engine's every branch, the evidence writer |
| `tests/integration/` | fixture + Chromium | the accessibility snapshot, frame traversal, locator resolution, table extraction, every declared outcome firing (and not firing) on real screens, and the engine end to end |
| `tests/helpers/` | — | in-memory surfaces, so decisions are tested without a browser |

The integration suite drives the fixture using the locators from the
hand-written capability, so a pass also says that artifact resolves against the
real screens. It reads the same member through two different searches to show
that a control whose generated id moves between renders is still hit correctly,
and replays the capability ten times over to show the outputs do not drift.

### Continuous integration

Every push runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): one job
for lint, typecheck, contract validation and the unit suite, and a second that
starts the fixture inside the runner and drives it with a real Chromium. Work
happens on `develop` and reaches `main` through a pull request, so `main` only
ever holds a state CI has already passed.

## Demo path

<!-- TODO (phase 2): the discovery half — one real agent run producing an
artifact, replayed afterwards through this same unmodified engine.
TODO (phase 3): the escalation demo. -->

Two terminals. Nothing below calls a model or reaches the network.

```
npm install
npx playwright install chromium
cp .env.example .env           # cmd.exe: copy .env.example .env
npm run target                 # terminal 1 — http://localhost:4173
```

In terminal 2, four invocations of the same capability:

```
# a member who exists — typed outputs
npm run replay -- --capability member.lookup_savings_balance --input member_id=100005

# a member who does not — a declared business outcome, not an error
npm run replay -- --capability member.lookup_savings_balance --input member_id=999999

# an account under restriction — the balance still comes back, with the caveat
npm run replay -- --capability member.lookup_savings_balance --input member_id=100002

# an injected application error — a declared hard failure
curl "http://localhost:4173/_chaos?mode=app_error&times=2"
npm run replay -- --capability member.lookup_savings_balance --input member_id=100005
```

Add `--headed` to watch any of them in a real browser.

Exit status is the shape of the answer, not the shape of the run: `0` when the
capability answered — whether it succeeded or a declared business outcome stopped
it — `1` when it failed, `2` when it is suspended waiting on a person.

Every run writes `evidence/replay/<how it ended>/<run id>/`: the result verbatim,
a summary written for a person, and the screen as the run last saw it.

## Safety notes

- The target application is local, fabricated, and belongs to this repository.
  No real institution, real credentials or real personal data is involved.
- Credentials are never committed. Tenant configs name environment variables
  (`env:NORTHSTAR_TELLER_USER`); values live in `.env`, which is git-ignored, and
  resolved values are redacted from logs, traces and evidence.
