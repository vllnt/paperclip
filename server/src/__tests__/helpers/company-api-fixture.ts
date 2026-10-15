/**
 * Standalone fixture for UI tests that need the real company API: an embedded
 * Postgres, one company with a run-context policy, and the real company routes
 * behind a board actor. Prints one JSON line `{ origin, companyId }` once
 * listening and cleans up on SIGTERM/SIGINT.
 *
 * Run from `server/` with tsx; see ui/src/pages/CompanySettingsRunContext.test.tsx.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { companyRoutes } from "../../routes/companies.js";
import { errorHandler } from "../../middleware/error-handler.js";

const database = await startEmbeddedPostgresTestDatabase("company-api-fixture-");
const db = createDb(database.connectionString);
const companyId = randomUUID();
await db.insert(companies).values({
  id: companyId,
  name: "Fixture company",
  issuePrefix: "FXT",
  defaultResponsibleUserId: "board",
  runContextPolicy: { maxComments: 8 },
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.actor = { type: "board", userId: "board", source: "local_implicit", isInstanceAdmin: true };
  next();
});
app.use("/api/companies", companyRoutes(db));
app.use(errorHandler);

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Expected a TCP address");
console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, companyId }));

async function cleanup() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.cleanup();
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
