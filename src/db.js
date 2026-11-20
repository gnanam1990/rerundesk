// SQLite persistence via node:sqlite. Versioned migrations; all domain writes
// that pair a decision with side effects run inside a transaction.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.RERUNDESK_DATA
  ? path.resolve(process.env.RERUNDESK_DATA)
  : path.resolve(process.cwd(), "data");

const MIGRATIONS = [
  // v1: core domain schema
  `
  CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sponsor','worker','both')),
    evidence_json TEXT NOT NULL DEFAULT '{}',
    independence_status TEXT NOT NULL DEFAULT 'unknown'
      CHECK (independence_status IN ('enrolled','attested','unknown')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    role TEXT NOT NULL CHECK (role IN ('maintainer','sponsor','worker','evaluator','viewer')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE objects (
    sha256 TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    license_ref TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    dataset_sha256 TEXT NOT NULL REFERENCES objects(sha256),
    gold_sha256 TEXT NOT NULL REFERENCES objects(sha256),
    sample_count INTEGER NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE recipes (
    id TEXT PRIMARY KEY,
    canonical_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','admitted','rejected')),
    rejection_reasons_json TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    canonical_json TEXT NOT NULL,
    recipe_hash TEXT NOT NULL REFERENCES recipes(id),
    metric TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    evaluator_digest TEXT NOT NULL,
    reference_decimal TEXT NOT NULL,
    absolute_tolerance TEXT NOT NULL,
    seed_list_json TEXT NOT NULL,
    hardware_class TEXT NOT NULL,
    aggregation TEXT,
    units TEXT NOT NULL,
    sponsor_org_id TEXT NOT NULL REFERENCES orgs(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE offers (
    id TEXT PRIMARY KEY,
    worker_org_id TEXT NOT NULL REFERENCES orgs(id),
    price_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reserved','closed')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(id),
    recipe_id TEXT NOT NULL REFERENCES recipes(id),
    offer_id TEXT NOT NULL REFERENCES offers(id),
    sponsor_org_id TEXT NOT NULL REFERENCES orgs(id),
    worker_org_id TEXT NOT NULL REFERENCES orgs(id),
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'authorized','leased','running','lease_expired',
      'artifacts_received','evaluated','cancelled')),
    outcome TEXT CHECK (outcome IN ('reproduced','diverged','inconclusive')),
    max_spend_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    client_request_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX runs_idem ON runs(client_request_key, sponsor_org_id)
    WHERE client_request_key IS NOT NULL;
  CREATE INDEX runs_state ON runs(state);
  CREATE INDEX runs_worker ON runs(worker_org_id);

  CREATE TABLE idempotency (
    key TEXT NOT NULL,
    org_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    operation_ref TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, org_id)
  );

  CREATE TABLE leases (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    epoch INTEGER NOT NULL,
    worker_org_id TEXT NOT NULL REFERENCES orgs(id),
    token TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','expired','superseded','closed')),
    UNIQUE (run_id, epoch)
  );
  CREATE UNIQUE INDEX leases_one_active ON leases(run_id) WHERE status = 'active';

  CREATE TABLE artifacts (
    run_id TEXT NOT NULL REFERENCES runs(id),
    epoch INTEGER NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL REFERENCES objects(sha256),
    size INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, epoch, path)
  );

  CREATE TABLE manifests (
    run_id TEXT NOT NULL REFERENCES runs(id),
    epoch INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    sealed_by TEXT NOT NULL,
    sealed_at TEXT NOT NULL,
    PRIMARY KEY (run_id, epoch)
  );
  -- Only one accepted epoch may carry the authoritative sealed manifest.
  CREATE UNIQUE INDEX manifests_accepted_epoch ON manifests(run_id);

  CREATE TABLE evaluations (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    manifest_hash TEXT NOT NULL,
    observed_decimal TEXT,
    observed_fraction TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('reproduced','diverged','inconclusive')),
    reason_code TEXT,
    explanation TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    evaluator_digest TEXT NOT NULL,
    evaluated_at TEXT NOT NULL
  );

  CREATE TABLE ledger (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL CHECK (kind IN ('reservation','capture','refund')),
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    provider TEXT NOT NULL,
    merchant_order_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN
      ('authorized','captured','pending_external','unconfirmed','failed','refunded')),
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX ledger_order ON ledger(merchant_order_id, kind);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_run ON events(run_id);
  `,
  // v2: provisioned opaque credentials. Only the sha256 hash of the token is
  // stored; the plaintext is returned once at provisioning.
  `
  CREATE TABLE credentials (
    token_hash TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    role TEXT NOT NULL CHECK (role IN ('maintainer','sponsor','worker','evaluator','viewer')),
    label TEXT,
    issued_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX credentials_org ON credentials(org_id);
  `,
];

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const row = db.prepare("SELECT COALESCE(MAX(version),0) v FROM migrations").get();
  let v = row.v;
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(
        v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    v++;
  }
  return v;
}

export function openDb(dbPath) {
  const file = dbPath || path.join(DATA_DIR, "rerundesk.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function txn(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const now = () => new Date().toISOString();
