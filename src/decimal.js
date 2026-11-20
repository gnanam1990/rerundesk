// Exact fixed-point decimal arithmetic on BigInt. Scale = 10^18.
export const SCALE = 10n ** 18n;

export function parseDecimal(str, field = "decimal") {
  if (typeof str !== "string" && typeof str !== "number")
    throw new Error(`${field}: not a decimal`);
  const s = String(str).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`${field}: invalid decimal '${s}'`);
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = s.replace(/^-/, "").split(".");
  if (fracPart.length > 18) throw new Error(`${field}: too many decimal places`);
  const scaled = BigInt(intPart + fracPart.padEnd(18, "0") || "0");
  return neg ? -scaled : scaled;
}

export function formatDecimal(scaled, places = 3) {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const intPart = abs / SCALE;
  if (places === 0) return `${neg ? "-" : ""}${intPart}`;
  const frac = (abs % SCALE).toString().padStart(18, "0").slice(0, places);
  return `${neg ? "-" : ""}${intPart}.${frac}`;
}

// Exact comparison: |correct/total - ref| <= tol, with no floating point.
// correct,total: BigInt/nonneg ints; refScaled,tolScaled: scaled BigInt.
export function withinTolerance(correct, total, refScaled, tolScaled) {
  const c = BigInt(correct);
  const t = BigInt(total);
  // |c*SCALE - ref*t| <= tol*t
  const lhs = c * SCALE - refScaled * t;
  const diff = lhs < 0n ? -lhs : lhs;
  return diff <= tolScaled * t;
}

// Exact absolute difference scaled to SCALE: |correct/total - ref| * SCALE.
// Computed as |c*SCALE - ref*t| / t (truncated to integer scaled units).
export function absDifference(correct, total, refScaled) {
  const c = BigInt(correct);
  const t = BigInt(total);
  const lhs = c * SCALE - refScaled * t;
  const diff = lhs < 0n ? -lhs : lhs;
  return diff / t;
}

export function observedScaled(correct, total) {
  return (BigInt(correct) * SCALE) / BigInt(total);
}
