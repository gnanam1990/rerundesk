// Authorization regression: actor/tenant authority is server-side.
// Client-supplied identity headers are a dev-only fixture gated on
// RERUNDESK_DEV_AUTH=1; credentials bind org+role from stored enrollment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, api, seedOrgs } from "./helpers.mjs";

test("A-01: identity headers are rejected without the dev flag", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);

  const r = await api(app.base, { org: actors.sponsorOrg, role: "sponsor",
    path: "/v1/runs" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, "DEV_AUTH_DISABLED");

  // Forged role escalation: a real worker credential plus a maintainer
  // header must still resolve as the stored worker role.
  const r2 = await api(app.base, { ...actors.worker, role: "maintainer",
    method: "POST", path: "/v1/datasets", body: {} });
  assert.equal(r2.status, 403);
  assert.equal(r2.body.error.code, "ROLE_DENIED");

  // Garbage credentials are rejected.
  const r3 = await api(app.base, { token: "rdc_" + "0".repeat(48),
    path: "/v1/runs" });
  assert.equal(r3.status, 401);
});

test("A-02: credentials bind org+role from stored records", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);

  // A sponsor credential cannot mint a worker credential — kind is authority.
  const r = await api(app.base, { ...actors.sponsor, method: "POST",
    path: `/v1/orgs/${actors.sponsorOrg}/credentials`, body: { role: "worker" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "ROLE_ORG_MISMATCH");

  // Cross-tenant provisioning is denied.
  const r2 = await api(app.base, { ...actors.worker, method: "POST",
    path: `/v1/orgs/${actors.sponsorOrg}/credentials`, body: { role: "viewer" } });
  assert.equal(r2.status, 403);
  assert.equal(r2.body.error.code, "TENANT_DENIED");

  // Session exchange validates the credential; org/role come from storage.
  const s = await api(app.base, { method: "POST", path: "/v1/sessions",
    body: { credential: actors.sponsor.token } });
  assert.equal(s.status, 201);
  assert.equal(s.body.org_id, actors.sponsorOrg);
  assert.equal(s.body.role, "sponsor");

  const s2 = await api(app.base, { method: "POST", path: "/v1/sessions",
    body: { org_id: actors.sponsorOrg, role: "maintainer" } });
  assert.equal(s2.status, 401);
});

test("A-03: dev-fixture headers work only under explicit opt-in", async (t) => {
  const app = await makeApp();
  t.after(() => { delete process.env.RERUNDESK_DEV_AUTH; app.close(); });
  const actors = await seedOrgs(app.base);

  process.env.RERUNDESK_DEV_AUTH = "1";
  const on = await api(app.base, { org: actors.sponsorOrg, role: "viewer",
    path: "/v1/orgs" });
  assert.equal(on.status, 200);

  delete process.env.RERUNDESK_DEV_AUTH;
  const off = await api(app.base, { org: actors.sponsorOrg, role: "viewer",
    path: "/v1/orgs" });
  assert.equal(off.status, 401);
});
