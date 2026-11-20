// Minimal HTTP router: method+pattern matching, JSON/raw bodies, error mapping.
import http from "node:http";
import { HttpError } from "./errors.js";
import { resolveActor } from "./auth.js";

const routes = [];

export function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp(
    "^" +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  routes.push({ method, rx, keys, handler, opts });
}

async function readBody(req, raw) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (raw) return buf;
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_JSON", "request body is not valid JSON");
  }
}

function send(res, status, body, headers = {}) {
  const payload =
    typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": Buffer.isBuffer(body)
      ? "application/octet-stream"
      : headers["content-type"] ?? "application/json; charset=utf-8",
    ...headers,
  });
  res.end(payload);
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.rx);
      if (!m) continue;
      try {
        const params = Object.fromEntries(
          r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])
        );
        const actor = r.opts.public ? null : resolveActor(req, db);
        const body = await readBody(req, r.opts.raw);
        const out = await r.handler({ db, actor, params, query: url.searchParams, body, req, res });
        if (out !== undefined && !res.writableEnded)
          send(res, out.status ?? 200, out.body ?? out, out.headers ?? {});
      } catch (e) {
        if (e instanceof HttpError) {
          const body = { error: { code: e.code, message: e.message } };
          if (e.details) body.error.details = e.details;
          if (e.recipe) body.recipe = e.recipe;
          send(res, e.status, body);
        } else {
          console.error(e);
          send(res, 500, { error: { code: "INTERNAL", message: "internal error" } });
        }
      }
      return;
    }
    send(res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });
  });
}

export function resetRoutes() {
  routes.length = 0;
}
