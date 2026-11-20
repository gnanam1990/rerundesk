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
        const err = e instanceof HttpError ? e
          : (console.error(e), new HttpError(500, "INTERNAL", "internal error"));
        if (req.headers.accept?.includes("text/html")) {
          const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
          res.writeHead(err.status, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${err.status} ${esc(err.code)} · RerunDesk</title>
<style>body{font-family:ui-monospace,Menlo,monospace;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
.err{border:1px solid #b33;background:#b332;padding:1rem}</style></head>
<body><h1>${err.status} ${esc(err.code)}</h1>
<p class="err" role="alert">${esc(err.message)}</p>
<p><a href="/">back to console</a></p></body></html>`);
        } else {
          const body = { error: { code: err.code, message: err.message } };
          if (err.details) body.error.details = err.details;
          if (err.recipe) body.recipe = err.recipe;
          send(res, err.status, body);
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
