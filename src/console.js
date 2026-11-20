// Role-aware server-rendered console. Same authorization rules as the API:
// actions re-check role and tenant scope on the server. Native controls,
// text equivalents for status colours, tables with explicit headers.
import { route } from "./http.js";
import { resolveActor, createSession } from "./auth.js";
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
import { executeRun, workspaceFor } from "./runner.js";
import { HttpError } from "./errors.js";
import fs from "node:fs";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const badge = (state) =>
  `<span class="badge badge-${esc(state)}" aria-label="status ${esc(state)}">${esc(state)}</span>`;

function page(title, actor, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · RerunDesk</title>
<style>
:root { color-scheme: light dark; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0 auto;
  max-width: 64rem; padding: 1rem; line-height: 1.45; }
nav a { margin-right: .75rem; }
table { border-collapse: collapse; width: 100%; margin: .75rem 0; }
th, td { border: 1px solid #8884; padding: .3rem .5rem; text-align: left;
  font-size: .85rem; vertical-align: top; }
code { font-size: .8rem; word-break: break-all; }
.badge { border: 1px solid currentColor; border-radius: .3rem; padding: 0 .35rem; }
.badge-reproduced { color: #0a7d2c; } .badge-diverged { color: #b34700; }
.badge-inconclusive { color: #8a6d00; } .badge-evaluated { color: #334; }
.flash { border: 1px solid #b33; background: #b332; padding: .5rem; }
fieldset { margin: .75rem 0; }
label { display: block; margin: .35rem 0; font-size: .85rem; }
input, select, textarea { font: inherit; max-width: 100%; }
textarea { width: 100%; }
button { font: inherit; margin: .2rem .4rem .2rem 0; }
.small { font-size: .8rem; opacity: .8; }
section { margin: 1rem 0; }
</style></head><body>
<nav><a href="/">RerunDesk</a>
${actor ? `<a href="/runs">Runs</a><a href="/recipes">Recipes</a>
<a href="/claims">Claims</a><a href="/offers">Offers</a><a href="/datasets">Datasets</a>
<a href="/orgs">Orgs</a>
<form method="post" action="/logout" style="display:inline"><button>log out</button></form>
<span class="small">signed in: ${esc(actor.org_id)} · ${esc(actor.role)}</span>`
: `<a href="/login">sign in</a>`}
</nav><hr>
${inner}
</body></html>`;
}

const ok = (html, headers = {}) => ({ body: html, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (loc) => ({ status: 303, body: "", headers: { location: loc } });
const form = (body) => Object.fromEntries(new URLSearchParams(body.toString("utf8")));

export function registerConsole() {
  route("GET", "/", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    if (!actor) return redirect("/login");
    const list = runs.listRuns(db, actor);
    return ok(page("Work queue", actor, `
<h1>Work queue</h1>
${list.length ? `<table><thead><tr><th scope="col">run</th><th scope="col">state</th>
<th scope="col">outcome</th><th scope="col">claim</th><th scope="col">updated</th></tr></thead><tbody>
${list.map((r) => `<tr><td><a href="/runs/${r.id}"><code>${esc(r.id)}</code></a></td>
<td>${badge(r.state)}</td><td>${r.outcome ? badge(r.outcome) : "—"}</td>
<td><code>${esc(r.claim_id.slice(0, 12))}…</code></td><td>${esc(r.updated_at)}</td></tr>`).join("")}
</tbody></table>` : "<p>No runs yet.</p>"}
<p><a href="/runs/new">Reserve a run</a></p>`));
  }, { public: true });

  route("GET", "/login", ({ db }) => {
    const list = orgs.listOrgs(db);
    return ok(page("Sign in", null, `
<h1>Sign in</h1>
<form method="post" action="/login">
<fieldset><legend>Local session</legend>
<label>Organization
<select name="org_id">${list.map((o) =>
  `<option value="${esc(o.id)}">${esc(o.name)} (${esc(o.kind)})</option>`).join("")}
</select></label>
<label>Role
<select name="role">${["maintainer", "sponsor", "worker", "evaluator", "viewer"]
  .map((r) => `<option>${r}</option>`).join("")}</select></label>
<button type="submit">sign in</button></fieldset></form>
<h2>Enroll organization</h2>
<form method="post" action="/orgs">
<label>Name <input name="name" required></label>
<label>Kind <select name="kind"><option>sponsor</option><option>worker</option><option>both</option></select></label>
<label>Operator domain (independence evidence) <input name="operator_domain"></label>
<button type="submit">enroll</button></form>`));
  }, { public: true });

  route("POST", "/login", ({ db, body }) => {
    const f = form(body);
    const token = createSession(db, f.org_id, f.role);
    return {
      status: 303, body: "", headers: {
        location: "/",
        "set-cookie": `rd_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
      },
    };
  }, { public: true, raw: true });

  route("POST", "/logout", () => ({
    status: 303, body: "", headers: {
      location: "/login", "set-cookie": "rd_session=; Path=/; Max-Age=0",
    },
  }), { public: true, raw: true });

  route("POST", "/orgs", ({ db, body }) => {
    const f = form(body);
    const evidence = f.operator_domain ? { operator_domain: f.operator_domain } : {};
    orgs.enrollOrg(db, null, { name: f.name, kind: f.kind, evidence });
    return redirect("/login");
  }, { public: true, raw: true });

  route("GET", "/orgs", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    const list = orgs.listOrgs(db);
    return ok(page("Organizations", actor, `<h1>Organizations</h1>
<table><thead><tr><th scope="col">id</th><th scope="col">name</th><th scope="col">kind</th>
<th scope="col">independence</th></tr></thead><tbody>
${list.map((o) => `<tr><td><code>${esc(o.id)}</code></td><td>${esc(o.name)}</td>
<td>${esc(o.kind)}</td><td>${esc(o.independence_status)}</td></tr>`).join("")}
</tbody></table>`));
  }, { public: true });

  route("GET", "/datasets", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    const list = datasets.listDatasets(db);
    return ok(page("Datasets", actor, `<h1>Admitted datasets</h1>
<table><thead><tr><th scope="col">content hash</th><th scope="col">name</th>
<th scope="col">license</th><th scope="col">samples</th></tr></thead><tbody>
${list.map((d) => `<tr><td><code>${esc(d.id.slice(0, 16))}…</code></td><td>${esc(d.name)}</td>
<td>${esc(d.license_ref)}</td><td>${d.sample_count}</td></tr>`).join("")}
</tbody></table>`));
  }, { public: true });

  route("GET", "/recipes", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    const list = recipes.listRecipes(db);
    const admitForm = actor?.role === "maintainer" ? `
<h2>Admit a recipe manifest</h2>
<form method="post" action="/console/recipes">
<label>Manifest JSON <textarea name="manifest" rows="10" required></textarea></label>
<button type="submit">admit</button></form>` : "";
    return ok(page("Recipes", actor, `<h1>Recipes</h1>
<table><thead><tr><th scope="col">content id</th><th scope="col">name</th>
<th scope="col">status</th><th scope="col">decided</th></tr></thead><tbody>
${list.map((r) => `<tr><td><code>${esc(r.id.slice(0, 16))}…</code></td>
<td>${esc(r.manifest?.name ?? "")}</td><td>${badge(r.status)}</td>
<td>${esc(r.decided_at ?? "")}</td></tr>`).join("")}
</tbody></table>${admitForm}`));
  }, { public: true });

  route("POST", "/console/recipes", ({ db, req, body }) => {
    const actor = resolveActor(req, db);
    const f = form(body);
    recipes.admitRecipe(db, actor, JSON.parse(f.manifest));
    return redirect("/recipes");
  }, { raw: true });

  route("GET", "/claims", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    const all = db.prepare("SELECT id FROM claims ORDER BY created_at").all()
      .map((c) => claims.getClaim(db, c.id));
    const newForm = actor?.role === "sponsor" ? `<p><a href="/claims/new">Freeze a claim</a></p>` : "";
    return ok(page("Claims", actor, `<h1>Claims</h1>
<table><thead><tr><th scope="col">claim id</th><th scope="col">metric</th>
<th scope="col">reference</th><th scope="col">tolerance</th><th scope="col">seeds</th></tr></thead><tbody>
${all.map((c) => `<tr><td><code>${esc(c.id.slice(0, 16))}…</code></td><td>${esc(c.metric)}</td>
<td>${esc(c.reference_decimal)}</td><td>${esc(c.absolute_tolerance)}</td>
<td>${esc(c.seed_list.join(","))}</td></tr>`).join("")}
</tbody></table>${newForm}`));
  }, { public: true });

  route("GET", "/claims/new", ({ db, req }) => {
    const actor = resolveActor(req, db);
    if (actor.role !== "sponsor") throw new HttpError(403, "ROLE_DENIED", "sponsor only");
    const recs = recipes.listRecipes(db).filter((r) => r.status === "admitted");
    return ok(page("Freeze claim", actor, `<h1>Freeze a comparison contract</h1>
<form method="post" action="/console/claims">
<label>Recipe <select name="recipe_hash">${recs.map((r) =>
  `<option value="${esc(r.id)}">${esc(r.manifest?.name)} (${esc(r.id.slice(0, 12))}…)</option>`).join("")}
</select></label>
<label>Metric <select name="metric"><option>accuracy</option></select></label>
<label>Reference (decimal) <input name="reference" value="0.900" required></label>
<label>Absolute tolerance <input name="absolute_tolerance" value="0.010" required></label>
<label>Seeds (comma separated) <input name="seed_list" value="42" required></label>
<label>Hardware class <select name="hardware_class"><option>cpu-small</option><option>cpu-medium</option></select></label>
<label>Aggregation (required for multi-seed) <select name="aggregation"><option value="">none</option><option>mean</option><option>median</option><option>min</option></select></label>
<input type="hidden" name="evaluator_version" value="accuracy-v1">
<button type="submit">freeze claim</button></form>
<p class="small">Freezing is content-addressed: any change to these terms creates a
different claim id and cannot rewrite an active run.</p>`));
  });

  route("POST", "/console/claims", ({ db, req, body }) => {
    const actor = resolveActor(req, db);
    const f = form(body);
    const out = claims.freezeClaim(db, actor, {
      recipe_hash: f.recipe_hash,
      metric: f.metric,
      evaluator_version: "accuracy-v1",
      reference: f.reference,
      absolute_tolerance: f.absolute_tolerance,
      seed_list: f.seed_list.split(",").map((s) => Number(s.trim())),
      hardware_class: f.hardware_class,
      aggregation: f.aggregation || null,
      units: "ratio",
    });
    return redirect("/claims");
  }, { raw: true });

  route("GET", "/offers", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    const list = offers.listOffers(db);
    const createForm = actor?.role === "worker" ? `
<h2>Publish an offer</h2>
<form method="post" action="/console/offers">
<label>Price (minor units) <input name="price_minor" type="number" value="500" required></label>
<label>Currency <input name="currency" value="USD" required></label>
<label>TTL seconds <input name="ttl_seconds" type="number" value="3600" required></label>
<button type="submit">publish</button></form>` : "";
    return ok(page("Offers", actor, `<h1>Worker offers</h1>
<table><thead><tr><th scope="col">id</th><th scope="col">worker org</th>
<th scope="col">price</th><th scope="col">expires</th><th scope="col">eligible</th></tr></thead><tbody>
${list.map((o) => `<tr><td><code>${esc(o.id)}</code></td><td><code>${esc(o.worker_org_id)}</code></td>
<td>${o.price_minor} ${esc(o.currency)}</td><td>${esc(o.expires_at)}</td>
<td>${o.eligible ? "yes" : "no"}</td></tr>`).join("")}
</tbody></table>${createForm}`));
  }, { public: true });

  route("POST", "/console/offers", ({ db, req, body }) => {
    const actor = resolveActor(req, db);
    const f = form(body);
    offers.createOffer(db, actor, {
      price_minor: Number(f.price_minor), currency: f.currency,
      ttl_seconds: Number(f.ttl_seconds), capacity: 1,
    });
    return redirect("/offers");
  }, { raw: true });

  route("GET", "/runs", ({ db, req }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    if (!actor) return redirect("/login");
    const list = runs.listRuns(db, actor);
    return ok(page("Runs", actor, `<h1>Runs</h1>
<table><thead><tr><th scope="col">run</th><th scope="col">state</th><th scope="col">outcome</th>
<th scope="col">worker</th><th scope="col">updated</th></tr></thead><tbody>
${list.map((r) => `<tr><td><a href="/runs/${r.id}"><code>${esc(r.id)}</code></a></td>
<td>${badge(r.state)}</td><td>${r.outcome ? badge(r.outcome) : "—"}</td>
<td><code>${esc(r.worker_org_id)}</code></td><td>${esc(r.updated_at)}</td></tr>`).join("")}
</tbody></table><p><a href="/runs/new">Reserve a run</a></p>`));
  }, { public: true });

  route("GET", "/runs/new", ({ db, req }) => {
    const actor = resolveActor(req, db);
    if (actor.role !== "sponsor") throw new HttpError(403, "ROLE_DENIED", "sponsor only");
    const myClaims = db.prepare("SELECT id FROM claims WHERE sponsor_org_id = ? ORDER BY created_at")
      .all(actor.org_id);
    const offs = offers.listOffers(db).filter((o) => o.eligible);
    return ok(page("Reserve run", actor, `<h1>Reserve a run</h1>
<form method="post" action="/console/runs">
<label>Claim <select name="claim_id">${myClaims.map((c) =>
  `<option value="${esc(c.id)}">${esc(c.id.slice(0, 16))}…</option>`).join("")}</select></label>
<label>Worker offer <select name="offer_id">${offs.map((o) =>
  `<option value="${esc(o.id)}">${esc(o.id)} · ${o.price_minor} ${esc(o.currency)} · ${esc(o.worker_org_id)}</option>`).join("")}</select></label>
<label>Max spend (minor units) <input name="max_spend_minor" type="number" value="1000" required></label>
<label>Idempotency key <input name="idempotency_key" value="web-${Date.now()}" required></label>
<button type="submit">reserve</button></form>
<p class="small">The reservation binds claim, offer and spend cap; a repeated
idempotent POST returns the same run.</p>`));
  });

  route("POST", "/console/runs", ({ db, req, body }) => {
    const actor = resolveActor(req, db);
    const f = form(body);
    const out = runs.reserveRun(db, actor, {
      claim_id: f.claim_id, offer_id: f.offer_id,
      max_spend_minor: Number(f.max_spend_minor),
    }, f.idempotency_key);
    return redirect(`/runs/${out.run.id}`);
  }, { raw: true });

  route("GET", "/runs/:id", ({ db, req, params }) => {
    const actor = (() => { try { return resolveActor(req, db); } catch { return null; } })();
    if (!actor) return redirect("/login");
    const run = runs.assertRunAccess(db, params.id, actor);
    const claim = claims.getClaim(db, run.claim_id);
    const ev = evaluate.getEvaluation(db, run.id);
    const sealed = artifacts.sealedManifest(db, run.id);
    const lease = leases.reapLease(db, run.id);
    const ind = reports.independenceEvidence(db, run);
    const arts = sealed ? artifacts.listArtifacts(db, run.id, sealed.epoch) : [];

    const workerActions = actor.role === "worker" && actor.org_id === run.worker_org_id ? `
<h2>Worker actions</h2>
<form method="post" action="/console/runs/${run.id}/lease"><button>issue lease</button></form>
${lease ? `<p class="small">active lease epoch ${lease.epoch}, expires ${esc(lease.expires_at)}</p>
<form method="post" action="/console/runs/${run.id}/heartbeat"><button>heartbeat</button></form>
<form method="post" action="/console/runs/${run.id}/execute"><button>execute recipe (fenced)</button></form>
<form method="post" action="/console/runs/${run.id}/seal"><button>upload bundle &amp; seal manifest</button></form>` : ""}` : "";

    const evalAction = ["evaluator", "maintainer"].includes(actor.role) &&
      run.state === "artifacts_received"
      ? `<form method="post" action="/console/runs/${run.id}/evaluate"><button>run evaluator</button></form>` : "";

    const comparison = ev ? `
<h2>Comparison</h2>
<table><thead><tr><th scope="col">metric</th><th scope="col">reference</th>
<th scope="col">observed</th><th scope="col">difference</th><th scope="col">tolerance</th>
<th scope="col">verdict</th></tr></thead><tbody><tr>
<td>${esc(claim.metric)} (${esc(claim.units)})</td><td>${esc(claim.reference_decimal)}</td>
<td>${esc(ev.observed_decimal ?? "—")}</td><td>see explanation</td>
<td>${esc(claim.absolute_tolerance)}</td><td>${badge(ev.outcome)}</td></tr></tbody></table>
<p>${esc(ev.explanation)}</p>` : "";

    return ok(page(`Run ${run.id}`, actor, `<h1>Run <code>${esc(run.id)}</code></h1>
<p>state ${badge(run.state)} ${run.outcome ? `· outcome ${badge(run.outcome)}` : ""}
· attempt ${run.attempt}</p>
<dl>
<dt>claim</dt><dd><code>${esc(run.claim_id)}</code></dd>
<dt>recipe</dt><dd><code>${esc(run.recipe_id)}</code></dd>
<dt>worker org</dt><dd><code>${esc(run.worker_org_id)}</code>
  (independence: ${esc(ind.independence_status)})</dd>
<dt>sponsor org</dt><dd><code>${esc(run.sponsor_org_id)}</code></dd>
</dl>
${workerActions}${evalAction}
${comparison}
<h2>Artifacts${sealed ? ` (sealed epoch ${sealed.epoch})` : ""}</h2>
${arts.length ? `<table><thead><tr><th scope="col">path</th><th scope="col">sha256</th><th scope="col">bytes</th></tr></thead><tbody>
${arts.map((a) => `<tr><td><code>${esc(a.path)}</code></td><td><code>${esc(a.sha256.slice(0, 16))}…</code></td><td>${a.size}</td></tr>`).join("")}
</tbody></table>` : "<p>none yet</p>"}
<p><a href="/v1/runs/${run.id}/report">JSON report</a> ·
<a href="/v1/runs/${run.id}/report/download">download packet</a></p>`));
  }, { public: true });

  route("POST", "/console/runs/:id/lease", ({ db, req, params }) => {
    const actor = resolveActor(req, db);
    leases.issueLease(db, actor, params.id, {});
    return redirect(`/runs/${params.id}`);
  }, { raw: true });

  route("POST", "/console/runs/:id/heartbeat", ({ db, req, params }) => {
    const actor = resolveActor(req, db);
    const lease = leases.activeLease(db, params.id);
    if (lease) leases.heartbeat(db, actor, params.id, lease.token);
    return redirect(`/runs/${params.id}`);
  }, { raw: true });

  route("POST", "/console/runs/:id/execute", ({ db, req, params }) => {
    const actor = resolveActor(req, db);
    const run = runs.getRun(db, params.id);
    const lease = leases.activeLease(db, params.id);
    if (!lease) throw new HttpError(409, "LEASE_EXPIRED", "no active lease");
    executeRun(db, run, lease, {});
    return redirect(`/runs/${params.id}`);
  }, { raw: true });

  route("POST", "/console/runs/:id/seal", ({ db, req, params }) => {
    const actor = resolveActor(req, db);
    const run = runs.getRun(db, params.id);
    const lease = leases.activeLease(db, params.id);
    if (!lease) throw new HttpError(409, "LEASE_EXPIRED", "no active lease");
    // Upload the workspace's produced files as the run bundle, then seal.
    const wsDir = workspaceFor(run.id, lease.epoch);
    for (const rel of ["outputs/predictions.csv", "runtime.json", "logs/run.log"]) {
      const f = `${wsDir}/${rel}`;
      if (!fs.existsSync(f)) continue;
      artifacts.uploadArtifact(db, actor, run.id,
        { path: rel, body: fs.readFileSync(f) }, lease.token);
    }
    const arts = artifacts.listArtifacts(db, run.id, lease.epoch);
    artifacts.sealManifest(db, actor, run.id,
      { files: arts.map((a) => ({ path: a.path, sha256: a.sha256 })) }, lease.token);
    return redirect(`/runs/${params.id}`);
  }, { raw: true });

  route("POST", "/console/runs/:id/evaluate", ({ db, req, params }) => {
    const actor = resolveActor(req, db);
    evaluate.evaluateRun(db, actor, params.id);
    return redirect(`/runs/${params.id}`);
  }, { raw: true });
}
