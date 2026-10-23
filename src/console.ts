// Railow Ops Console: the CHECKER side of maker-checker.
// Named approvers sign in; they see each claim with its evidence and decide with a written reason.
// Rules (four-eyes, expiry, no double approval) are enforced in domain.ts, not in this page.
//
// Security: password login with lockout, HttpOnly SameSite=Strict session cookie, CSRF token on
// every form, every user-supplied string HTML-escaped. No secrets ever travel in a URL.

import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config, naira } from "./config.js";
import { store } from "./store.js";
import * as d from "./domain.js";
import { combine, describeChord, describePolicy, getConsoleSettings, lastPolicySeen, parseNaira, parsePolicy, saveConsoleSettings } from "./policy.js";

interface ConsoleSession { user: string; csrf: string; expiresAt: string }
interface LoginFails { count: number; until: string | null }
type Authed = Request & { session?: ConsoleSession & { token: string; banner?: string } };

const COOKIE = "rw_console";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const sha = (s: string) => createHash("sha256").update(s).digest();
const samePassword = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
const isHttps = (req: Request) => req.headers["x-forwarded-proto"] === "https" || req.secure;
function setCookie(req: Request, res: Response, value: string, maxAgeSec: number) {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/console; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? "; Secure" : ""}`);
}

async function loadSession(req: Authed) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const s = await store.get<ConsoleSession>(`consolesess:${token}`);
  if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
  return { ...s, token };
}

const requireLogin = async (req: Authed, res: Response, next: NextFunction) => {
  const s = await loadSession(req);
  if (!s) return res.redirect(303, "/console/login");
  const seen = await lastPolicySeen();
  const eff = combine(seen ?? parsePolicy(undefined), await getConsoleSettings());
  req.session = {
    ...s,
    banner: `${describePolicy(eff)} · Chord header: ${seen ? `"${seen.raw ?? "not set"}", last seen ${d.lagosTime(seen.at)}` : "not seen yet since the last reset"}`,
  };
  next();
};

// Forms must carry the session's CSRF token, and cross-site posts are refused outright.
const requireCsrf = (req: Authed, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return res.status(403).send("Cross-site request refused.");
  if (!req.session || req.body?.csrf !== req.session.csrf) return res.status(403).send("Form expired. Go back, reload the page and try again.");
  next();
};

// ---------- page chrome ----------

const css = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#0b6e4f;--warn:#b54708;--bad:#b42318;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a29c;--line:#33322f;--accent:#3fbf8f;--warn:#f0a35e;--bad:#f07a6e;--chip:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-size:16px}nav{display:flex;gap:16px;flex-wrap:wrap}nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--ink)}
.who{margin-left:auto;display:flex;gap:10px;align-items:center;color:var(--muted)}
main{max-width:1000px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:4px 0 16px}h2{font-size:16px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:13px}
.wrap{overflow-x:auto}a{color:var(--accent)}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chip);font-size:12px;white-space:nowrap}
.HIGH{color:var(--bad);font-weight:600}.MEDIUM{color:var(--warn);font-weight:600}.LOW{color:var(--accent);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.k{color:var(--muted);font-size:13px}
.authority{font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:8px 12px;margin-bottom:16px}
.msg{padding:10px 14px;border-radius:8px;background:var(--chip);margin-bottom:16px}
textarea,input,select{width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.approve{background:var(--accent);border-color:var(--accent);color:#fff}button.reject{color:var(--bad);border-color:var(--bad)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}ul{margin:6px 0;padding-left:20px}.muted{color:var(--muted)}
code{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:var(--chip);padding:12px;border-radius:8px;font-size:13px}`;

function page(title: string, body: string, s?: { user: string; csrf: string; banner?: string }, msg?: string) {
  const header = s
    ? `<header><b>${esc(config.brand)} Ops Console</b><nav><a href="/console">Claims</a><a href="/console/settings">Agent refunds</a><a href="/console/report">Daily report</a><a href="/console/audit">Audit log</a><a href="/console/phone">Rider's phone (demo)</a></nav>
       <div class="who">Signed in as <b>${esc(s.user)}</b><form method="post" action="/console/logout"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button>Sign out</button></form></div></header>`
    : `<header><b>${esc(config.brand)} Ops Console</b></header>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(config.brand)} Ops</title><style>${css}</style><body>${header}<main>${s?.banner ? `<div class="authority">${esc(s.banner)}</div>` : ""}${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${body}</main></body></html>`;
}

// "funds_used_since_credit (…)" -> "Funds used since credit (…)"
const humanFlag = (f: string) => {
  const [head, ...rest] = f.split(" (");
  const words = head.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1) + (rest.length ? " (" + rest.join(" (") : "");
};

const statusLabel: Record<d.CaseStatus, string> = {
  open: "Checking", resolved: "Resolved by the agent", awaiting_owner: "Awaiting decision", approved: "Approved",
  rejected: "Rejected", expired: "Expired (escalated)", approval_blocked: "Blocked: needs ops", approval_failed: "Failed: needs ops",
};

// ---------- routes ----------

export const consoleRouter = Router();
consoleRouter.use(express.urlencoded({ extended: false, limit: "20kb" }));
consoleRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Frame-Options", "DENY"); next(); });

consoleRouter.get("/login", (req, res) => {
  const options = config.approvers.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  const body = config.approvers.length
    ? `<div class="card" style="max-width:380px;margin:40px auto"><h1>Sign in</h1>
       <form method="post" action="/console/login"><label class="k">Approver</label><select name="approver">${options}</select>
       <div style="height:10px"></div><label class="k">Password</label><input type="password" name="password" autocomplete="current-password" required>
       <div class="row"><button class="approve">Sign in</button></div></form></div>`
    : `<div class="card"><h1>No approvers configured</h1><p>Set <code>APPROVER_OPS_LEAD_PASSWORD</code> and <code>APPROVER_FINANCE_PASSWORD</code> in the server's environment, then redeploy.</p></div>`;
  res.send(page("Sign in", body, undefined, typeof req.query.msg === "string" ? req.query.msg : undefined));
});

consoleRouter.post("/login", async (req, res) => {
  const approver = config.approvers.find((a) => a.id === req.body?.approver);
  const failKey = `loginfail:${String(req.body?.approver ?? "")}`;
  const fails = (await store.get<LoginFails>(failKey)) ?? { count: 0, until: null };
  if (fails.until && Date.parse(fails.until) > Date.now()) {
    return res.redirect(303, "/console/login?msg=" + encodeURIComponent("Too many failed attempts. Try again in 15 minutes."));
  }
  if (!approver || !samePassword(String(req.body?.password ?? ""), approver.password)) {
    const count = fails.count + 1;
    await store.set<LoginFails>(failKey, { count: count >= 5 ? 0 : count, until: count >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null });
    return res.redirect(303, "/console/login?msg=" + encodeURIComponent("Wrong approver or password."));
  }
  await store.del(failKey);
  const token = randomBytes(24).toString("base64url");
  await store.set<ConsoleSession>(`consolesess:${token}`, {
    user: approver.name, csrf: randomBytes(16).toString("base64url"),
    expiresAt: new Date(Date.now() + config.consoleSessionHours * 36e5).toISOString(),
  });
  setCookie(req, res, token, config.consoleSessionHours * 3600);
  res.redirect(303, "/console");
});

consoleRouter.post("/logout", requireLogin, requireCsrf, async (req: Authed, res) => {
  await store.del(`consolesess:${req.session!.token}`);
  setCookie(req, res, "", 0);
  res.redirect(303, "/console/login");
});

consoleRouter.get("/", requireLogin, async (req: Authed, res) => {
  const cases = await d.allCases();
  const claims = cases.filter((c) => c.claim);
  const row = async (c: d.Case) => {
    const f = await store.get<d.Funding>(`funding:${c.fundingId}`);
    const cu = await store.get<d.Customer>(`customer:${c.customerId}`);
    const approvals = c.claim ? `${(c.claim.approvals ?? []).length} of ${c.claim.requiredApprovals}` : "";
    return `<tr><td><a href="/console/case/${esc(c.ref)}">${esc(c.ref)}</a></td><td>${esc(cu?.name)}</td><td>${esc(naira(f?.amountKobo ?? 0))}</td>
      <td class="${esc(c.claim?.riskLevel)}">${esc(c.claim?.riskLevel)}</td><td><span class="chip">${esc(statusLabel[c.status])}</span></td>
      <td>${c.status === "awaiting_owner" ? esc(approvals) : esc(c.claim?.decision?.by ?? "")}</td><td class="muted">${esc(d.lagosTime(c.updatedAt))}</td></tr>`;
  };
  const table = async (list: d.Case[], empty: string) => list.length
    ? `<div class="wrap"><table><tr><th>Case</th><th>Rider</th><th>Amount</th><th>Risk</th><th>Status</th><th>Approvals / decided by</th><th>Updated</th></tr>${(await Promise.all(list.map(row))).join("")}</table></div>`
    : `<p class="muted">${esc(empty)}</p>`;
  const pending = claims.filter((c) => c.status === "awaiting_owner");
  const attention = claims.filter((c) => ["expired", "approval_blocked", "approval_failed"].includes(c.status));
  const byAgent = claims.filter((c) => c.claim?.decision?.by === d.AGENT && c.status === "approved").slice(0, 20);
  const decided = claims.filter((c) => ["approved", "rejected"].includes(c.status) && c.claim?.decision?.by !== d.AGENT).slice(0, 20);
  const body = `<h1>Claims</h1>
    <div class="card"><h2 style="margin-top:0">Awaiting decision (${pending.length})</h2>${await table(pending, "Nothing waiting. The agent resolves most cases on its own.")}</div>
    <div class="card"><h2 style="margin-top:0">Needs attention (${attention.length})</h2>${await table(attention, "Nothing needs attention.")}</div>
    <div class="card"><h2 style="margin-top:0">Refunded by the agent</h2>${await table(byAgent, "No agent refunds yet.")}</div>
    <div class="card"><h2 style="margin-top:0">Decided by the team</h2>${await table(decided, "No decisions yet.")}</div>
    <p class="muted">Claims of ${esc(naira(config.fourEyesKobo))} and above need two different approvers. Undecided claims expire after ${config.claimTtlHours} hours.</p>`;
  res.send(page("Claims", body, req.session, typeof req.query.msg === "string" ? req.query.msg : undefined));
});

consoleRouter.get("/case/:ref", requireLogin, async (req: Authed, res) => {
  const det = await d.caseDetail(String(req.params.ref));
  if (!det) return res.status(404).send(page("Not found", `<h1>No case ${esc(req.params.ref)}</h1>`, req.session));
  const { c, funding, customer, balance, ledger } = det;
  const cl = c.claim;
  const iApproved = (cl?.approvals ?? []).some((a) => a.user === req.session!.user);
  const ageDays = customer ? Math.floor((Date.now() - Date.parse(customer.createdAt)) / 864e5) : 0;

  const decide = c.status === "awaiting_owner" && cl
    ? `<div class="card"><h2 style="margin-top:0">Decision</h2>
       <p>${cl.requiredApprovals === 2 ? `This claim is ${esc(naira(funding?.amountKobo ?? 0))}, so it needs <b>two different approvers</b>. Approvals so far: <b>${(cl.approvals ?? []).length} of 2</b>.` : "One approval executes this claim."}</p>
       ${iApproved ? `<p class="muted">You have already approved. A different approver must give the second approval.</p>` : ""}
       <form method="post" action="/console/case/${esc(c.ref)}/decide"><input type="hidden" name="csrf" value="${esc(req.session!.csrf)}">
       <label class="k">Reason (required, recorded in the audit log)</label><textarea name="reason" rows="3" required minlength="5"></textarea>
       <div class="row">${iApproved ? "" : `<button class="approve" name="decision" value="approve">Approve</button>`}<button class="reject" name="decision" value="reject">Reject</button></div></form></div>`
    : "";

  const body = `<p><a href="/console">← Claims</a></p><h1>${esc(c.ref)} <span class="chip">${esc(statusLabel[c.status])}</span></h1>
    ${cl ? `<div class="card"><div class="grid">
      <div><div class="k">Risk</div><div class="${esc(cl.riskLevel)}">${esc(cl.riskLevel)}</div></div>
      <div><div class="k">Amount</div>${esc(naira(funding?.amountKobo ?? 0))}</div>
      <div><div class="k">Payment provider says</div>${esc(cl.providerStatus)}</div>
      <div><div class="k">${cl.decision ? "Decided by" : "Approvals"}</div>${cl.decision ? `${esc(cl.decision.by)}: ${esc(cl.decision.action)}` : `${(cl.approvals ?? []).length} of ${cl.requiredApprovals ?? 1}`}</div></div>
      ${cl.decision ? `<p class="muted">Reason: ${esc(cl.decision.reason)}</p>` : ""}
      <h2>Rider says</h2><p>"${esc(cl.statement)}"</p>
      <h2>Evidence (computed by the server)</h2><ul>${(cl.flags ?? []).length ? (cl.flags ?? []).map((f) => `<li>${esc(humanFlag(f))}</li>`).join("") : "<li>No risk flags</li>"}</ul>
      <h2>Recommendation</h2><p>${esc(cl.recommendation)}</p></div>` : `<div class="card"><p class="muted">No claim on this case; the agent handled it.</p></div>`}
    ${decide}
    <div class="card"><h2 style="margin-top:0">Rider and payment</h2><div class="grid">
      <div><div class="k">Rider</div>${esc(customer?.name)} · account ${ageDays} days old</div>
      <div><div class="k">Phone</div>${esc(customer?.phone)}</div>
      <div><div class="k">Wallet balance</div>${esc(naira(balance))}</div>
      <div><div class="k">Paystack reference</div><code>${esc(funding?.reference)}</code></div>
      <div><div class="k">Funding started</div>${esc(d.lagosTime(funding?.createdAt ?? null))}</div>
      <div><div class="k">Wallet credited</div>${esc(d.lagosTime(funding?.creditedAt ?? null) ?? "No")}</div>
      <div><div class="k">Refund</div>${funding?.refund ? esc(`${funding.refund.id} at ${d.lagosTime(funding.refund.at)}`) : "None"}</div></div>
      <h2>Wallet ledger</h2>${ledger.length ? `<div class="wrap"><table><tr><th>When</th><th>Type</th><th>Amount</th><th>Note</th></tr>${ledger.slice(-10).reverse().map((e) => `<tr><td class="muted">${esc(d.lagosTime(e.at))}</td><td>${esc(e.type)}</td><td>${esc(naira(e.amountKobo))}</td><td>${esc(e.note)}</td></tr>`).join("")}</table></div>` : `<p class="muted">No entries.</p>`}</div>
    <div class="card"><h2 style="margin-top:0">Timeline</h2><ul>${(c.events ?? []).slice().reverse().map((e) => `<li><span class="muted">${esc(d.lagosTime(e.at))}</span> ${esc(e.what)}</li>`).join("")}</ul></div>`;
  res.send(page(c.ref, body, req.session, typeof req.query.msg === "string" ? req.query.msg : undefined));
});

consoleRouter.post("/case/:ref/decide", requireLogin, requireCsrf, async (req: Authed, res) => {
  const ref = String(req.params.ref);
  const r = await d.decideCase(ref, req.session!.user, String(req.body?.decision ?? ""), String(req.body?.reason ?? ""));
  res.redirect(303, `/console/case/${encodeURIComponent(ref)}?msg=${encodeURIComponent(r.message)}`);
});

// Agent refund settings: the ops team's kill switch and optional lower limit. Chord's header stays
// the ceiling; whichever is stricter applies. Every change needs a reason and is audit-logged.
consoleRouter.get("/settings", requireLogin, async (req: Authed, res) => {
  const cs = await getConsoleSettings();
  const seen = await lastPolicySeen();
  const chord = seen ?? parsePolicy(undefined);
  const eff = combine(chord, cs);
  const body = `<h1>Agent refunds</h1>
    <div class="card"><div class="grid">
      <div><div class="k">Right now</div><b>${esc(describePolicy(eff))}</b></div>
      <div><div class="k">Ceiling set in Chord</div>${esc(describeChord(chord))}${seen ? `<div class="muted">header "${esc(seen.raw ?? "not set")}", last seen ${esc(d.lagosTime(seen.at))}</div>` : `<div class="muted">not seen since the last reset</div>`}</div>
      <div><div class="k">Last changed here</div>${cs.updatedBy ? `${esc(cs.updatedBy)}, ${esc(d.lagosTime(cs.updatedAt))}` : "Never (default: on, Chord's limit applies)"}</div></div></div>
    <div class="card"><h2 style="margin-top:0">Change</h2>
      <p class="muted">The business owner sets the ceiling in Chord. Here the payments team can switch agent refunds off instantly, or set a lower limit. Whichever is stricter applies, from the agent's next message.</p>
      <form method="post" action="/console/settings"><input type="hidden" name="csrf" value="${esc(req.session!.csrf)}">
        <label class="k">Agent refunds</label>
        <select name="enabled"><option value="on"${cs.enabled ? " selected" : ""}>On (within the limit)</option><option value="off"${cs.enabled ? "" : " selected"}>Off: send every refund to the team</option></select>
        <div style="height:10px"></div>
        <label class="k">Lower limit, ₦ (optional; leave blank to use Chord's limit)</label>
        <input name="limit" inputmode="numeric" placeholder="e.g. 50,000" value="${cs.limitKobo !== null ? esc((cs.limitKobo / 100).toLocaleString("en-NG")) : ""}">
        <div style="height:10px"></div>
        <label class="k">Reason (required, recorded in the audit log)</label><textarea name="reason" rows="2" required minlength="5"></textarea>
        <div class="row"><button class="approve">Save</button></div></form></div>`;
  res.send(page("Agent refunds", body, req.session, typeof req.query.msg === "string" ? req.query.msg : undefined));
});

consoleRouter.post("/settings", requireLogin, requireCsrf, async (req: Authed, res) => {
  const back = (msg: string) => res.redirect(303, "/console/settings?msg=" + encodeURIComponent(msg));
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  if (reason.length < 5) return back("A reason is required (at least 5 characters).");
  const enabled = req.body?.enabled !== "off";
  const rawLimit = String(req.body?.limit ?? "").trim();
  let limitKobo: number | null = null;
  if (rawLimit !== "") {
    const k = parseNaira(rawLimit);
    if (k === null) return back(`"${rawLimit}" is not an amount. Use a number like 50,000, or leave it blank.`);
    limitKobo = k;
  }
  const before = await getConsoleSettings();
  const after = { enabled, limitKobo, updatedBy: req.session!.user, updatedAt: new Date().toISOString() };
  await saveConsoleSettings(after);
  const fmt = (x: { enabled: boolean; limitKobo: number | null }) => `${x.enabled ? "on" : "OFF"}, lower limit ${x.limitKobo === null ? "none" : naira(x.limitKobo)}`;
  await d.auditSettingsChange(req.session!.user, `agent refunds: ${fmt(before)} -> ${fmt(after)}`, reason);
  back(`Saved. Agent refunds ${fmt(after)}.`);
});

consoleRouter.get("/report", requireLogin, async (req: Authed, res) => {
  const r = await d.exceptionsReport();
  const list = (items: { case_ref: string }[], fmt: (x: any) => string) => items.length ? `<ul>${items.map((x) => `<li><a href="/console/case/${esc(x.case_ref)}">${esc(x.case_ref)}</a> ${esc(fmt(x))}</li>`).join("")}</ul>` : `<p class="muted">None</p>`;
  const body = `<h1>Daily exceptions report · ${esc(r.date)}</h1>
    <div class="card"><div class="grid">
      <div><div class="k">Cases today</div><b>${r.cases_today}</b></div>
      <div><div class="k">Wallets credited by the agent</div><b>${r.auto_resolved.wallets_credited}</b></div>
      <div><div class="k">Explained, no action needed</div><b>${r.auto_resolved.explained_no_action_needed}</b></div>
      <div><div class="k">Refunded by the agent today</div><b>${r.agent_refunds_today.count} · ${esc(r.agent_refunds_today.total)}</b></div>
      <div><div class="k">Team approved / rejected today</div><b>${r.decisions_today.approved} / ${r.decisions_today.rejected}</b></div>
      <div><div class="k">Provider errors today</div><b>${r.provider_errors_today}</b></div></div></div>
    <div class="card"><h2 style="margin-top:0">Awaiting decision</h2>${list(r.awaiting_decision, (x) => `${x.amount}, ${x.risk} risk, ${x.approvals} approvals, waiting ${x.waiting_hours}h`)}</div>
    <div class="card"><h2 style="margin-top:0">Needs ops attention</h2>${list(r.needs_ops_attention, (x) => `${x.amount}: ${x.reason}`)}
      ${r.expired_escalated.length ? `<p>Expired and escalated: ${r.expired_escalated.map((x) => `<a href="/console/case/${esc(x)}">${esc(x)}</a>`).join(", ")}</p>` : ""}</div>`;
  res.send(page("Daily report", body, req.session));
});

consoleRouter.get("/audit", requireLogin, async (req: Authed, res) => {
  const log = await d.auditLog();
  const body = `<h1>Audit log</h1><div class="card">${log.length ? `<div class="wrap"><table><tr><th>When</th><th>Who</th><th>Case</th><th>Action</th><th>Reason</th></tr>
    ${log.map((e) => `<tr><td class="muted">${esc(d.lagosTime(e.at))}</td><td>${esc(e.user)}</td><td>${e.ref.startsWith("RW-") ? `<a href="/console/case/${esc(e.ref)}">${esc(e.ref)}</a>` : `<a href="/console/settings">Settings</a>`}</td><td>${esc(e.action)}</td><td>${esc(e.reason)}</td></tr>`).join("")}</table></div>` : `<p class="muted">No decisions yet.</p>`}</div>`;
  res.send(page("Audit log", body, req.session));
});

// Demo only: stands in for the riders' real phones, so verification codes can be shown on camera.
consoleRouter.get("/phone", requireLogin, async (req: Authed, res) => {
  const sms = await d.smsOutbox();
  const body = `<h1>Rider's phone <span class="chip">demo SMS gateway</span></h1>
    <p class="muted">In production these messages go by SMS or a WhatsApp authentication template to the phone registered on the rider's account. Newest first.</p>
    <div class="card">${sms.length ? `<div class="wrap"><table><tr><th>When</th><th>To</th><th>Message</th></tr>${sms.slice(0, 30).map((m) => `<tr><td class="muted">${esc(d.lagosTime(m.at))}</td><td>${esc(m.to)}</td><td>${esc(m.text)}</td></tr>`).join("")}</table></div>` : `<p class="muted">No messages yet.</p>`}</div>`;
  res.send(page("Rider's phone", body, req.session));
});
