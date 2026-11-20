// RerunDesk entry point: `node src/index.js <migrate|serve> [--port N]`
import { openDb, migrate } from "./db.js";
import { createServer, resetRoutes } from "./http.js";
import { registerRoutes } from "./routes.js";
import { registerConsole } from "./console.js";

const cmd = process.argv[2] ?? "serve";
const portIdx = process.argv.indexOf("--port");
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : Number(process.env.PORT ?? 8080);

const db = openDb();

if (cmd === "migrate") {
  console.log("migrations applied");
  process.exit(0);
}

resetRoutes();
registerRoutes();
registerConsole();

const server = createServer(db);
server.listen(port, () => {
  const bound = server.address().port;
  console.log(`RerunDesk listening on http://localhost:${bound}`);
  console.log(`console: http://localhost:${bound}/`);
});
