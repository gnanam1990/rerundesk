// Local ledger adapter — a team-controlled, explicitly labeled merchant rail.
// This is NOT a verified external payment rail: entries are provider
// 'local-ledger' and are marked local_only. An external rail (e.g. Kite
// Passport) is not integrated in this environment; see build-progress.
import crypto from "node:crypto";
import { now } from "../db.js";

export const PROVIDER = "local-ledger";

export function reserve(db, runId, amountMinor, currency, note) {
  const orderId = "lo_" + crypto.createHash("sha256")
    .update(`${runId}:reservation`).digest("hex").slice(0, 24);
  const id = "led_" + crypto.randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO ledger(id, run_id, kind, amount_minor, currency, provider,
       merchant_order_id, status, note, created_at)
     VALUES (?, ?, 'reservation', ?, ?, ?, ?, 'authorized', ?, ?)`
  ).run(id, runId, amountMinor, currency, PROVIDER, orderId, note ?? null, now());
  return { merchant_order_id: orderId, status: "authorized", provider: PROVIDER };
}

export function capture(db, runId, note) {
  const res = db.prepare(
    "SELECT * FROM ledger WHERE run_id = ? AND kind = 'reservation'"
  ).get(runId);
  if (!res) return null;
  const orderId = res.merchant_order_id;
  const existing = db.prepare(
    "SELECT * FROM ledger WHERE merchant_order_id = ? AND kind = 'capture'"
  ).get(orderId);
  if (existing) return existing;
  const id = "led_" + crypto.randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO ledger(id, run_id, kind, amount_minor, currency, provider,
       merchant_order_id, status, note, created_at)
     VALUES (?, ?, 'capture', ?, ?, ?, ?, 'captured', ?, ?)`
  ).run(id, runId, res.amount_minor, res.currency, PROVIDER, orderId,
        note ?? null, now());
  return db.prepare("SELECT * FROM ledger WHERE id = ?").get(id);
}

// Reconciliation by merchant order identity. Anything we cannot positively
// confirm from the ledger record reports 'unconfirmed' — never 'settled'.
export function settlementFor(db, runId) {
  const rows = db.prepare(
    "SELECT * FROM ledger WHERE run_id = ? ORDER BY created_at"
  ).all(runId);
  if (!rows.length) {
    return { status: "none", provider: PROVIDER, entries: [],
             note: "no ledger entries recorded" };
  }
  const cap = rows.find((r) => r.kind === "capture");
  const res = rows.find((r) => r.kind === "reservation");
  let status;
  if (cap && cap.status === "captured") status = "captured";
  else if (res && res.status === "authorized") status = "authorized";
  else status = "unconfirmed";
  return {
    status,
    provider: PROVIDER,
    local_only: true,
    merchant_order_id: res?.merchant_order_id ?? null,
    entries: rows,
    note: "local-ledger is a team-controlled rail, not a verified external payment",
  };
}

export function costHistory(db, runId) {
  return db.prepare(
    `SELECT kind, amount_minor, currency, provider, merchant_order_id, status,
            note, created_at
     FROM ledger WHERE run_id = ? ORDER BY created_at`
  ).all(runId);
}
