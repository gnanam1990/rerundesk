# RerunDesk · Product requirements

## Product decision

Start with a small licensed CPU benchmark and a deterministic evaluator. Record divergence as a valid review outcome. Constrain submitted jobs to allowlisted pre-reviewed images and fixed entrypoints. Sponsor and worker must have separate enrolled organization identities for an independence assertion. The report states how those identities were checked.

**Buyer and commercial hypothesis.** ML benchmark sponsors and research tool companies. Charge per verified rerun plus compute. Start with a small licensed public benchmark.

**People and responsibilities.** Benchmark sponsor owns a claim and compute budget. A maintainer admits executable recipes. A separate enrolled worker operator executes the pinned recipe. An evaluator verifies artifacts. Viewers receive a redacted results packet.

## Customer journey

The sponsor registers a reference metric, dataset hash and tolerance, selects an eligible worker offer and authorizes capped compute. A worker runs the recipe, uploads a signed run bundle, and the evaluator compares the observed measurement with the precommitted rule. Sponsor downloads the result and its reproduction instructions.

## Acceptance scene

Reference accuracy 0.900 with absolute tolerance 0.010 and one predeclared seed. Evaluator recomputes 890 correct out of 1000 as 0.890, so boundary difference 0.010 reproduces. A separate run with 889 correct diverges at 0.011. Missing 1 output makes the run inconclusive. All three verdicts are distinct from worker payment status.

## Behaviors for the team

- **FR-01 · Recipe admission and provenance.** Implement licensed input intake, image digest verification, fixed command catalog and content-addressed recipe manifests.
- **FR-02 · Claims and comparison contract.** Freeze evaluator, units, seed set, tolerance, baseline, hardware constraints and aggregation before procurement.
- **FR-03 · Worker enrollment and purchase.** Bind organization evidence, capacity offer, expiry and maximum spend. Reconcile paid reservations by merchant order identity.
- **FR-04 · Leased isolated execution.** Issue worker-scoped fenced leases, mount known inputs read-only, disable egress and pin the CPU execution profile.
- **FR-05 · Artifact reception and verification.** Collect outputs, runtime metadata, output cardinality, logs and hashes inside a bounded bundle. Recompute digests and seal the manifest.
- **FR-06 · Deterministic comparison.** Implement the pinned metric on worker outputs. Distinguish divergence from missing evidence, bad seed, metric mismatch or incompatible hardware.
- **FR-07 · Report, settlement and repeatability.** Ship run timeline, outcome explanation, independent-operator evidence, exact reproduction manifest and separate cost history.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Use a small openly licensed benchmark, record a local canonical run, then invite an independently operated paid worker. Measure comparable completed runs, sponsor cost and reviewer time. A same-operator worker demonstrates local execution only. A production claim requires separate operator enrollment and a verified commercial rail.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [Reprograph](https://dorahacks.io/buidl/47644); customer willingness to pay requires pilot evidence.

## Larger team scope

- Signed workload manifests and license triage, deterministic environment capture
- Worker selection, resource negotiation, leases and artifact verification
- Tolerance rules by metric, hardware and random seed variability
- Reproduction dossiers, comparison across versions and sponsor cost reporting

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
