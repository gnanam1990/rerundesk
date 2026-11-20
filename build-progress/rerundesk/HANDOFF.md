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
- Latest fix (f39f3f2): host-reported child exit 1 in the fenced runner was
  root-caused to non-canonical seatbelt paths — os.tmpdir() workspaces live
  under /var -> /private/var, so the profile's subpath never matched and all
  workspace writes were denied. Profile now realpath()s every embedded path,
  narrows reads to node install + system loader + recipe + inputs, writes to
  the fenced workspace only, denies network, and FAILS CLOSED
  (503 SANDBOX_UNAVAILABLE) when a profile cannot be applied. The only escape
  is explicit RERUNDESK_UNSAFE_RUNNER=1, recorded as
  'unsandboxed:operator-override'.
- Commands, exit codes and tested environment:
  - `npm test` → exit 0, 17 pass + 1 host-gated skip (seatbelt scope probe)
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
  - Execution isolation: HOST-RECHECK-PENDING at f39f3f2 — seatbelt profile
    implemented, fail-closed and scope-narrowed; this build sandbox cannot
    `sandbox_apply`, so the contained branch needs one `npm test` on the host.
- First next action: on the unrestricted Mac host, clean-checkout verify
  `npm test` at f39f3f2 — expect 18/18 with containment
  'sandbox-exec:no-network' and the scope-denial probe passing.
- Next agent must reproduce: `npm test && node scripts/demo.mjs`
