// HTTP app: the MCP endpoint Chord connects to, plus a few small ops endpoints.
// Stateless Streamable HTTP: each request gets a fresh MCP server, which suits serverless hosts.

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { config } from "./config.js";
import { store, storeKind } from "./store.js";
import { seed, type ScenarioKey } from "./seed.js";

export const app = express();
app.use(express.json({ limit: "1mb" }));

const bearer = (secret: string) => (req: Request, res: Response, next: NextFunction) => {
  if (!secret) return next(); // no secret configured: open (fine for local runs only)
  if (req.headers.authorization === `Bearer ${secret}`) return next();
  res.status(401).json({ error: "unauthorized" });
};
const opsOnly = (req: Request, res: Response, next: NextFunction) => {
  if (config.opsToken && (req.query.token === config.opsToken || req.headers.authorization === `Bearer ${config.opsToken}`)) return next();
  res.status(401).json({ error: "unauthorized" });
};

app.post("/mcp", bearer(config.mcpBearerToken), async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
// Stateless server: no SSE stream to resume and no session to delete.
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" }));

app.get("/health", (_req, res) => res.json({ ok: true, brand: config.brand, paystack_mode: config.paystackMode, store: storeKind }));

// Owner inbox: the out-of-band messages (with approval codes) for demos without email set up.
app.get("/ops/inbox", opsOnly, async (_req, res) => res.json(await store.listAll("owner_inbox")));

// Reset the demo data. Body may map scenario keys to real Paystack test references.
app.post("/ops/reseed", opsOnly, async (req, res) => {
  const refs = (req.body?.live_refs ?? {}) as Partial<Record<ScenarioKey, string>>;
  res.json(await seed(refs));
});
