// API surface (TDD §HTTP boundaries). Roles: maintainer, sponsor, worker,
// evaluator, viewer. Tenant scoping and action scope enforced server-side.
import { route } from "./http.js";
import { requireRole, createSession } from "./auth.js";
import * as orgs from "./services/orgs.js";
import * as datasets from "./services/datasets.js";
import * as recipes from "./services/recipes.js";
import * as claims from "./services/claims.js";
import * as offers from "./services/offers.js";
import * as runs from "./services/runs.js";
import * as leases from "./services/leases.js";
import * as artifacts from "./services/artifacts.js";
import * as evaluate from "./services/evaluate.js";
import * as reports from "./services/reports.js";
import { executeRun } from "./runner.js";
import { badRequest } from "./errors.js";

const leaseToken = (ctx) => ctx.req.headers["x-rd-lease"] ?? ctx.body?.lease_token;

export function registerRoutes() {
  // --- bootstrap / identity (local enrollment endpoints) ---
  route("POST", "/v1/orgs", ({ db, body }) => {
    const org = orgs.enrollOrg(db, null, body);
    return { status: 201, body: { org } };
  }, { public: true });

  route("GET", "/v1/orgs", ({ db }) => ({ orgs: orgs.listOrgs(db) }));

  route("POST", "/v1/sessions", ({ db, body }) => {
    const org = orgs.getOrg(db, body?.org_id);
    const role = body?.role;
    if (!["maintainer", "sponsor", "worker", "evaluator", "viewer"].includes(role))
      throw badRequest("ROLE_INVALID", "unknown role");
    if (role === "sponsor" && !["sponsor", "both"].includes(org.kind))
      throw badRequest("ROLE_ORG_MISMATCH", "sponsor role requires a sponsor org");
    if (role === "worker" && !["worker", "both"].includes(org.kind))
      throw badRequest("ROLE_ORG_MISMATCH", "worker role requires a worker org");
    const token = createSession(db, org.id, role);
    return { status: 201, body: { token, org_id: org.id, role } };
  }, { public: true });

  // --- licensed input intake (M01) ---
  route("POST", "/v1/datasets", ({ db, actor, body }) => {
    requireRole(actor, "maintainer");
    const ds = datasets.registerDataset(db, actor, body);
    return { status: 201, body: { dataset: ds } };
  });

  route("GET", "/v1/datasets", ({ db, actor }) => {
    requireRole(actor, "maintainer", "sponsor", "worker", "evaluator");
    return { datasets: datasets.listDatasets(db) };
  });

  route("GET", "/v1/datasets/:id", ({ db, actor, params }) => {
    requireRole(actor, "maintainer", "sponsor", "worker", "evaluator");
    return { dataset: datasets.getDataset(db, params.id) };
  });

  // --- recipes (M01) ---
  route("POST", "/v1/recipes", ({ db, actor, body }) => {
    requireRole(actor, "maintainer");
    const { recipe, created } = recipes.admitRecipe(db, actor, body?.manifest ?? body);
    return { status: created ? 201 : 200, body: { recipe } };
  });

  route("GET", "/v1/recipes", ({ db, actor }) => {
    requireRole(actor, "maintainer", "sponsor", "worker", "evaluator", "viewer");
    return { recipes: recipes.listRecipes(db) };
  });

  route("GET", "/v1/recipes/:id", ({ db, actor, params }) => {
    requireRole(actor, "maintainer", "sponsor", "worker", "evaluator", "viewer");
    return { recipe: recipes.getRecipe(db, params.id) };
  });

  // --- claims (M02) ---
  route("POST", "/v1/claims", ({ db, actor, body }) => {
    requireRole(actor, "sponsor");
    const { claim, created } = claims.freezeClaim(db, actor, body);
    return { status: created ? 201 : 200, body: { claim } };
  });

  route("GET", "/v1/claims", ({ db, actor }) => {
    const all = db.prepare("SELECT id FROM claims ORDER BY created_at").all();
    return { claims: all.map((c) => claims.getClaim(db, c.id)) };
  });

  route("GET", "/v1/claims/:id", ({ db, params }) => ({ claim: claims.getClaim(db, params.id) }));

  // --- offers (M03) ---
  route("POST", "/v1/offers", ({ db, actor, body }) => {
    requireRole(actor, "worker");
    return { status: 201, body: { offer: offers.createOffer(db, actor, body) } };
  });

  route("GET", "/v1/offers", ({ db, actor }) => ({ offers: offers.listOffers(db) }));

  // --- runs (M03) ---
  route("POST", "/v1/runs", ({ db, actor, body, req }) => {
    requireRole(actor, "sponsor");
    const key = req.headers["idempotency-key"];
    const out = runs.reserveRun(db, actor, body, key);
    return { status: out.created ? 201 : 200, body: { run: out.run, replayed: !out.created } };
  });

  route("GET", "/v1/runs", ({ db, actor }) => ({ runs: runs.listRuns(db, actor) }));

  route("GET", "/v1/runs/:id", ({ db, actor, params }) => {
    const run = runs.assertRunAccess(db, params.id, actor);
    const lease = leases.activeLease(db, run.id);
    return { run, active_lease: lease && { epoch: lease.epoch, expires_at: lease.expires_at } };
  });

  // --- leases (M04) ---
  route("POST", "/v1/runs/:id/lease", ({ db, actor, params, body }) => {
    requireRole(actor, "worker");
    const lease = leases.issueLease(db, actor, params.id, body);
    return { status: 201, body: { lease: { ...lease, token: lease.token } } };
  });

  route("POST", "/v1/runs/:id/lease/heartbeat", ({ db, actor, params, body }) => {
    requireRole(actor, "worker");
    const lease = leases.heartbeat(db, actor, params.id, body?.lease_token ?? "");
    return { lease };
  });

  // Local fenced execution (M04): worker runs the pinned recipe in the
  // sandboxed workspace, then uploads produced artifacts itself.
  route("POST", "/v1/runs/:id/execute", ({ db, actor, params, body }) => {
    requireRole(actor, "worker");
    const run = runs.getRun(db, params.id);
    const lease = leases.validateLeaseToken(db, actor, params.id, leaseToken({ req, body }));
    const out = executeRun(db, run, lease, { seed: body?.seed });
    return {
      workspace: out.workspace,
      exit_status: out.exitStatus,
      produced: out.artifacts.map((a) => a.path),
    };
  });

  // --- artifacts (M05) ---
  route("PUT", "/v1/runs/:id/artifacts", ({ db, actor, params, query, body, req }) => {
    requireRole(actor, "worker");
    const out = artifacts.uploadArtifact(db, actor, params.id, {
      path: query.get("path"),
      sha256: query.get("sha256") ?? undefined,
      body,
    }, leaseToken({ req, body }));
    return { status: 201, body: out };
  }, { raw: true });

  route("GET", "/v1/runs/:id/artifacts", ({ db, actor, params, query }) => {
    const run = runs.assertRunAccess(db, params.id, actor);
    const sealed = artifacts.sealedManifest(db, run.id);
    const epoch = query.get("epoch") ? Number(query.get("epoch")) : sealed?.epoch ?? run.attempt;
    return { artifacts: artifacts.listArtifacts(db, run.id, epoch), epoch };
  });

  route("PUT", "/v1/runs/:id/manifest", ({ db, actor, params, body, req }) => {
    requireRole(actor, "worker");
    return artifacts.sealManifest(db, actor, params.id, body, leaseToken({ req, body }));
  });

  // --- evaluation (M06) ---
  route("POST", "/v1/runs/:id/evaluate", ({ db, actor, params }) => {
    requireRole(actor, "evaluator", "maintainer");
    return { evaluation: evaluate.evaluateRun(db, actor, params.id) };
  });

  // --- report (M07) ---
  route("GET", "/v1/runs/:id/report", ({ db, actor, params }) => {
    return { report: reports.getReportForActor(db, actor, params.id) };
  });

  route("GET", "/v1/runs/:id/report/download", ({ db, actor, params }) => {
    const report = reports.getReportForActor(db, actor, params.id);
    return {
      body: JSON.stringify(report, null, 2),
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="rerundesk-report-${params.id}.json"`,
      },
    };
  });

  route("GET", "/v1/runs/:id/artifact-bytes", ({ db, actor, params, query }) => {
    const run = runs.assertRunAccess(db, params.id, actor);
    const sealed = artifacts.sealedManifest(db, run.id);
    const epoch = sealed?.epoch ?? run.attempt;
    const { bytes } = artifacts.artifactBytes(db, run.id, epoch, query.get("path") ?? "");
    return { body: bytes };
  });
}
