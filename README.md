# interface-capabilities

Record-once, replay-many computer-use automation for back-office applications
that have no API.

A model drives a real UI to accomplish a goal the first time. The successful run
is distilled into a **capability** — a typed, versioned contract describing the
flow, how each control is identified, what inputs it takes and what it returns.
After that the capability is replayed with no model in the decision loop, which
is how a production agent invokes it: reliably, cheaply, and without re-reasoning
about the screen every time.

> **Status: in progress.** The capability schema and the two capability contracts
> are settled; the target fixture, replay engine, discovery agent and handoff are
> being built in that order. See `REPORT.md` for the design write-up.

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

<!-- TODO (phase 4): exact install steps, Node version, Playwright browser
install, and how to run everything with no live services (the target is local;
replay never needs network or a model). -->

```
npm install
cp .env.example .env      # fill in local fixture credentials
```

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

Integration tests need the fixture running:

```
npm run target               # terminal 1 — http://localhost:4173, Ctrl+C to stop
npm run test:integration     # terminal 2 — SURFACE_HEADED=1 to watch it
```

`validate` is worth running on every change: half of what makes an artifact
reviewable is that its internal references hold — an outcome pointing at a step
that exists, a required output that something actually extracts — and none of
that is visible by reading the JSON.

### Tests

| Path | Needs | Covers |
| --- | --- | --- |
| `tests/unit/` | nothing | schema guards, tenant profiles, template interpolation and escaping, assertion evaluation, the fallback ladder, the result contract, the fixture's own search |
| `tests/integration/` | fixture + Chromium | the accessibility snapshot, frame traversal, locator resolution, table extraction, and every declared outcome firing (and not firing) on real screens |
| `tests/helpers/` | — | an in-memory Surface, so assertion and ladder logic are tested without a browser |

The integration suite drives the fixture using the locators from the
hand-written capability, so a pass also says that artifact resolves against the
real screens. It reads the same member through two different searches to show
that a control whose generated id moves between renders is still hit correctly.

### Continuous integration

Every push runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): one job
for lint, typecheck, contract validation and the unit suite, and a second that
starts the fixture inside the runner and drives it with a real Chromium. Work
happens on `develop` and reaches `main` through a pull request, so `main` only
ever holds a state CI has already passed.

## Demo path

<!-- TODO (phase 4): the exact commands, verbatim, in the order a reviewer should
run them. Must include: start the target, one discovery run producing an
artifact, one replay of that artifact with input parameters, one replay that hits
a business outcome, one replay that hits an injected failure, and the escalation
demo. -->

## Safety notes

- The target application is local, fabricated, and belongs to this repository.
  No real institution, real credentials or real personal data is involved.
- Credentials are never committed. Tenant configs name environment variables
  (`env:NORTHSTAR_TELLER_USER`); values live in `.env`, which is git-ignored, and
  resolved values are redacted from logs, traces and evidence.
