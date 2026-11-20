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
- Latest fix (33782bc): host-reported child exit 1 was root-caused to
  non-canonical seatbelt paths (fixed in f39f3f2); host recheck
  showed node SIGABRT in dyld CacheFinder bootstrap — fixed by adding
  (literal "/") and cryptex/dyld cache dirs; further recheck showed
  file-read-metadata denials on ancestor dirs (/var, /Volumes,
  /System/Volumes/Data) — fixed by emitting metadata-only literals for all
  raw/resolved/firmlink ancestors of every granted path, and canonicalizing
  all child argv paths. Probes are now
  split: capabilityProbe (/usr/bin/true, minimal profile) detects unsupported
  hosts -> 503 SANDBOX_UNAVAILABLE; policyProbe (node -e 0 under the exact
  production profile) detects policy defects -> 500 SANDBOX_POLICY_FAILED,
  which fails tests instead of being skipped. Reads: node install, system
  loader/frameworks, cryptex cache dirs, recipe dir, mounted inputs, /dev
  devices. Writes: fenced workspace only. deny network*. demo.mjs no longer
  auto-sets RERUNDESK_UNSAFE_RUNNER: default demo requires
  sandbox-exec:no-network and exits 1 with an honest BLOCKED step otherwise.
- Commands, exit codes and tested environment:
  - `npm test` → exit 0, 17 pass + 1 host-gated skip (seatbelt scope probe)
  - `node scripts/demo.mjs --port 8907` → 13/14 in this sandbox: fenced
    execution step honestly BLOCKED (sandbox_apply denied), rest pass
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
  - Execution isolation: HOST-RECHECK-PENDING at 2567f02 — capability probe
    verified working on host; policy probe passed with literal "/" grant;
    recipe run under the exact profile pending host recheck.
- Host verified at 2567f02: 18/18 npm test (0 skipped), 13/13 demo with
  sandbox-exec:no-network. Later commits added: server-side credential auth
  (provisioned opaque tokens bind org+role; dev identity headers gated on
  RERUNDESK_DEV_AUTH=1), HTML error pages, console settlement section,
  focus-visible/table-wrap a11y, and a zero-dep CDP browser check
  (scripts/browser-check.mjs -> 11/11, evidence under browser-evidence/).
- First next action: clean-checkout verify `npm test` (expect 21 pass +
  host-gated counts) and `node scripts/browser-check.mjs` on the host.
- Next agent must reproduce: `npm test && node scripts/demo.mjs`
