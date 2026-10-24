// End-to-end scenario tests. Starts the real HTTP server, connects a real MCP client over
// Streamable HTTP (the same protocol Chord uses), drives the Ops Console over HTTP with cookies
// and forms, and walks every case, including attacks.
// Run: npm test   (mock mode, in-memory store; no keys needed)

process.env.MCP_BEARER_TOKEN = "test-mcp-token";
process.env.OPS_TOKEN = "test-ops-token";
process.env.PAYSTACK_MODE = "mock";
process.env.APPROVER_OPS_LEAD_PASSWORD = "pw-ops-lead";
process.env.APPROVER_FINANCE_PASSWORD = "pw-finance";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

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
  else { failed++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); }
};

// ---------- MCP helpers ----------
const client = new Client({ name: "scenario-tests", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: "Bearer test-mcp-token" } },
}));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  return { ...JSON.parse(text), _raw: text };
};
const lastSms = async (phone: string) => (await store.listAll<{ text: string }>(`sms:${phone}`)).at(-1)?.text ?? "";
const codeIn = (sms: string) => sms.match(/code is (\d{6})/)?.[1] ?? "";
// Full verification the way a rider would do it: request a code, read it on "their phone", type it.
const verify = async (phone: string) => {
  await call("start_verification", { phone });
  const v = await call("verify_rider", { phone, code: codeIn(await lastSms(phone)) });
  return v.session as string;
};

// ---------- Console helpers ----------
const login = async (approver: string, password: string) => {
  const r = await fetch(`${base}/console/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ approver, password }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: r.status, location: r.headers.get("location") ?? "", cookie };
};
const getPage = async (cookie: string, path: string) => {
  const r = await fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", html: await r.text() };
};
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
const decide = async (cookie: string, ref: string, decision: string, reason: string, opts: { csrf?: string; origin?: string } = {}) => {
  const csrf = opts.csrf ?? csrfOf((await getPage(cookie, `/console/case/${ref}`)).html);
  const r = await fetch(`${base}/console/case/${ref}/decide`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...(opts.origin ? { origin: opts.origin } : {}) },
    body: new URLSearchParams({ csrf, decision, reason }),
  });
  const loc = r.headers.get("location") ?? "";
  return { status: r.status, message: decodeURIComponent(loc.split("msg=")[1] ?? "") };
};

const ADA = "+2348010000001", BAYO = "+2348010000002", CHIOMA = "+2348010000003", DAPO = "+2348010000004",
  EMEKA = "+2348010000005", FUNKE = "+2348010000006", GBENGA = "+2348010000007", HALIMA = "+2348010000008",
  IFE = "+2348010000009", KEMI = "+2348010000010";

// ======================================================================
console.log("\nProtocol & access");
await seed();
const tools = (await client.listTools()).tools.map((t) => t.name);
check("8 rider tools exposed", tools.length === 8, tools);
check("the agent has NO approve/reject tool", !tools.some((t) => /decide|approve|reject/.test(t)), tools);
check("the agent has the guarded refund_payment tool", tools.includes("refund_payment"), tools);
const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
check("MCP endpoint rejects requests without the bearer token", noAuth.status === 401);

console.log("\nRider verification");
const unknown = await call("start_verification", { phone: "+2348099999999" });
const known = await call("start_verification", { phone: "0801 000 0001" });
check("same answer for unknown and known numbers (no account discovery)", unknown.result === known.result && unknown.result === "code_sent_if_account_exists", [unknown.result, known.result]);
check("no SMS sent for an unknown number", (await store.listAll("sms:+2348099999999")).length === 0);
check("SMS sent to the REGISTERED phone for a known number", /code is \d{6}/.test(await lastSms(ADA)));
check("the code never appears in what the agent sees", !/\d{6}/.test(known._raw));
check("account tools refuse without verification", (await call("list_recent_fundings", { session: "" })).error === "verification_required");
check("made-up session refused", (await call("check_payment", { session: "abcdefghijkl", funding_id: "fnd_ada_1" })).error === "verification_required");
const w1 = await call("verify_rider", { phone: ADA, code: "000000" });
check("wrong code not accepted", w1.ok === false && !w1.session, w1);
await call("verify_rider", { phone: ADA, code: "111111" });
await call("verify_rider", { phone: ADA, code: "222222" });
const afterLock = await call("verify_rider", { phone: ADA, code: codeIn(await lastSms(ADA)) });
check("locked after 3 wrong codes, even the right code fails", afterLock.ok === false && !afterLock.session, afterLock);
await call("start_verification", { phone: ADA });
const good = await call("verify_rider", { phone: ADA, code: codeIn(await lastSms(ADA)) });
check("correct new code gives a session", good.ok === true && typeof good.session === "string" && good.wallet_balance === "₦1,200", good);
const reuse = await call("verify_rider", { phone: ADA, code: codeIn(await lastSms(ADA)) });
check("a code works only once", reuse.ok === false);
await call("start_verification", { phone: ADA }); // third code in 15 minutes: still allowed
const fourth = await call("start_verification", { phone: ADA });
check("a fourth code within 15 minutes is refused", fourth.result === "too_many_requests", fourth);
const sAda = good.session as string;
const sBayo = await verify(BAYO);
check("a rider cannot read another rider's funding", (await call("check_payment", { session: sAda, funding_id: "fnd_bayo_1" })).error === "funding_not_found_for_this_rider");
const sess = (await store.get<any>(`session:${sBayo}`))!;
await store.set(`session:${sBayo}`, { ...sess, expiresAt: new Date(Date.now() - 1000).toISOString() });
check("expired session refused", (await call("list_recent_fundings", { session: sBayo })).error === "verification_required");

console.log("\nCase: paid but not credited (Ada)");
const adaF = await call("list_recent_fundings", { session: sAda });
check("lists the rider's fundings", adaF.fundings?.[0]?.funding_id === "fnd_ada_1" && adaF.fundings[0].wallet_credited === false, adaF);
const adaCheck = await call("check_payment", { session: sAda, funding_id: "fnd_ada_1" });
check("classified paid_not_credited with a case ref", adaCheck.result === "paid_not_credited" && /^RW-\d+$/.test(adaCheck.case_ref), adaCheck);
const adaCredit = await call("credit_wallet", { session: sAda, funding_id: "fnd_ada_1" });
check("wallet credited: ₦1,200 + ₦5,000 = ₦6,200", adaCredit.result === "credited" && adaCredit.wallet_balance === "₦6,200", adaCredit);
const adaAgain = await call("credit_wallet", { session: sAda, funding_id: "fnd_ada_1" });
check("second credit is a no-op, balance unchanged", adaAgain.result === "already_credited" && adaAgain.wallet_balance === "₦6,200", adaAgain);

console.log("\nRace: two simultaneous credits for the same funding");
await seed();
const sAda2 = await verify(ADA);
const [r1, r2] = await Promise.all([
  call("credit_wallet", { session: sAda2, funding_id: "fnd_ada_1" }),
  call("credit_wallet", { session: sAda2, funding_id: "fnd_ada_1" }),
]);
check("exactly one of two parallel requests credits", [r1, r2].filter((r) => r.result === "credited").length === 1, [r1.result, r2.result]);
check("balance is ₦6,200, not ₦11,200", (await call("list_recent_fundings", { session: sAda2 })).wallet_balance === "₦6,200");

console.log("\nCases that must not credit");
const sB = await verify(BAYO), sC = await verify(CHIOMA), sD = await verify(DAPO), sI = await verify(IFE), sG = await verify(GBENGA), sH = await verify(HALIMA);
check("already credited (Bayo)", (await call("check_payment", { session: sB, funding_id: "fnd_bayo_1" })).result === "paid_and_credited");
check("failed payment (Chioma)", (await call("check_payment", { session: sC, funding_id: "fnd_chioma_1" })).result === "failed");
check("credit refused for failed payment", (await call("credit_wallet", { session: sC, funding_id: "fnd_chioma_1" })).result === "refused_payment_not_confirmed");
check("pending payment (Dapo)", (await call("check_payment", { session: sD, funding_id: "fnd_dapo_1" })).result === "pending");
check("credit refused while pending", (await call("credit_wallet", { session: sD, funding_id: "fnd_dapo_1" })).result === "refused_payment_not_confirmed");
check("amount mismatch detected (Ife paid ₦3,500 for ₦4,000)", (await call("check_payment", { session: sI, funding_id: "fnd_ife_1" })).result === "amount_mismatch");
check("credit refused on mismatch", (await call("credit_wallet", { session: sI, funding_id: "fnd_ife_1" })).result === "refused_amount_mismatch");
check("₦150,000 credit refused over the ₦100,000 auto limit", (await call("credit_wallet", { session: sG, funding_id: "fnd_gbenga_1" })).result === "refused_over_limit");
const hal = await call("check_payment", { session: sH, funding_id: "fnd_halima_1" });
check("provider timeout surfaces as ok=false, never a guessed result", hal.ok === false && hal.error === "payment_provider_unreachable" && !hal.result, hal);

console.log("\nOps Console access");
await seed();
const anon = await getPage("", "/console");
check("console redirects to sign-in when not logged in", anon.status === 303 && anon.location === "/console/login");
const bad = await login("ops-lead", "wrong");
check("wrong password refused", !bad.cookie.startsWith("rw_console=") || bad.location.includes("msg="), bad);
for (let i = 0; i < 5; i++) await login("finance", "wrong");
const locked = await login("finance", "pw-finance");
check("approver locked after 5 wrong passwords, even with the right one", locked.location.includes("Too%20many") || locked.location.includes("Too many"), locked);
await store.del("loginfail:finance");
const ops = (await login("ops-lead", "pw-ops-lead")).cookie;
const fin = (await login("finance", "pw-finance")).cookie;
check("both approvers can sign in", ops.startsWith("rw_console=") && fin.startsWith("rw_console="));

console.log("\nHigh-risk claim, four-eyes, funds already spent (Emeka, ₦50,000)");
const sE = await verify(EMEKA);
const em = await call("open_claim", { session: sE, funding_id: "fnd_emeka_1", rider_statement: "I fund 50k yesterday I no see am, return my money <script>alert(1)</script>" });
check("claim opened, agent only gets a case ref", em.result === "sent_to_review" && /^RW-\d+$/.test(em.case_ref), em);
const alert = (await store.listAll<any>("owner_inbox")).find((n) => n.caseRef === em.case_ref);
check("owner alert carries no code and no action link", alert && !/\b\d{6}\b/.test(alert.body) && !/APPROVE RW|http/.test(alert.body), alert?.body);
const emPage = (await getPage(ops, `/console/case/${em.case_ref}`)).html;
check("console shows HIGH risk, evidence and REJECT recommendation", /HIGH/.test(emPage) && /Funds used since credit/.test(emPage) && /REJECT\./.test(emPage));
check("rider text is escaped in the console (no script injection)", emPage.includes("&lt;script&gt;") && !emPage.includes("<script>alert"));
check("console says two approvers are needed", /two different approvers/.test(emPage));
check("decision without CSRF token refused", (await decide(ops, em.case_ref, "approve", "looks fine", { csrf: "forged" })).status === 403);
check("cross-site decision refused", (await decide(ops, em.case_ref, "approve", "looks fine", { origin: "https://evil.example" })).status === 403);
check("decision without a reason refused", /reason is required/i.test((await decide(ops, em.case_ref, "approve", "")).message));
const a1 = await decide(ops, em.case_ref, "approve", "Testing four-eyes rule");
check("first approval recorded, money does not move yet", /1 of 2/.test(a1.message), a1);
check("same approver cannot approve twice", /already approved/i.test((await decide(ops, em.case_ref, "approve", "again")).message));
const a2 = await decide(fin, em.case_ref, "approve", "Second approval for test");
check("second approval executes, but is BLOCKED because funds were spent", /already used/i.test(a2.message), a2);
check("Emeka's wallet untouched (₦2,000)", (await call("list_recent_fundings", { session: sE })).wallet_balance === "₦2,000");

console.log("\nDuplicate charge, one approval, refund (Funke, ₦8,000)");
const sF = await verify(FUNKE);
const fu = await call("open_claim", { session: sF, funding_id: "fnd_funke_2", rider_statement: "I was charged twice for 8k" });
const fuPage = (await getPage(ops, `/console/case/${fu.case_ref}`)).html;
check("duplicate flagged with APPROVE recommendation", /Possible duplicate/.test(fuPage) && /APPROVE\. Duplicate/.test(fuPage));
check("under ₦50,000: one approval executes", /Refund of ₦8,000 submitted/.test((await decide(ops, fu.case_ref, "approve", "Confirmed duplicate charge")).message));
const fuStatus = await call("case_status", { session: sF, case_ref: fu.case_ref });
check("rider sees the refund outcome via case_status", /refund has been submitted/i.test(fuStatus.status), fuStatus);
check("another rider cannot see the case", (await call("case_status", { session: await verify(ADA), case_ref: fu.case_ref })).found === false);
check("an already-decided claim cannot be decided again", /already decided/i.test((await decide(fin, fu.case_ref, "reject", "late")).message));

console.log("\nCredited but unused, rider wants money back (Bayo)");
const sBy = await verify(BAYO);
const by = await call("open_claim", { session: sBy, funding_id: "fnd_bayo_1", rider_statement: "please refund instead" });
check("refund submitted", /submitted/.test((await decide(fin, by.case_ref, "approve", "Rider prefers refund")).message));
check("wallet credit taken back first (₦6,800 -> ₦3,800)", (await call("list_recent_fundings", { session: sBy })).wallet_balance === "₦3,800");

console.log("\nRefund fails at Paystack: wallet must be restored (Kemi)");
const sK = await verify(KEMI);
const ke = await call("open_claim", { session: sK, funding_id: "fnd_kemi_1", rider_statement: "I'd rather have my 6k back" });
const keRes = await decide(ops, ke.case_ref, "approve", "Rider prefers refund");
check("failure reported honestly", /refused the refund/i.test(keRes.message), keRes);
check("wallet restored to ₦7,500 (no money lost either way)", (await call("list_recent_fundings", { session: sK })).wallet_balance === "₦7,500");

console.log("\nRejection, expiry and audit");
const sGb = await verify(GBENGA);
const g = await call("open_claim", { session: sGb, funding_id: "fnd_gbenga_1", rider_statement: "credit my 150k" });
check("rejection recorded", /rejected/.test((await decide(fin, g.case_ref, "reject", "Asked rider for bank statement first")).message));
check("rider told it was not approved", /not approved/.test((await call("case_status", { session: sGb, case_ref: g.case_ref })).status));
const sIf = await verify(IFE);
const ifc = await call("open_claim", { session: sIf, funding_id: "fnd_ife_1", rider_statement: "I paid 4k" });
const ifCase = (await store.get<any>(`case:${ifc.case_ref}`))!;
ifCase.claim.openedAt = new Date(Date.now() - 25 * 36e5).toISOString();
await store.set(`case:${ifc.case_ref}`, ifCase);
check("claim older than 24h cannot be approved", /expired/i.test((await decide(ops, ifc.case_ref, "approve", "late approval")).message));
const auditHtml = (await getPage(ops, "/console/audit")).html;
check("audit log records who, what and why", /Testing four-eyes rule/.test(auditHtml) && /Asked rider for bank statement first/.test(auditHtml) && /Finance/.test(auditHtml));

console.log("\nConsole pages");
const home = (await getPage(ops, "/console")).html;
check("claims page lists expired claim under needs attention", /Needs attention/.test(home) && home.includes(ifc.case_ref));
const report = (await getPage(ops, "/console/report")).html;
check("daily report renders without phone numbers", /Daily exceptions report/.test(report) && !report.includes("+234"));
check("rider's phone page shows verification SMS", /verification code is/.test((await getPage(ops, "/console/phone")).html));
const so = csrfOf(home);
const out = await fetch(`${base}/console/logout`, { method: "POST", redirect: "manual", headers: { cookie: ops, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: so }) });
check("sign out ends the session", out.status === 303 && (await getPage(ops, "/console")).status === 303);

// ======================================================================
console.log("\nAgent refund authority: parsing the limit set in Chord");
const { parsePolicy } = await import("../src/policy.js");
const pol = (h?: string) => parsePolicy(h);
check('"100,000" means ₦100,000, on', pol("100,000").status === "on" && pol("100,000").limitKobo === 10_000_000);
check('"₦100,000" and "NGN 100000" also work', pol("₦100,000").limitKobo === 10_000_000 && pol("NGN 100000").limitKobo === 10_000_000);
check('"1,000,000" is capped by the server at ₦100,000', pol("1,000,000").limitKobo === 10_000_000 && pol("1,000,000").cappedByServer);
check('"0" and "off" switch agent refunds off', pol("0").limitKobo === 0 && pol("off").status === "off");
check("missing or unreadable header means OFF (fail closed)", pol(undefined).status === "missing" && pol("abc").status === "invalid" && pol("abc").limitKobo === 0);

const clientWith = async (limit?: string) => {
  const cl = new Client({ name: "chord-" + (limit ?? "none"), version: "1.0.0" });
  await cl.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer test-mcp-token", ...(limit !== undefined ? { "X-Railow-Agent-Refund-Limit": limit } : {}) } },
  }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await cl.callTool({ name, arguments: args });
    return { ...JSON.parse(r.content?.[0]?.text ?? "{}") };
  };
};

console.log("\nAgent refunds OFF when Chord sets no limit");
await seed();
const sFu0 = await verify(FUNKE);
const off = await call("refund_payment", { session: sFu0, funding_id: "fnd_funke_2", rider_statement: "charged twice" });
check("no header: request goes to the payments team instead", off.result === "sent_to_review" && /no limit set in Chord/.test(off.why), off);
const offCase = (await store.get<any>(`case:${off.case_ref}`))!;
check("the claim records why the agent did not refund", offCase.claim.flags[0].startsWith("routed_to_review_by_agent"), offCase.claim.flags);

console.log("\nAgent refunds ON with limit \"100,000\" set in Chord");
await seed();
const c100 = await clientWith("100,000");
const sFu = await verify(FUNKE), sBy2 = await verify(BAYO), sEm = await verify(EMEKA), sGb2 = await verify(GBENGA), sKe = await verify(KEMI), sCh = await verify(CHIOMA), sAd = await verify(ADA);
const dup = await c100("refund_payment", { session: sFu, funding_id: "fnd_funke_2", rider_statement: "I was charged twice for 8k" });
check("duplicate ₦8,000 refunded by the agent on its own", dup.result === "refunded" && dup.amount === "₦8,000", dup);
const again = await c100("refund_payment", { session: sFu, funding_id: "fnd_funke_2", rider_statement: "refund again" });
check("the same payment cannot be refunded twice", again.result === "already_refunded", again);
const second = await c100("refund_payment", { session: sFu, funding_id: "fnd_funke_1", rider_statement: "refund the other one too" });
check("a second agent refund for the same rider within 30 days goes to the team", second.result === "sent_to_review" && /already had an agent refund/.test(second.why), second);
const by2 = await c100("refund_payment", { session: sBy2, funding_id: "fnd_bayo_1", rider_statement: "I prefer my money back" });
check("credited-but-unused ₦3,000 refunded, credit taken back first (₦6,800 -> ₦3,800)", by2.result === "refunded" && by2.wallet_balance === "₦3,800", by2);
const em2 = await c100("refund_payment", { session: sEm, funding_id: "fnd_emeka_1", rider_statement: "return my 50k" });
check("₦50,000 within the limit but funds already spent: goes to the team", em2.result === "sent_to_review" && /already used/.test(em2.why), em2);
const gb2 = await c100("refund_payment", { session: sGb2, funding_id: "fnd_gbenga_1", rider_statement: "refund 150k" });
check("₦150,000 above the ₦100,000 limit: goes to the team", gb2.result === "sent_to_review" && /above the agent limit/.test(gb2.why), gb2);
const ch2 = await c100("refund_payment", { session: sCh, funding_id: "fnd_chioma_1", rider_statement: "I was debited" });
check("failed payment (nothing to refund): goes to the team", ch2.result === "sent_to_review" && /no completed payment/.test(ch2.why), ch2);
const ke2 = await c100("refund_payment", { session: sKe, funding_id: "fnd_kemi_1", rider_statement: "I'd rather have my 6k back" });
check("Paystack refuses the refund: reported honestly", ke2.result === "refund_failed", ke2);
check("Kemi's wallet restored to ₦7,500", (await call("list_recent_fundings", { session: sKe })).wallet_balance === "₦7,500");
check("asking again after a failed refund does not retry; it stays with the team", (await c100("refund_payment", { session: sKe, funding_id: "fnd_kemi_1", rider_statement: "try again" })).result === "already_with_team");
const [x1, x2] = await Promise.all([
  c100("refund_payment", { session: sAd, funding_id: "fnd_ada_1", rider_statement: "refund please" }),
  c100("refund_payment", { session: sAd, funding_id: "fnd_ada_1", rider_statement: "refund please" }),
]);
check("two parallel refund requests: exactly one refund", [x1, x2].filter((r) => r.result === "refunded").length === 1, [x1.result, x2.result]);

console.log("\nThe business changes the limit to 0 in Chord");
const c0 = await clientWith("0");
const sBy3 = await verify(DAPO);
const z = await c0("refund_payment", { session: sBy3, funding_id: "fnd_dapo_1", rider_statement: "refund" });
check("limit 0: the agent no longer refunds", z.result === "sent_to_review" && /OFF/.test(z.why), z);

console.log("\nConsole shows the agent's authority and its refunds");
await c100("list_recent_fundings", { session: sFu }); // last call from Chord carries "100,000"
const opsAgain = (await login("ops-lead", "pw-ops-lead")).cookie;
const homeAgain = (await getPage(opsAgain, "/console")).html;
check("banner shows the limit set in Chord", /Agent may refund up to ₦100,000/.test(homeAgain) && /Chord header: &quot;100,000&quot;/.test(homeAgain), homeAgain.match(/class="authority">([^<]+)/)?.[1]);
check("agent refunds listed separately", /Refunded by the agent/.test(homeAgain) && homeAgain.includes(dup.case_ref));
check("audit log attributes refunds to Agent (Chord) with the limit", /Agent \(Chord\)/.test((await getPage(opsAgain, "/console/audit")).html) && /within agent limit ₦100,000 set in Chord/.test((await getPage(opsAgain, "/console/audit")).html));
check("report counts agent refunds", /Refunded by the agent today/.test((await getPage(opsAgain, "/console/report")).html));

console.log("\nOps Console kill switch and lower limit (stricter control wins)");
await seed();
const opsS = (await login("ops-lead", "pw-ops-lead")).cookie;
const saveSettings = async (cookie: string, enabled: string, limit: string, reason: string) => {
  const csrf = csrfOf((await getPage(cookie, "/console/settings")).html);
  const r = await fetch(`${base}/console/settings`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, enabled, limit, reason }) });
  return decodeURIComponent((r.headers.get("location") ?? "").split("msg=")[1] ?? "");
};
check("settings change without a reason refused", /reason is required/i.test(await saveSettings(opsS, "off", "", "")));
check("unreadable lower limit refused", /not an amount/.test(await saveSettings(opsS, "on", "abc", "testing input")));
check("kill switch saved", /OFF/.test(await saveSettings(opsS, "off", "", "Fraud spike on Friday night")));
const c100b = await clientWith("100,000");
const sFuK = await verify(FUNKE);
const killed = await c100b("refund_payment", { session: sFuK, funding_id: "fnd_funke_2", rider_statement: "charged twice" });
check("switched off in the console: refund goes to the team even with Chord at 100,000", killed.result === "sent_to_review" && /switched off in the Ops Console by Ops Lead/.test(killed.why), killed);
await seed();
const opsS2 = (await login("ops-lead", "pw-ops-lead")).cookie;
check("lower limit ₦5,000 saved", /lower limit ₦5,000/.test(await saveSettings(opsS2, "on", "5,000", "Start small this week")));
const sFuL = await verify(FUNKE), sByL = await verify(BAYO);
const low = await c100b("refund_payment", { session: sFuL, funding_id: "fnd_funke_2", rider_statement: "charged twice" });
check("₦8,000 above the console's ₦5,000: goes to the team", low.result === "sent_to_review" && /above the agent limit of ₦5,000/.test(low.why), low);
const okLow = await c100b("refund_payment", { session: sByL, funding_id: "fnd_bayo_1", rider_statement: "refund please" });
check("₦3,000 within ₦5,000: agent refunds it, attributed to the console limit", okLow.result === "refunded", okLow);
check("a higher console limit cannot exceed Chord's", /lower limit ₦500,000/.test(await saveSettings(opsS2, "on", "500,000", "Testing the ceiling")) &&
  /Agent may refund up to ₦100,000 \(limit set in Chord\)/.test((await getPage(opsS2, "/console/settings")).html));
const auditS = (await getPage(opsS2, "/console/audit")).html;
check("settings changes are in the audit log with who and why", /Start small this week/.test(auditS) && /agent refunds: on, lower limit none -&gt; on, lower limit ₦5,000/.test(auditS), auditS.match(/agent refunds:[^<]+/g));
check("audit attributes the refund to the console limit", /within agent limit ₦5,000 set in the Ops Console/.test(auditS));

// ---------- Verify once per chat (conversation id sent by Chord, not the model) ----------
console.log("\nVerification per conversation");
await seed();
const chat = async (conv: string | null) => {
  const cl = new Client({ name: "chat-" + conv, version: "1.0.0" });
  await cl.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer test-mcp-token", ...(conv ? { "X-Chord-Conversation-Id": conv } : {}) } },
  }));
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await cl.callTool({ name, arguments: args });
    return { ...JSON.parse(r.content?.[0]?.text ?? "{}") };
  };
};
const chatA = await chat("conv-A"), chatB = await chat("conv-B"), noConv = await chat(null);
await chatA("start_verification", { phone: ADA });
const vA = await chatA("verify_rider", { phone: ADA, code: codeIn(await lastSms(ADA)) });
check("verified in chat A, marked as verified for the chat", vA.ok === true && vA.chat_verified === true, vA);
const laterTurn = await chatA("list_recent_fundings", {});
check("a later turn in chat A works without the session value", laterTurn.ok === true && Array.isArray(laterTurn.fundings), laterTurn);
const otherChat = await chatB("list_recent_fundings", {});
check("chat B cannot use chat A's verification", otherChat.result === "verification_required" || otherChat.error === "verification_required" || otherChat.ok === false, otherChat);
const noId = await noConv("list_recent_fundings", {});
check("without a conversation id, no session means not verified", noId.ok === false, noId);
const sessionStill = await noConv("list_recent_fundings", { session: vA.session });
check("the session value still works on its own", sessionStill.ok === true, sessionStill);
const lastCall: any = await store.get("mcp:last_call");
check("tool log records where the conversation id came from", lastCall?.conversation_id_found?.startsWith("none") || /header:x-chord-conversation-id/.test(lastCall?.conversation_id_found ?? ""), lastCall?.conversation_id_found);
const convRec: any = await store.get(`conv:${(await import("node:crypto")).createHash("sha256").update("conv:conv-A").digest("hex").slice(0, 32)}`);
check("the chat's verification window slides with activity", convRec && Date.parse(convRec.expiresAt) > Date.now() + 14 * 60_000, convRec);

// ---------- Readable chat reference and receipts (no conversation id from Chord) ----------
console.log("\nChat reference and receipts");
await seed();
await noConv("start_verification", { phone: ADA });
const vRef = await noConv("verify_rider", { phone: ADA, code: codeIn(await lastSms(ADA)) });
check("verification gives a readable ref like V-XXXX-XXXX", /^V-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(vRef.session) && vRef.chat_ref_line === `Verified ✅ (ref ${vRef.session})`, vRef);
const typedLoosely = await noConv("list_recent_fundings", { session: ` ${vRef.session.toLowerCase().replace(/-/g, " ")} ` });
check("the ref works even if copied loosely (case, spaces)", typedLoosely.ok === true, typedLoosely);
const credited = await noConv("credit_wallet", { session: vRef.session, funding_id: "fnd_ada_1" });
check("a credit comes with a receipt line to quote", credited.result === "credited" && /^✅ Railow confirmed: ₦5,000 credited to your wallet\. Balance ₦6,200\. Case RW-\d+\.$/.test(credited.receipt), credited.receipt);
const fake = await noConv("list_recent_fundings", { session: "V-2222-2222" });
check("a made-up ref is refused", fake.ok === false, fake);

const shortNum = await call("start_verification", { phone: "0801000001" });
check("a 10-digit typo is caught as an invalid number, no code sent", shortNum.result === "invalid_number", shortNum);
const rawList = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer test-mcp-token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
check("MCP replies declare charset=utf-8 (so ✅ and ₦ survive)", /charset=utf-8/i.test(rawList.headers.get("content-type") ?? ""), rawList.headers.get("content-type"));

console.log(`\n${passed} passed, ${failed} failed`);
await client.close();
server.close();
process.exit(failed ? 1 : 0);
