# RerunDesk · Session handoff

- Target repository / branch / tested SHA: this checkout, `devin/rerundesk`
- Current module and owner: all M01–M07 accepted (single-agent build)
- Completed behavior and redacted evidence path:
  - Full journey over real HTTP entry points: org enrollment, licensed dataset
    intake, recipe admission (content-addressed), claim freeze, offer publish,
    idempotent run reservation, fenced execution, artifact upload + atomic seal,
    deterministic evaluation, report packet with separate cost history.
  - Canonical acceptance reproduced: 890/1000 → `reproduced` (diff 0.010),
    889/1000 → `diverged` (diff 0.011), 999 rows → `inconclusive`
    (`output_incomplete`). Verdict independent of settlement.
  - Evidence: `data/demo/demo-results.json` (13/13 PASS), `npm test` 17/17.
- Working tree or branch requiring transfer: none.
- Commands, exit codes and tested environment:
  - `npm test` → exit 0, 17 tests pass (node --test test/*.test.js)
  - `node scripts/demo.mjs` → exit 0, 13/13 steps pass (spins its own server on :8901, RERUNDESK_DATA=data/demo)
  - `node src/index.js migrate` → exit 0
  - `node scripts/reevaluate.mjs --run <id>` → replays verdict from sealed bundle
  - Env: macOS (darwin arm64), Node v22.23.1, zero npm dependencies
- External dependencies and decisions:
  - Paid worker rail: BLOCKED — no external payment provider available in this
    build. Substitute: `local-ledger` (team-controlled, labeled; settlement
    never claimed as external). Missing proof: live merchant order id, rail,
    signed receipt, amount, network.
  - Independent operator: PARTIAL — distinct enrolled orgs enforced; same local
    owner operates both in this build.
  - Execution isolation: PARTIAL — seatbelt profile implemented; `sandbox_apply`
    denied inside this build sandbox so runs record `containment:"unsandboxed"`.
- First next action: on an unrestricted macOS host, re-run `node scripts/demo.mjs`
  to capture `sandbox-exec:no-network` containment; integrate a real paid-worker
  rail only with owner authority (seller, rail, amount, purpose).
- Next agent must reproduce: `npm test && node scripts/demo.mjs`
