# RerunDesk — build/test reference

Greenfield, zero-dependency Node.js 22+ app (ESM). Persistence: `node:sqlite`.
HTTP: `node:http`. Tests: `node:test`. No npm install step is required.

## Commands

- `npm test` — all product tests (17: T-001..T-014 plus module regressions)
- `node src/index.js migrate` — apply versioned migrations to `data/rerundesk.sqlite`
- `npm start` / `node src/index.js serve --port 8080` — API + console
- `node scripts/demo.mjs` — full end-to-end acceptance journey over real HTTP entry
  points (writes evidence to `data/demo/demo-results.json`)
- `node scripts/reevaluate.mjs --run <run_id>` — replay a sealed verdict (NFR-01)

## Layout

- `src/services/` — domain modules m01..m07 (orgs, datasets, recipes, claims,
  offers+ledger+runs, leases, artifacts, evaluate, reports)
- `src/runner.js` — fenced local execution (sandbox-exec seatbelt when the host
  permits; records actual containment in runtime.json)
- `src/console.js` — role-aware server-rendered console (maintainer, sponsor,
  worker, evaluator, viewer)
- `benchmark/` — deterministic 1000-sample fixture + reviewed recipe script
- `build-progress/rerundesk/` — HANDOFF.md and STATUS.json (mutable progress)

## Auth model

API actors send `x-rd-org` + `x-rd-role` headers (orgs must exist first via
POST /v1/orgs). The console issues `rd_session` cookies via POST /v1/sessions.
Org enrollment and session creation are open local endpoints — there is no
external identity provider in this environment.

## Environment

- `RERUNDESK_DATA` — data directory (default `./data`)
- `RERUNDESK_UNSAFE_RUNNER=1` — skip the sandbox-exec preflight and run the
  recipe unsandboxed (containment is still recorded honestly)

## Known external gaps (recorded in STATUS.json)

- No paid worker rail: `local-ledger` is a team-controlled merchant adapter;
  reports label settlement `local_only` and never claim external settlement.
- `sandbox_apply` is denied inside the current build sandbox, so fenced
  execution here records `containment: "unsandboxed"`. On a normal macOS host
  the runner applies a seatbelt profile with `deny network*`.
