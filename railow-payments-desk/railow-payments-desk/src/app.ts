// HTTP app: the MCP endpoint Chord connects to, plus a few small ops endpoints.
// Stateless Streamable HTTP: each request gets a fresh MCP server, which suits serverless hosts.

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { config } from "./config.js";
import { store, storeKind } from "./store.js";
import { seed, livePaymentPlan, type ScenarioKey } from "./seed.js";
import { initializePayment, pingPaystack } from "./paystack.js";

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

app.get("/health", (_req, res) => res.json({ ok: true, version: "2026-10-23.3", brand: config.brand, paystack_mode: config.paystackMode, store: storeKind }));

// Owner inbox: the out-of-band messages (with approval codes) for demos without email set up.
app.get("/ops/inbox", opsOnly, async (_req, res) => res.json(await store.listAll("owner_inbox")));

// --- Demo seeding from the browser (no local setup, the Paystack key never leaves the server) ---
// Step 1: /ops/seed-links?token=...  creates one Paystack TEST checkout per live scenario.
// Step 2: pay each link with the card shown.
// Step 3: /ops/reseed?token=...      loads the demo riders using those references.
// Run /ops/reseed again any time to reset the demo between recordings.

// Hide credentials embedded in URLs (e.g. rediss://user:password@host) before showing any error.
const redact = (s: string) => s.replace(/\/\/[^\s/@"]+@/g, "//***@").replace(/sk_(test|live)_\w+/g, "sk_$1_***");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const seedLinks = async (_req: Request, res: Response) => {
  if (config.paystackMode !== "live" || !config.paystackSecret.startsWith("sk_test_")) {
    return res.status(400).send("Set PAYSTACK_MODE=live and a TEST secret key (sk_test_...) first.");
  }
  const stamp = Date.now().toString(36);
  const refs: Record<string, string> = {};
  const rows: string[] = [];
  for (const p of livePaymentPlan) {
    const reference = `RW_${p.key}_${stamp}`;
    try {
      const url = await initializePayment(`railow.demo+${p.key}@example.com`, p.payNaira * 100, reference);
      refs[p.key] = reference;
      rows.push(`<tr><td>${esc(p.key)}</td><td>₦${p.payNaira.toLocaleString()}</td><td>${esc(p.card)}</td><td>${esc(p.outcome)}</td><td><a href="${esc(url)}" target="_blank">Pay</a></td></tr>`);
    } catch (e) {
      rows.push(`<tr><td>${esc(p.key)}</td><td colspan="4">Could not create link: ${esc(String((e as Error).message))}</td></tr>`);
    }
  }
  await store.set("live_refs", refs);
  res.send(`<!doctype html><meta charset="utf-8"><title>Seed links</title>
<body style="font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem">
<h2>Paystack test checkouts</h2>
<p>Open each link, pay with the card shown (expiry <b>09/27</b>, any PIN/OTP Paystack asks for is in its test docs).
When all are paid, open <code>/ops/reseed?token=…</code> to load the demo riders.</p>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>Scenario</th><th>Pay</th><th>Card</th><th>Expected</th><th></th></tr>${rows.join("")}</table></body>`);
};
app.get("/ops/seed-links", opsOnly, seedLinks);
app.post("/ops/seed-links", opsOnly, seedLinks);

// Reset the demo data. Uses references passed in the body, else the ones saved by /ops/seed-links.
const reseed = async (req: Request, res: Response) => {
  const saved = (await store.get<Record<string, string>>("live_refs")) ?? {};
  const refs = (req.body?.live_refs ?? saved) as Partial<Record<ScenarioKey, string>>;
  const result = await seed(refs);
  await store.set("live_refs", refs); // seed() clears the store, so keep the references for next time
  res.json({ ...result, simulated: livePaymentPlan.filter((p) => !refs[p.key]).map((p) => p.key) });
};
app.get("/ops/reseed", opsOnly, reseed);
app.post("/ops/reseed", opsOnly, reseed);

// Checks every dependency and says in plain words what is wrong. Never prints secret values.
app.get("/ops/diagnose", opsOnly, async (_req, res) => {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? "";
  const key = process.env.PAYSTACK_SECRET_KEY ?? "";
  const env = {
    PAYSTACK_MODE: config.paystackMode,
    PAYSTACK_SECRET_KEY: !key ? "missing" : key.startsWith("sk_test_") ? "set (test key)" : key.startsWith("sk_live_") ? "LIVE KEY: replace with a test key" : "set, but does not start with sk_test_",
    UPSTASH_REDIS_REST_URL: !url ? "missing" : url.startsWith("https://") ? "set" : "WRONG: must be the REST URL starting with https:// (not redis:// or rediss://)",
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ? "set" : "missing",
    MCP_BEARER_TOKEN: config.mcpBearerToken ? "set" : "missing",
  };
  let database: { ok: boolean; detail: string };
  try {
    await store.set("diag", Date.now());
    database = (await store.get("diag")) ? { ok: true, detail: `read/write works (${storeKind})` } : { ok: false, detail: "write succeeded but read returned nothing" };
  } catch (e) {
    database = { ok: false, detail: redact(String((e as Error)?.message ?? e)).slice(0, 300) };
  }
  let paystack: { ok: boolean; detail: string };
  try { paystack = await pingPaystack(); } catch (e) { paystack = { ok: false, detail: redact(String((e as Error)?.message ?? e)).slice(0, 300) }; }
  res.json({ version: "2026-10-23.3", env, database, paystack });
});

// Last resort: log the error, and on ops pages show the reason instead of a bare 500.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error("[unhandled]", req.path, err);
  if (res.headersSent) return;
  const detail = req.path.startsWith("/ops") ? redact(String((err as Error)?.message ?? err)).slice(0, 300) : undefined;
  res.status(500).json({ error: "internal_error", detail, hint: req.path.startsWith("/ops") ? "Open /ops/diagnose?token=... to check each dependency." : undefined });
});
