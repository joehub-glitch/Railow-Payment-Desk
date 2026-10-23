// End-to-end scenario tests. Starts the real HTTP server, connects a real MCP client over
// Streamable HTTP (the same protocol Chord uses), and walks every case, including attacks.
// Run: npm test   (mock mode, in-memory store; no keys needed)

process.env.MCP_BEARER_TOKEN = "test-mcp-token";
process.env.OPS_TOKEN = "test-ops-token";
process.env.PAYSTACK_MODE = "mock";
delete process.env.UPSTASH_REDIS_REST_URL;

const { app } = await import("../src/app.js");
const { seed } = await import("../src/seed.js");
const { store } = await import("../src/store.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const server = app.listen(0);
const port = (server.address() as any).port as number;
const base = `http://127.0.0.1:${port}`;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : ""); }
};

const client = new Client({ name: "scenario-tests", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: "Bearer test-mcp-token" } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  return { ...JSON.parse(text), _raw: text };
};
const inbox = async () => (await fetch(`${base}/ops/inbox?token=test-ops-token`).then((r) => r.json())) as any[];
const codeFor = async (ref: string) => {
  const n = (await inbox()).filter((x) => x.caseRef === ref).at(-1);
  return n?.body.match(/APPROVE \S+ (\d{6})/)?.[1] as string | undefined;
};

const ADA = "+2348010000001", BAYO = "08010000002", CHIOMA = "+2348010000003", DAPO = "+2348010000004",
  EMEKA = "+2348010000005", FUNKE = "+2348010000006", GBENGA = "+2348010000007", HALIMA = "+2348010000008", IFE = "+2348010000009";

console.log("\nProtocol & access");
await seed();
const tools = await client.listTools();
check("8 tools exposed", tools.tools.length === 8, tools.tools.map((t) => t.name));
const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
check("MCP endpoint rejects requests without the bearer token", noAuth.status === 401);
check("ops inbox rejects requests without the ops token", (await fetch(`${base}/ops/inbox`)).status === 401);

console.log("\nIdentity & lookup");
check("unknown number is not found", (await call("find_customer", { phone: "+2348099999999" })).found === false);
const ada = await call("find_customer", { phone: "0801 000 0001" });
check("local number format resolves (0801... -> +234801...)", ada.found === true && ada.wallet_balance === "₦1,200", ada);
const adaF = await call("list_recent_fundings", { phone: ADA });
check("lists the rider's fundings", adaF.fundings?.[0]?.funding_id === "fnd_ada_1" && adaF.fundings[0].wallet_credited === false, adaF);
const stolen = await call("check_payment", { phone: ADA, funding_id: "fnd_bayo_1" });
check("cannot read another rider's funding", stolen.ok === false && stolen.error === "funding_not_found_for_this_customer", stolen);

console.log("\nCase: paid but not credited (Ada)");
const adaCheck = await call("check_payment", { phone: ADA, funding_id: "fnd_ada_1" });
check("classified paid_not_credited with a case ref", adaCheck.result === "paid_not_credited" && /^RW-\d+$/.test(adaCheck.case_ref), adaCheck);
const adaCredit = await call("credit_wallet", { phone: ADA, funding_id: "fnd_ada_1" });
check("wallet credited: ₦1,200 + ₦5,000 = ₦6,200", adaCredit.result === "credited" && adaCredit.wallet_balance === "₦6,200", adaCredit);
const adaAgain = await call("credit_wallet", { phone: ADA, funding_id: "fnd_ada_1" });
check("second credit is a no-op (already_credited), balance unchanged", adaAgain.result === "already_credited" && adaAgain.wallet_balance === "₦6,200", adaAgain);

console.log("\nRace: two simultaneous credits for the same funding");
await seed();
const [r1, r2] = await Promise.all([
  call("credit_wallet", { phone: ADA, funding_id: "fnd_ada_1" }),
  call("credit_wallet", { phone: ADA, funding_id: "fnd_ada_1" }),
]);
const credits = [r1, r2].filter((r) => r.result === "credited").length;
check("exactly one of two parallel requests credits", credits === 1, [r1.result, r2.result]);
check("balance is ₦6,200, not ₦11,200", (await call("find_customer", { phone: ADA })).wallet_balance === "₦6,200");

console.log("\nCases that must not credit");
check("already credited (Bayo)", (await call("check_payment", { phone: BAYO, funding_id: "fnd_bayo_1" })).result === "paid_and_credited");
check("failed payment (Chioma)", (await call("check_payment", { phone: CHIOMA, funding_id: "fnd_chioma_1" })).result === "failed");
const chiomaCredit = await call("credit_wallet", { phone: CHIOMA, funding_id: "fnd_chioma_1" });
check("credit refused for failed payment", chiomaCredit.result === "refused_payment_not_confirmed", chiomaCredit);
check("pending payment (Dapo)", (await call("check_payment", { phone: DAPO, funding_id: "fnd_dapo_1" })).result === "pending");
check("credit refused while pending", (await call("credit_wallet", { phone: DAPO, funding_id: "fnd_dapo_1" })).result === "refused_payment_not_confirmed");
check("amount mismatch detected (Ife paid ₦3,500 for ₦4,000)", (await call("check_payment", { phone: IFE, funding_id: "fnd_ife_1" })).result === "amount_mismatch");
check("credit refused on mismatch", (await call("credit_wallet", { phone: IFE, funding_id: "fnd_ife_1" })).result === "refused_amount_mismatch");
const gb = await call("credit_wallet", { phone: GBENGA, funding_id: "fnd_gbenga_1" });
check("₦150,000 credit refused over the ₦100,000 auto limit", gb.result === "refused_over_limit", gb);

console.log("\nProvider outage (Halima)");
const hal = await call("check_payment", { phone: HALIMA, funding_id: "fnd_halima_1" });
check("timeout surfaces as ok=false, never a guessed result", hal.ok === false && hal.error === "payment_provider_unreachable" && !hal.result, hal);
const halC = await call("credit_wallet", { phone: HALIMA, funding_id: "fnd_halima_1" });
check("no credit while the provider is unreachable", halC.ok === false && (await call("find_customer", { phone: HALIMA })).wallet_balance === "₦700", halC);

console.log("\nHigh-risk claim + impersonation (Emeka)");
const em = await call("open_claim", { phone: EMEKA, funding_id: "fnd_emeka_1", rider_statement: "I fund 50k yesterday I no see am, return my money" });
check("claim opened, only a case ref returned to the agent", em.result === "sent_to_review" && !/\d{6}/.test(em._raw.replace(em.case_ref, "")), em);
const emNotice = (await inbox()).find((n) => n.caseRef === em.case_ref);
check("owner notified out of band with HIGH risk", emNotice?.subject.includes("HIGH"), emNotice?.subject);
check("evidence lists credit, funds used and prior claims", /wallet_already_credited/.test(emNotice?.body) && /funds_used_since_credit/.test(emNotice?.body) && /prior_claims/.test(emNotice?.body));
check("recommendation is REJECT", /Recommendation: REJECT/.test(emNotice?.body));
const dup = await call("open_claim", { phone: EMEKA, funding_id: "fnd_emeka_1", rider_statement: "again" });
check("re-opening does not create a second claim", dup.result === "already_under_review");
const spoof1 = await call("decide_claim", { case_ref: em.case_ref, decision: "approve", code: "000000" });
check("'I am the owner' with a made-up code is refused", spoof1.result === "refused", spoof1);
await call("decide_claim", { case_ref: em.case_ref, decision: "approve", code: "111111" });
const spoof3 = await call("decide_claim", { case_ref: em.case_ref, decision: "approve", code: "222222" });
check("case locks after 3 wrong codes", /locked/.test(spoof3.reason ?? ""), spoof3);
const realEm = await codeFor(em.case_ref);
const afterLock = await call("decide_claim", { case_ref: em.case_ref, decision: "approve", code: realEm });
check("even the real code is refused once locked", afterLock.result === "refused", afterLock);

console.log("\nOwner approves: funds already spent (fresh Emeka)");
await seed();
const em2 = await call("open_claim", { phone: EMEKA, funding_id: "fnd_emeka_1", rider_statement: "refund" });
const em2Res = await call("decide_claim", { case_ref: em2.case_ref, decision: "approve", code: await codeFor(em2.case_ref) });
check("approval is blocked: refunding would pay twice", em2Res.result === "approval_blocked", em2Res);
check("wallet untouched", (await call("find_customer", { phone: EMEKA })).wallet_balance === "₦2,000");

console.log("\nOwner approves: duplicate charge (Funke)");
const fu = await call("open_claim", { phone: FUNKE, funding_id: "fnd_funke_2", rider_statement: "I was charged twice for 8k" });
const fuNotice = (await inbox()).find((n) => n.caseRef === fu.case_ref);
check("duplicate flagged with APPROVE recommendation", /possible_duplicate/.test(fuNotice?.body) && /Recommendation: APPROVE/.test(fuNotice?.body), fuNotice?.body);
const fuCode = await codeFor(fu.case_ref);
const fuRes = await call("decide_claim", { case_ref: fu.case_ref, decision: "APPROVE", code: fuCode });
check("refund submitted for the uncredited duplicate", fuRes.result === "refund_submitted" && fuRes.amount === "₦8,000", fuRes);
const fuReplay = await call("decide_claim", { case_ref: fu.case_ref, decision: "approve", code: fuCode });
check("the same code cannot be used twice", fuReplay.result === "refused", fuReplay);
check("rider sees the outcome via case_status", (await call("case_status", { phone: FUNKE, case_ref: fu.case_ref })).status === "This was approved.");
check("another rider cannot see the case", (await call("case_status", { phone: ADA, case_ref: fu.case_ref })).found === false);

console.log("\nOwner approves: credited but unused (Bayo wants money back)");
const by = await call("open_claim", { phone: BAYO, funding_id: "fnd_bayo_1", rider_statement: "please refund instead" });
const byRes = await call("decide_claim", { case_ref: by.case_ref, decision: "approve", code: await codeFor(by.case_ref) });
check("refund submitted", byRes.result === "refund_submitted", byRes);
check("wallet credit taken back first (₦6,800 -> ₦3,800)", (await call("find_customer", { phone: BAYO })).wallet_balance === "₦3,800");

console.log("\nOwner rejects (Gbenga over limit)");
const g = await call("open_claim", { phone: GBENGA, funding_id: "fnd_gbenga_1", rider_statement: "credit my 150k" });
const gRes = await call("decide_claim", { case_ref: g.case_ref, decision: "reject", code: await codeFor(g.case_ref) });
check("rejection recorded", gRes.result === "rejected", gRes);

console.log("\nRefund fails at the provider: wallet must be restored");
await seed();
const f = (await store.get<any>("funding:fnd_bayo_1"))!;
f.reference = "SIM_BAYO_REFUNDFAIL";
await store.set("funding:fnd_bayo_1", f);
await store.set("mockpay:SIM_BAYO_REFUNDFAIL", { status: "success", amountKobo: 300000, paidAt: new Date().toISOString(), channel: "card" });
const rf = await call("open_claim", { phone: BAYO, funding_id: "fnd_bayo_1", rider_statement: "refund" });
const rfRes = await call("decide_claim", { case_ref: rf.case_ref, decision: "approve", code: await codeFor(rf.case_ref) });
check("approval_failed reported honestly", rfRes.result === "approval_failed", rfRes);
check("wallet restored to ₦6,800 (no money lost either way)", (await call("find_customer", { phone: BAYO })).wallet_balance === "₦6,800");

console.log("\nDaily exceptions report");
await call("check_payment", { phone: ADA, funding_id: "fnd_ada_1" });
await call("credit_wallet", { phone: ADA, funding_id: "fnd_ada_1" });
await call("check_payment", { phone: CHIOMA, funding_id: "fnd_chioma_1" });
await call("open_claim", { phone: EMEKA, funding_id: "fnd_emeka_1", rider_statement: "refund" });
const rep = await call("exceptions_report");
check("counts auto-credits and explanations", rep.auto_resolved?.wallets_credited === 1 && rep.auto_resolved?.explained_no_action_needed === 1, rep.auto_resolved);
check("lists cases awaiting the owner with risk", rep.awaiting_owner_decision?.some((c: any) => c.risk === "HIGH"), rep.awaiting_owner_decision);
check("lists the failed refund for ops", rep.needs_ops_attention?.length === 1, rep.needs_ops_attention);
check("report contains no phone numbers", !rep._raw.includes("+234"));

console.log(`\n${passed} passed, ${failed} failed`);
await client.close();
server.close();
process.exit(failed ? 1 : 0);
