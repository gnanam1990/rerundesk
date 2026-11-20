// M03 — Worker capacity offers with price, currency and expiry.
import crypto from "node:crypto";
import { now } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { getOrg } from "./orgs.js";

export function createOffer(db, actor, body, nowIso = now()) {
  const price = body?.price_minor;
  const currency = body?.currency;
  const ttl = body?.ttl_seconds;
  const capacity = body?.capacity ?? 1;
  if (!Number.isInteger(price) || price < 0)
    throw badRequest("PRICE_INVALID", "price_minor must be a non-negative integer");
  if (typeof currency !== "string" || !/^[A-Z]{3,10}$/.test(currency))
    throw badRequest("CURRENCY_INVALID", "currency must be an uppercase unit code");
  if (!Number.isInteger(ttl) || ttl <= 0)
    throw badRequest("TTL_INVALID", "ttl_seconds must be a positive integer");
  if (!Number.isInteger(capacity) || capacity <= 0)
    throw badRequest("CAPACITY_INVALID", "capacity must be a positive integer");
  const org = getOrg(db, actor.org_id);
  if (!["worker", "both"].includes(org.kind))
    throw badRequest("ORG_NOT_WORKER", "only worker organizations can publish offers");

  const id = "off_" + crypto.randomBytes(8).toString("hex");
  const expiresAt = new Date(Date.parse(nowIso) + ttl * 1000).toISOString();
  db.prepare(
    `INSERT INTO offers(id, worker_org_id, price_minor, currency, capacity,
       expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(id, actor.org_id, price, currency, capacity, expiresAt, nowIso);
  return getOffer(db, id);
}

export function getOffer(db, id) {
  const o = db.prepare("SELECT * FROM offers WHERE id = ?").get(id);
  if (!o) throw notFound("offer not found");
  return o;
}

export function offerEligible(offer, nowIso) {
  return offer.status === "open" && offer.expires_at > nowIso;
}

export function listOffers(db, nowIso = now()) {
  return db
    .prepare("SELECT * FROM offers ORDER BY created_at")
    .all()
    .map((o) => ({ ...o, eligible: offerEligible(o, nowIso) }));
}
