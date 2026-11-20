// Canonical JSON serialization (recursive key sort, no whitespace) and hashing.
import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ":" + canonicalize(value[k])
  );
  return "{" + parts.join(",") + "}";
}

export function sha256hex(input) {
  const h = createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

export function contentId(value) {
  return sha256hex(canonicalize(value));
}
