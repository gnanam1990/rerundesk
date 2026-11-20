// Content-addressed object store for large evidence; DB rows carry sha256 refs.
import fs from "node:fs";
import path from "node:path";
import { sha256hex } from "./canonical.js";
import { DATA_DIR } from "./db.js";
import { now } from "./db.js";

function objPath(hash) {
  return path.join(DATA_DIR, "objects", hash.slice(0, 2), hash);
}

export function putObject(db, buffer, kind) {
  const hash = sha256hex(buffer);
  const p = objPath(hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buffer, { mode: 0o444 });
  }
  db.prepare(
    `INSERT INTO objects(sha256, path, bytes, kind, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO NOTHING`
  ).run(hash, p, buffer.length, kind, now());
  return hash;
}

export function getObjectPath(hash) {
  return objPath(hash);
}

export function readObject(db, hash) {
  const row = db.prepare("SELECT path, bytes FROM objects WHERE sha256 = ?").get(hash);
  if (!row) return null;
  const buf = fs.readFileSync(row.path);
  if (sha256hex(buf) !== hash) {
    const err = new Error(`object ${hash.slice(0, 12)} failed integrity check`);
    err.code = "OBJECT_CORRUPT";
    throw err;
  }
  return buf;
}
