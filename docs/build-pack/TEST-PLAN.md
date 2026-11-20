# RerunDesk · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Reference accuracy 0.900 with absolute tolerance 0.010 and one predeclared seed. Evaluator recomputes 890 correct out of 1000 as 0.890, so boundary difference 0.010 reproduces. A separate run with 889 correct diverges at 0.011. Missing 1 output makes the run inconclusive. All three verdicts are distinct from worker payment status.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Recipe admission and provenance • expected behavior

Status: NOT_RUN

A reordered manifest serializes to the same canonical digest.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Recipe admission and provenance • failure boundary

Status: NOT_RUN

A floating image tag or missing dataset license causes admission rejection.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Claims and comparison contract • expected behavior

Status: NOT_RUN

Register 0.900, tolerance 0.010 and a single seed; verify exact decimals after reload.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Claims and comparison contract • failure boundary

Status: NOT_RUN

Reject undeclared aggregation for a multiseed baseline and negative tolerances.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Worker enrollment and purchase • expected behavior

Status: NOT_RUN

An eligible worker receives one funded run after a repeated idempotent POST.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Worker enrollment and purchase • failure boundary

Status: NOT_RUN

An expired quote or self-enrolled sponsor worker is rejected for an independent run.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Leased isolated execution • expected behavior

Status: NOT_RUN

Restart the orchestrator while a worker runs; heartbeat retains the lease and Run ID.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Leased isolated execution • failure boundary

Status: NOT_RUN

An expired lease cannot finalize output even if the worker finishes late.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Artifact reception and verification • expected behavior

Status: NOT_RUN

Upload a chunk twice, then seal the same complete manifest once.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Artifact reception and verification • failure boundary

Status: NOT_RUN

Reject a path escaping the bundle, oversized logs or modified bytes after hashing.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Deterministic comparison • expected behavior

Status: NOT_RUN

With 890/1000 against 0.900 and tolerance 0.010 return reproduced; 889/1000 returns diverged.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Deterministic comparison • failure boundary

Status: NOT_RUN

999 output rows for 1000 expected inputs returns inconclusive, regardless of apparent accuracy. A 1,000-row submission with one duplicate and one missing expected ID is inconclusive even though its row count matches.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Report, settlement and repeatability • expected behavior

Status: NOT_RUN

Download the divergence packet; independent re-evaluation returns the same metric and outcome.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Report, settlement and repeatability • failure boundary

Status: NOT_RUN

Unconfirmed payment cannot show as settled; missing identity evidence cannot show as independently operated.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
