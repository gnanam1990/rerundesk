# RerunDesk · acceptance contract

### FR-01 — Recipe admission and provenance

Implement licensed input intake, image digest verification, fixed command catalog and content-addressed recipe manifests.

### INV-01 — Recipe admission and provenance

Only immutable reviewed recipes can be scheduled.

### FR-02 — Claims and comparison contract

Freeze evaluator, units, seed set, tolerance, baseline, hardware constraints and aggregation before procurement.

### INV-02 — Claims and comparison contract

A tolerance change creates a different claim ID and cannot rewrite an active run.

### FR-03 — Worker enrollment and purchase

Bind organization evidence, capacity offer, expiry and maximum spend. Reconcile paid reservations by merchant order identity.

### INV-03 — Worker enrollment and purchase

A worker from the sponsor organization cannot be represented as independent.

### FR-04 — Leased isolated execution

Issue worker-scoped fenced leases, mount known inputs read-only, disable egress and pin the CPU execution profile.

### INV-04 — Leased isolated execution

Only the active lease may deliver the authoritative result.

### FR-05 — Artifact reception and verification

Collect outputs, runtime metadata, output cardinality, logs and hashes inside a bounded bundle. Recompute digests and seal the manifest.

### INV-05 — Artifact reception and verification

The evaluator sees sealed verified artifacts with a matching claim and attempt.

### FR-06 — Deterministic comparison

Implement the pinned metric on worker outputs. Distinguish divergence from missing evidence, bad seed, metric mismatch or incompatible hardware.

### INV-06 — Deterministic comparison

Only comparable complete outputs receive numerical reproduction or divergence verdicts.

### FR-07 — Report, settlement and repeatability

Ship run timeline, outcome explanation, independent-operator evidence, exact reproduction manifest and separate cost history.

### INV-07 — Report, settlement and repeatability

Payment eligibility follows contracted delivery criteria and cannot depend on matching the sponsor's preferred result.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
