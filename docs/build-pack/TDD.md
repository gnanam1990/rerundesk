# RerunDesk · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** Benchmark sponsor owns a claim and compute budget. A maintainer admits executable recipes. A separate enrolled worker operator executes the pinned recipe. An evaluator verifies artifacts. Viewers receive a redacted results packet.

## Domain schema

Recipe(id,image_digest,entrypoint_version,model_digest,data_hash,license_ref); Claim(id,recipe_hash,metric,evaluator_digest,reference_decimal,absolute_tolerance,seed_list,hardware_class); Offer(worker_org,price,currency,expires_at); Run(id,claim_hash,worker_org,attempt,lease_epoch,state,spend_id); Artifact(run_id,epoch,path,bytes,sha256); Evaluation(run_id,manifest_hash,observed_decimal,outcome,explanation). Unique(client_request_key,sponsor); unique(run_id,accepted_epoch); keep budget, payment and comparison outcomes as separate records.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /v1/recipes registers a vetted manifest; POST /v1/claims freezes the metric and tolerance; POST /v1/runs reserves an eligible worker offer; POST /v1/runs/{id}/lease issues a bounded worker lease; PUT /v1/runs/{id}/manifest binds worker evidence; POST /v1/runs/{id}/evaluate runs the pinned evaluator; GET /v1/runs/{id}/report returns redacted manifest, result and repro instructions.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Canonicalize and hash the claim including reference metric, tolerance, seeds and evaluator version. Bind selected operator and offer to the run. Run an allowlisted workload in an isolated runner with read-only inputs, no outbound network, bounded CPU/time/storage and no host credentials. Compare computed values using decimal arithmetic and inclusive absolute tolerance. For multiple seeds require the predeclared aggregation and all required artifacts. Reserve inconclusive for non-comparable data or runtime evidence. Pay per agreed execution and evidence terms independent of whether the benchmark reproduces. Require the submitted prediction IDs to equal the frozen dataset sample IDs with each ID present exactly once before comparing metrics.

## State model

Recipe admission pending, admitted or rejected. Run authorized → leased → running → artifacts_received → evaluated. Outcome is reproduced, diverged or inconclusive. Worker timeout, expired lease and funding uncertainty are recoverable separate statuses; never conflate settlement with successful reproduction.

## Recovery

Persist epoch and lease expiry. Resume uploads by content hash and commit a manifest atomically. Reassign an expired lease only under remaining budget and contract; superseded results cannot replace an accepted attempt. Hold uncertain settlement for lookup. A lost operator receipt cannot become proof that a benchmark reproduced.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
