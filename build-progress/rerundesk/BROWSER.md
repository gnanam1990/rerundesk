# Browser verification

Runnable, zero-dependency browser check for the RerunDesk console journey.
Drives a real Chromium headless shell over the DevTools protocol (CDP) using
Node's built-in WebSocket — no npm installs, no Playwright package needed.

## Run it

```sh
node scripts/browser-check.mjs
```

Everything is disposable and local: the server binds an ephemeral port
(`--port 0`), the app data dir and Chrome profile are fresh `mkdtemp`s, and
evidence lands in `build-progress/rerundesk/browser-evidence/`.

## Dependencies

- Node 22+ (built-in `WebSocket`, `node:sqlite`)
- A Chromium headless shell binary. Resolution order:
  1. `--chrome /path/to/chrome-headless-shell`
  2. `RD_CHROME=/path/to/chrome-headless-shell`
  3. newest `chromium_headless_shell-*` in the standard Playwright cache
     (`~/Library/Caches/ms-playwright/`); verified with
     `chromium_headless_shell-1254` (Chrome for Testing 158).
- Extra Chromium flags via `RD_CHROME_ARGS`. Default is
  `--no-sandbox --single-process`, which is required inside nested sandboxes
  (MachPortRendezvous denial kills the default multi-process mode). On an
  unrestricted host the default still works; set `RD_CHROME_ARGS=""` for the
  stock profile if desired.

## What it checks (11 assertions)

1. Seeds a full run through the real HTTP API (credential-auth): orgs,
   dataset, recipe, claim, offer, reservation, lease, execution (fenced where
   the host allows; labeled synthetic bundle otherwise), seal, evaluation ->
   `reproduced`.
2. Sponsor signs in via the console using the provisioned credential (no
   identity pickers — role comes from the stored credential).
3. Run detail page shows the comparison table (reference 0.900, tolerance
   0.010) with the `reproduced` verdict badge.
4. Settlement/cost section is rendered separately from the verdict, marked
   `local-ledger` + "independent of verdict".
5. Report packet links (`/v1/runs/:id/report`, `/download`) are present.
6. The JSON report fetched through the browser session carries a separate
   `cost_history` (>=2 rows) and `settlement=captured`.
7. At 320px viewport there is no horizontal overflow.
8. Tab key reaches interactive elements; a visible focus indicator applies
   (`:focus-visible` outline).
9. Reload preserves verdict and settlement (server-side persistence).
10. Cross-tenant access renders a readable HTML error page (`403
    RUN_NOT_VISIBLE`, `role="alert"`), not a raw JSON blob.

## Evidence

`browser-evidence/` contains `EVIDENCE.json` (assertions, chrome version,
flags, containment actually used — redacted of credentials and ports) and
screenshots: `run-desktop.png`, `run-320px.png`, `denied-403.png`.

Exit code 0 only when every check passes.
