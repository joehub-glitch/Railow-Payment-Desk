// The business rules. Every money decision is made here, in code, never by the AI.
// The agent chooses WHICH function to call; these functions decide WHETHER money moves.
//
// Rules of the desk:
//  1. Nothing about an account is revealed until the rider proves they hold the registered phone
//     (a one-time code the server sends to that phone; the agent never sees it).
//  2. The desk may put money where it was already paid (credit a wallet for a confirmed payment).
//  3. Money goes out on the agent's own decision only within the refund authority the business set
//     in Chord, and only for low-risk, verified cases. Everything else is a claim (maker) that a
//     named person approves in the Ops Console (checker). ₦50,000 and above needs two approvers.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config, naira } from "./config.js";
import { store } from "./store.js";
import { verifyPayment, refundPayment, type VerifyResult } from "./paystack.js";
import { notifyOwner } from "./notify.js";
import { describePolicy, type AgentPolicy } from "./policy.js";
import { conversationKey } from "./conversation.js";

// ---------- types ----------

export interface Customer { id: string; phone: string; name: string; createdAt: string }
export interface Funding {
  id: string; customerId: string; reference: string; amountKobo: number; createdAt: string;
  creditedAt: string | null; refund: { id: string; at: string } | null;
}
export interface LedgerEntry { type: "credit" | "ride" | "reversal" | "reversal_undo"; amountKobo: number; at: string; fundingId?: string; note: string }
export type CaseStatus =
  | "open" | "resolved" | "awaiting_owner" | "approved" | "rejected" | "expired" | "approval_blocked" | "approval_failed";
export interface CaseEvent { at: string; what: string }
export interface Approval { user: string; at: string; reason: string }
export interface Claim {
  statement: string; openedAt: string; riskLevel: "LOW" | "MEDIUM" | "HIGH"; flags: string[];
  recommendation: string; providerStatus: string; requiredApprovals: number; approvals: Approval[];
  decision: { by: string; at: string; action: "approved" | "rejected"; reason: string } | null;
}
export interface Case {
  ref: string; customerId: string; fundingId: string; createdAt: string; updatedAt: string;
  status: CaseStatus; outcome: string; claim: Claim | null; events: CaseEvent[];
}
export interface AuditEntry { at: string; user: string; ref: string; action: string; reason: string }
interface OtpRecord { hash: string; expiresAt: string; attempts: number }
interface RiderSession { customerId: string; expiresAt: string }
export interface SmsMessage { at: string; to: string; text: string }

export type Classification =
  | "paid_not_credited" | "paid_and_credited" | "failed" | "abandoned" | "pending"
  | "reversed" | "amount_mismatch" | "not_found";

// ---------- helpers ----------

const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const hoursSince = (iso: string) => (Date.now() - Date.parse(iso)) / 36e5;
export const lagosTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;

export function normalizePhone(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1);
  if (d.length === 10 && !d.startsWith("234")) d = "234" + d;
  return "+" + d;
}
const lastDigits = (phone: string) => phone.replace(/\D/g, "").slice(-4);

async function customerByPhone(phone: string) {
  const id = await store.get<string>(`phone:${normalizePhone(phone)}`);
  return id ? store.get<Customer>(`customer:${id}`) : null;
}
const balance = async (customerId: string) => (await store.get<number>(`wallet:${customerId}`)) ?? 0;
const ledger = (customerId: string) => store.listAll<LedgerEntry>(`ledger:${customerId}`);

async function fundingsOf(customerId: string) {
  const ids = (await store.get<string[]>(`fundings:${customerId}`)) ?? [];
  const list = (await Promise.all(ids.map((id) => store.get<Funding>(`funding:${id}`)))).filter(Boolean) as Funding[];
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function addEvent(c: Case, what: string) {
  c.events.push({ at: now(), what });
  c.updatedAt = now();
  await store.set(`case:${c.ref}`, c);
}

async function ensureCase(customer: Customer, funding: Funding): Promise<Case> {
  const existing = await store.get<string>(`casebyfunding:${funding.id}`);
  if (existing) { const c = await store.get<Case>(`case:${existing}`); if (c) return c; }
  const n = await store.incr("case_seq");
  const ref = `RW-${String(1000 + n)}`;
  const c: Case = { ref, customerId: customer.id, fundingId: funding.id, createdAt: now(), updatedAt: now(), status: "open", outcome: "", claim: null, events: [] };
  await store.set(`case:${ref}`, c);
  await store.set(`casebyfunding:${funding.id}`, ref);
  await store.listPush("case_refs", ref);
  return c;
}

function classify(funding: Funding, v: Extract<VerifyResult, { ok: true }>): Classification {
  if (v.status === "success") {
    if (v.amountKobo !== funding.amountKobo) return "amount_mismatch";
    return funding.creditedAt ? "paid_and_credited" : "paid_not_credited";
  }
  return v.status; // failed | abandoned | pending | reversed | not_found
}

const providerDown = (v: Extract<VerifyResult, { ok: false }>) => ({
  ok: false as const,
  error: "payment_provider_unreachable",
  detail: v.detail,
  guidance: "Could not reach the payment provider. Do not guess the outcome. Tell the rider you could not check right now and to try again shortly; quote the case reference.",
});

// ---------- evidence (shared by claims and agent refunds) ----------

async function computeEvidence(customer: Customer, funding: Funding, v: VerifyResult) {
  const providerStatus = v.ok ? v.status : `unreachable(${v.error})`;
  const bal = await balance(customer.id);
  const entries = await ledger(customer.id);
  const flags: string[] = [];

  const credited = Boolean(funding.creditedAt);
  if (credited) flags.push(`wallet_already_credited (${lagosTime(funding.creditedAt)})`);
  const spentSince = credited
    ? entries.filter((e) => e.type === "ride" && Date.parse(e.at) > Date.parse(funding.creditedAt!)).reduce((s, e) => s + e.amountKobo, 0)
    : 0;
  const fundsUsed = credited && bal < funding.amountKobo;
  if (fundsUsed) flags.push(`funds_used_since_credit (${naira(spentSince)} spent on rides; balance now ${naira(bal)})`);
  if (!(v.ok && v.status === "success")) flags.push(`payment_not_confirmed_by_provider (${providerStatus})`);
  if (v.ok && v.status === "success" && v.amountKobo !== funding.amountKobo) flags.push(`amount_mismatch (provider ${naira(v.amountKobo)} vs expected ${naira(funding.amountKobo)})`);

  const others = (await fundingsOf(customer.id)).filter(
    (f) => f.id !== funding.id && f.amountKobo === funding.amountKobo &&
      Math.abs(Date.parse(f.createdAt) - Date.parse(funding.createdAt)) <= config.duplicateWindowMinutes * 60_000,
  );
  const possibleDuplicate = others.length > 0;
  if (possibleDuplicate) flags.push(`possible_duplicate (another ${naira(funding.amountKobo)} funding within ${config.duplicateWindowMinutes} min)`);

  const priorClaims = ((await store.get<string[]>(`claims:${customer.id}`)) ?? []).filter(
    (iso) => Date.parse(iso) > Date.now() - config.repeatClaimWindowDays * 864e5,
  ).length;
  if (priorClaims > 0) flags.push(`prior_claims_last_${config.repeatClaimWindowDays}d (${priorClaims})`);

  const ageDays = (Date.now() - Date.parse(customer.createdAt)) / 864e5;
  const newAccount = ageDays < config.newAccountDays;
  if (newAccount) flags.push(`new_account (${Math.floor(ageDays)} days old)`);
  if (funding.amountKobo > config.autoCreditLimitKobo) flags.push(`above_auto_limit (${naira(funding.amountKobo)})`);

  const riskLevel: Claim["riskLevel"] =
    fundsUsed || priorClaims >= 2 || (newAccount && !(v.ok && v.status === "success")) ? "HIGH" : flags.length > 0 ? "MEDIUM" : "LOW";

  let recommendation: string;
  if (fundsUsed) recommendation = "REJECT. Wallet was credited and the funds have been used. A refund would pay this rider twice.";
  else if (!(v.ok && v.status === "success")) recommendation = "No completed payment at the provider, so there is nothing to refund from Railow. If the rider's bank shows a debit, it is a bank-side reversal: APPROVE only to log it for a bank dispute.";
  else if (possibleDuplicate && !credited) recommendation = "APPROVE. Duplicate payment that was never credited; refunding it is safe.";
  else if (credited) recommendation = "Wallet was credited and funds are untouched. APPROVE only if the rider genuinely wants a refund instead of the credit; the wallet will be debited first.";
  else recommendation = "Payment confirmed but never credited. Either credit the wallet (default) or APPROVE a refund if the rider prefers their money back.";

  return { flags, riskLevel, recommendation, providerStatus, fundsUsed, possibleDuplicate, credited, ageDays };
}

// ---------- 1. rider verification ----------

const VERIFY_AGAIN = {
  ok: false as const,
  error: "verification_required",
  guidance: "The rider is not verified (or the session expired). Call start_verification with the phone number on their Railow account, then verify_rider with the code they receive.",
};

/** Sends a one-time code to the phone REGISTERED on the account. Always answers the same way, so
 *  the chat cannot be used to discover who has an account. The code is never returned. */
export async function startVerification(phoneRaw: string) {
  const phone = normalizePhone(phoneRaw);
  const generic = {
    ok: true,
    result: "code_sent_if_account_exists",
    sent_to: `the phone number ending ${lastDigits(phone)}`,
    guidance: "Tell the rider: if that number has a Railow account, a 6-digit code has just been sent to it by SMS; ask them to type it here. Never ask for card details, PINs or passwords.",
  };

  // Rate limit per phone number, whether or not the account exists (so limits reveal nothing).
  const windowStart = Date.now() - 15 * 60_000;
  const sends = ((await store.get<string[]>(`otpsends:${phone}`)) ?? []).filter((iso) => Date.parse(iso) > windowStart);
  if (sends.length >= config.otpMaxSendsPerWindow) {
    return { ok: false, result: "too_many_requests", guidance: "Too many codes requested for this number. Ask the rider to wait 15 minutes and try again." };
  }
  await store.set(`otpsends:${phone}`, [...sends, now()]);

  const customer = await customerByPhone(phone);
  if (customer) {
    const code = String(randomInt(100000, 1000000));
    await store.set<OtpRecord>(`otp:${customer.id}`, {
      hash: sha(`${customer.id}:${code}`),
      expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString(),
      attempts: 0,
    });
    // Demo SMS gateway: the message lands in the "Rider's phone" page of the Ops Console.
    // In production this is an SMS / WhatsApp authentication template to customer.phone.
    await store.listPush<SmsMessage>(`sms:${customer.phone}`, {
      at: now(), to: customer.phone,
      text: `${config.brand}: your verification code is ${code}. It expires in ${config.otpTtlMinutes} minutes. Never share it with anyone, including ${config.brand} staff.`,
    });
  }
  return generic;
}

/** Checks the code the rider typed. On success returns a short-lived session for the other tools. */
export async function verifyRider(phoneRaw: string, codeRaw: string) {
  const fail = (guidance: string) => ({ ok: false as const, result: "not_verified", guidance });
  const customer = await customerByPhone(phoneRaw);
  const code = String(codeRaw ?? "").replace(/\D/g, "");
  if (!customer) return fail("Code not accepted. Ask the rider to check the number and request a new code.");
  const rec = await store.get<OtpRecord>(`otp:${customer.id}`);
  if (!rec) return fail("Code not accepted or expired. Call start_verification to send a new code.");
  if (rec.attempts >= config.otpMaxAttempts) return fail("Too many wrong codes. Ask the rider to request a new code in 15 minutes.");
  if (Date.parse(rec.expiresAt) < Date.now()) { await store.del(`otp:${customer.id}`); return fail("The code has expired. Call start_verification to send a new one."); }
  if (!sameHash(sha(`${customer.id}:${code}`), rec.hash)) {
    rec.attempts += 1;
    await store.set(`otp:${customer.id}`, rec);
    return fail(rec.attempts >= config.otpMaxAttempts ? "Code not accepted. Too many attempts: the rider must request a new code later." : "Code not accepted. Ask the rider to check the SMS and type the 6 digits again.");
  }
  await store.del(`otp:${customer.id}`); // a code works once
  const session = randomBytes(9).toString("base64url"); // 12 characters
  const rec2: RiderSession = { customerId: customer.id, expiresAt: expiry() };
  await store.set<RiderSession>(`session:${session}`, rec2);
  const conv = conversationKey();
  if (conv) await store.set<RiderSession>(`conv:${conv}`, rec2); // verified for this chat
  return {
    ok: true,
    result: "verified",
    session,
    chat_verified: Boolean(conv),
    name: customer.name.split(" ")[0],
    wallet_balance: naira(await balance(customer.id)),
    guidance: conv
      ? `Verified for this chat (until ${config.sessionTtlMinutes} minutes pass with no activity). Pass the session value when you have it; if you no longer have it, call the tools without it and the server will recognise this chat. Do not show it to the rider.`
      : `Verified for ${config.sessionTtlMinutes} minutes of activity. Pass this exact session value to every other tool. Do not show it to the rider.`,
  };
}

const expiry = () => new Date(Date.now() + config.sessionTtlMinutes * 60_000).toISOString();

/** The verified rider for this call: from the session value, else from this chat's verification.
 *  Each successful use extends the window (15 minutes of inactivity ends it). */
async function riderFromSession(session?: string) {
  const keys = [session ? `session:${String(session).trim()}` : null, conversationKey() ? `conv:${conversationKey()}` : null]
    .filter((k): k is string => Boolean(k));
  for (const k of keys) {
    const s = await store.get<RiderSession>(k);
    if (!s || Date.parse(s.expiresAt) < Date.now()) continue;
    await store.set<RiderSession>(k, { ...s, expiresAt: expiry() });
    return store.get<Customer>(`customer:${s.customerId}`);
  }
  return null;
}

// A verified rider can only ever see or act on their own fundings, even if they quote another id.
async function ownedFunding(session: string | undefined, fundingId: string) {
  const c = await riderFromSession(session);
  if (!c) return { error: VERIFY_AGAIN };
  const f = await store.get<Funding>(`funding:${fundingId}`);
  if (!f || f.customerId !== c.id) return { error: { ok: false as const, error: "funding_not_found_for_this_rider" } };
  return { customer: c, funding: f };
}

// ---------- 2. rider tools (all require a verified session) ----------

export async function listRecentFundings(session: string | undefined, limit = 5) {
  const c = await riderFromSession(session);
  if (!c) return VERIFY_AGAIN;
  const list = (await fundingsOf(c.id)).slice(0, Math.max(1, Math.min(limit, 10)));
  return {
    ok: true,
    wallet_balance: naira(await balance(c.id)),
    fundings: list.map((f) => ({
      funding_id: f.id,
      amount: naira(f.amountKobo),
      started_at: lagosTime(f.createdAt),
      wallet_credited: Boolean(f.creditedAt),
    })),
  };
}

export async function checkPayment(session: string | undefined, fundingId: string) {
  const o = await ownedFunding(session, fundingId);
  if ("error" in o) return o.error;
  const { customer, funding } = o;
  const c = await ensureCase(customer, funding);
  const v = await verifyPayment(funding.reference);
  if (!v.ok) { await addEvent(c, `check_payment: provider unreachable (${v.error})`); return { ...providerDown(v), case_ref: c.ref }; }

  const result = classify(funding, v);
  await addEvent(c, `check_payment: ${result} (provider=${v.status})`);
  if (["failed", "abandoned", "reversed", "paid_and_credited"].includes(result) && c.status === "open") {
    c.status = "resolved"; c.outcome = `explained:${result}`; await store.set(`case:${c.ref}`, c);
  }
  return {
    ok: true,
    case_ref: c.ref,
    result,
    amount_expected: naira(funding.amountKobo),
    amount_received_by_provider: v.status === "success" ? naira(v.amountKobo) : null,
    payment_channel: v.channel,
    paid_at: lagosTime(v.paidAt),
    wallet_credited_at: lagosTime(funding.creditedAt),
    wallet_balance: naira(await balance(customer.id)),
  };
}

export async function creditWallet(session: string | undefined, fundingId: string) {
  const o = await ownedFunding(session, fundingId);
  if ("error" in o) return o.error;
  const { customer, funding } = o;
  const c = await ensureCase(customer, funding);

  if (funding.creditedAt) {
    return { ok: true, result: "already_credited", case_ref: c.ref, credited_at: lagosTime(funding.creditedAt), wallet_balance: naira(await balance(customer.id)) };
  }
  if (funding.amountKobo > config.autoCreditLimitKobo) {
    await addEvent(c, "credit_wallet: refused over auto limit");
    return { ok: false, result: "refused_over_limit", case_ref: c.ref, guidance: `Above the ${naira(config.autoCreditLimitKobo)} automatic limit. Call open_claim so the payments team reviews it.` };
  }

  // Never trust an earlier check: verify again at the moment money moves.
  const v = await verifyPayment(funding.reference);
  if (!v.ok) { await addEvent(c, `credit_wallet: provider unreachable (${v.error})`); return { ...providerDown(v), case_ref: c.ref }; }
  if (v.status !== "success") {
    await addEvent(c, `credit_wallet: refused, provider status ${v.status}`);
    return { ok: false, result: "refused_payment_not_confirmed", provider_status: v.status, case_ref: c.ref };
  }
  if (v.amountKobo !== funding.amountKobo) {
    await addEvent(c, `credit_wallet: refused, amount mismatch provider=${v.amountKobo} expected=${funding.amountKobo}`);
    return { ok: false, result: "refused_amount_mismatch", case_ref: c.ref, guidance: "Do not credit. Call open_claim." };
  }

  // Atomic once-only guard: two simultaneous requests cannot both pass this line.
  const won = await store.setIfAbsent(`credited:${funding.id}`, now());
  if (!won) {
    const fresh = await store.get<Funding>(`funding:${funding.id}`);
    return { ok: true, result: "already_credited", case_ref: c.ref, credited_at: lagosTime(fresh?.creditedAt ?? now()), wallet_balance: naira(await balance(customer.id)) };
  }

  funding.creditedAt = now();
  await store.set(`funding:${funding.id}`, funding);
  const newBal = (await balance(customer.id)) + funding.amountKobo;
  await store.set(`wallet:${customer.id}`, newBal);
  await store.listPush(`ledger:${customer.id}`, { type: "credit", amountKobo: funding.amountKobo, at: funding.creditedAt, fundingId: funding.id, note: "desk credit after verified payment" } satisfies LedgerEntry);
  c.status = "resolved"; c.outcome = "wallet_credited";
  await addEvent(c, `credit_wallet: credited ${naira(funding.amountKobo)}`);
  return { ok: true, result: "credited", case_ref: c.ref, amount: naira(funding.amountKobo), wallet_balance: naira(newBal) };
}

/** MAKER step: gathers evidence and records a pending request. Never moves money. */
export async function openClaim(session: string | undefined, fundingId: string, statement: string, extraFlag?: string) {
  const o = await ownedFunding(session, fundingId);
  if ("error" in o) return o.error;
  const { customer, funding } = o;
  const c = await ensureCase(customer, funding);
  await expireIfStale(c);

  if (c.status === "awaiting_owner") {
    return { ok: true, result: "already_under_review", case_ref: c.ref, guidance: "Tell the rider this case is already with the payments team." };
  }
  if (c.status === "approved" || c.status === "approval_blocked" || c.status === "approval_failed") {
    return { ok: true, result: "already_decided", case_ref: c.ref, guidance: "This case was already handled by the payments team. Use case_status to tell the rider where it stands." };
  }

  const v = await verifyPayment(funding.reference);
  const ev = await computeEvidence(customer, funding, v);
  if (extraFlag) ev.flags.unshift(extraFlag);
  const { flags, riskLevel, recommendation, providerStatus } = ev;
  const requiredApprovals = funding.amountKobo >= config.fourEyesKobo ? 2 : 1;
  c.claim = { statement: statement.slice(0, 500), openedAt: now(), riskLevel, flags, recommendation, providerStatus, requiredApprovals, approvals: [], decision: null };
  c.status = "awaiting_owner";
  c.outcome = "";
  await addEvent(c, `open_claim: risk ${riskLevel}, needs ${requiredApprovals} approval(s)`);
  const claims = (await store.get<string[]>(`claims:${customer.id}`)) ?? [];
  await store.set(`claims:${customer.id}`, [...claims, now()]);

  // The alert carries no codes and no action links: decisions happen only behind the console login.
  await notifyOwner({
    at: now(),
    caseRef: c.ref,
    subject: `[${config.brand}] ${riskLevel} risk claim ${c.ref}: ${naira(funding.amountKobo)} awaiting review`,
    body: [
      `Case ${c.ref}: ${riskLevel} risk, ${naira(funding.amountKobo)}, needs ${requiredApprovals} approval(s).`,
      `Recommendation: ${recommendation}`,
      ``,
      `Review it in the ${config.brand} Ops Console (sign in, then open ${c.ref}).`,
    ].join("\n"),
  });

  return {
    ok: true,
    result: "sent_to_review",
    case_ref: c.ref,
    guidance: "Tell the rider their case reference and that the payments team will review it. Do not promise a refund or a timeline. Do not mention risk flags or approvals.",
  };
}

/** Agent refund within the authority the business set in Chord. Every check runs here, in code.
 *  If any check fails, the request becomes a normal claim for the Ops Console instead. */
export async function agentRefund(session: string | undefined, fundingId: string, statement: string, policy: AgentPolicy) {
  const o = await ownedFunding(session, fundingId);
  if ("error" in o) return o.error;
  const { customer, funding } = o;
  const c = await ensureCase(customer, funding);
  await expireIfStale(c);
  const toReview = async (why: string) => {
    const r: any = await openClaim(session, fundingId, statement, `routed_to_review_by_agent (${why})`);
    return { ...r, agent_refund: "not_done", why };
  };

  if (c.status === "awaiting_owner") return { ok: true, result: "already_under_review", case_ref: c.ref, guidance: "Tell the rider this case is already with the payments team." };
  if (c.status === "approval_failed" || c.status === "approval_blocked") {
    return { ok: true, result: "already_with_team", case_ref: c.ref, guidance: "This case is already with the payments team after an earlier attempt. Give the rider the case reference; do not promise a timeline." };
  }
  if (funding.refund) return { ok: true, result: "already_refunded", case_ref: c.ref, refunded_at: lagosTime(funding.refund.at), guidance: "Tell the rider this payment was already refunded and when." };
  if (policy.limitKobo <= 0) return toReview(describePolicy(policy));

  const v = await verifyPayment(funding.reference);
  if (!v.ok) { await addEvent(c, `agent_refund: provider unreachable (${v.error})`); return { ...providerDown(v), case_ref: c.ref }; }
  if (v.status !== "success") return toReview(`no completed payment at provider (${v.status})`);
  if (v.amountKobo !== funding.amountKobo) return toReview("amount mismatch");
  if (funding.amountKobo > policy.limitKobo) return toReview(`${naira(funding.amountKobo)} is above the agent limit of ${naira(policy.limitKobo)}`);

  const ev = await computeEvidence(customer, funding, v);
  if (ev.fundsUsed) return toReview("credited funds already used");
  if (ev.riskLevel === "HIGH") return toReview("high risk");
  const recent = ((await store.get<string[]>(`agentrefunds:${customer.id}`)) ?? []).filter((iso) => Date.parse(iso) > Date.now() - config.agentRefundWindowDays * 864e5);
  if (recent.length > 0) return toReview(`rider already had an agent refund in the last ${config.agentRefundWindowDays} days`);

  // Claim the refund atomically so two parallel requests cannot both refund.
  if (!(await store.setIfAbsent(`refunding:${funding.id}`, new Date().toISOString()))) {
    return { ok: true, result: "already_in_progress", case_ref: c.ref, guidance: "A refund for this payment is already being processed. Ask the rider to check back with the case reference." };
  }

  const authority = `within agent limit ${naira(policy.limitKobo)} set in ${policy.decidedBy === "console" ? "the Ops Console" : "Chord"}`;
  c.claim = {
    statement: statement.slice(0, 500), openedAt: new Date().toISOString(), riskLevel: ev.riskLevel, flags: ev.flags,
    recommendation: ev.recommendation, providerStatus: ev.providerStatus, requiredApprovals: 0, approvals: [], decision: null,
  };
  const claims = (await store.get<string[]>(`claims:${customer.id}`)) ?? [];
  await store.set(`claims:${customer.id}`, [...claims, new Date().toISOString()]);

  const bal = await balance(customer.id);
  let debited = false;
  if (funding.creditedAt) {
    // Take the credit back before refunding, so the rider can never hold both.
    await store.set(`wallet:${customer.id}`, bal - funding.amountKobo);
    await store.listPush(`ledger:${customer.id}`, { type: "reversal", amountKobo: funding.amountKobo, at: new Date().toISOString(), fundingId: funding.id, note: `agent refund ${c.ref}` } satisfies LedgerEntry);
    debited = true;
  }

  const r = await refundPayment(funding.reference, funding.amountKobo, `Agent refund ${c.ref} (${authority})`);
  if (!r.ok) {
    if (debited) {
      await store.set(`wallet:${customer.id}`, bal);
      await store.listPush(`ledger:${customer.id}`, { type: "reversal_undo", amountKobo: funding.amountKobo, at: new Date().toISOString(), fundingId: funding.id, note: `refund failed ${c.ref}` } satisfies LedgerEntry);
    }
    await store.del(`refunding:${funding.id}`);
    c.status = "approval_failed"; c.outcome = "refund_call_failed";
    await addEvent(c, `agent refund refused by Paystack (${r.detail}); wallet restored=${debited}`);
    await audit({ user: AGENT, ref: c.ref, action: "refund FAILED at Paystack (agent)", reason: authority });
    return { ok: false, result: "refund_failed", case_ref: c.ref, guidance: "The refund could not be completed and nothing was changed. Tell the rider the payments team will follow up, and give the case reference. Do not promise a timeline." };
  }

  funding.refund = { id: r.refundId, at: new Date().toISOString() };
  await store.set(`funding:${funding.id}`, funding);
  await store.set(`agentrefunds:${customer.id}`, [...recent, new Date().toISOString()]);
  c.claim.decision = { by: AGENT, at: new Date().toISOString(), action: "approved", reason: authority };
  c.status = "approved"; c.outcome = "refunded";
  await addEvent(c, `refunded by agent: ${naira(funding.amountKobo)}, Paystack refund ${r.refundId} (${r.status}); ${authority}`);
  await audit({ user: AGENT, ref: c.ref, action: `refund ${naira(funding.amountKobo)} (agent)`, reason: authority });
  return {
    ok: true, result: "refunded", case_ref: c.ref, amount: naira(funding.amountKobo),
    wallet_balance: naira(await balance(customer.id)),
    guidance: "Tell the rider the refund has been submitted and give the case reference. Card refunds usually take a few working days to show; bank transfers depend on their bank. Do not mention limits or risk checks.",
  };
}

export async function caseStatus(session: string | undefined, refRaw: string) {
  const cust = await riderFromSession(session);
  if (!cust) return VERIFY_AGAIN;
  const ref = String(refRaw ?? "").trim().toUpperCase();
  const c = await store.get<Case>(`case:${ref}`);
  if (!c || c.customerId !== cust.id) return { ok: false, found: false, guidance: "No case with that reference for this rider." };
  await expireIfStale(c);
  const plain: Record<CaseStatus, string> = {
    open: "We are still checking this.",
    resolved: "This case is resolved.",
    awaiting_owner: "This is with the payments team for review.",
    approved: c.outcome === "refunded"
      ? "Approved. The refund has been submitted; card refunds usually take a few working days to show."
      : c.outcome === "approved_for_bank_dispute"
        ? "Reviewed. No completed payment reached Railow, so the money was not taken by us. If your bank debited you, it will reverse it; this case supports a dispute with your bank."
        : "This was approved.",
    rejected: "After review, this request was not approved.",
    expired: "This review timed out and has been escalated to the payments team.",
    approval_blocked: "This is with the payments team.",
    approval_failed: "This is with the payments team.",
  };
  return { ok: true, found: true, case_ref: ref, status: plain[c.status], last_update: lagosTime(c.updatedAt) };
}

// ---------- 3. CHECKER: decisions from the Ops Console (never reachable by the agent) ----------

export async function expireIfStale(c: Case) {
  if (c.status === "awaiting_owner" && c.claim && hoursSince(c.claim.openedAt) > config.claimTtlHours) {
    c.status = "expired"; c.outcome = "review_timed_out";
    await addEvent(c, `expired: no decision within ${config.claimTtlHours}h, escalated`);
  }
  return c;
}

export const AGENT = "Agent (Chord)";

async function audit(entry: Omit<AuditEntry, "at">) {
  await store.listPush<AuditEntry>("audit", { at: now(), ...entry });
}

/** Settings changes from the Ops Console go in the same audit log as decisions. */
export const auditSettingsChange = (user: string, action: string, reason: string) => audit({ user, ref: "SETTINGS", action, reason });

export type DecisionResult =
  | { ok: true; result: "rejected" | "awaiting_second_approval" | "refund_submitted" | "approved_bank_dispute"; message: string }
  | { ok: false; result: "refused" | "approval_blocked" | "approval_failed"; message: string };

export async function decideCase(refRaw: string, user: string, decisionRaw: string, reasonRaw: string): Promise<DecisionResult> {
  const ref = String(refRaw ?? "").trim().toUpperCase();
  const decision = String(decisionRaw ?? "").trim().toLowerCase();
  const reason = String(reasonRaw ?? "").trim().slice(0, 500);
  const refuse = (message: string): DecisionResult => ({ ok: false, result: "refused", message });

  if (!["approve", "reject"].includes(decision)) return refuse("Choose Approve or Reject.");
  const c = await store.get<Case>(`case:${ref}`);
  if (!c || !c.claim) return refuse("No claim under that reference.");
  await expireIfStale(c);
  if (c.status === "expired") return refuse("This claim expired without a decision. The rider must re-open it.");
  if (c.status !== "awaiting_owner") return refuse(`This claim was already decided (${c.status}).`);
  if (reason.length < 5) return refuse("A reason is required (at least 5 characters).");

  if (decision === "reject") {
    c.status = "rejected"; c.outcome = "owner_rejected";
    c.claim.decision = { by: user, at: now(), action: "rejected", reason };
    await addEvent(c, `REJECTED by ${user}: ${reason}`);
    await audit({ user, ref, action: "reject", reason });
    return { ok: true, result: "rejected", message: `${ref} rejected.` };
  }

  // APPROVE: four-eyes for large amounts, and nobody can approve twice.
  if (c.claim.approvals.some((a) => a.user === user)) return refuse("You have already approved this claim. A different approver must give the second approval.");
  c.claim.approvals.push({ user, at: now(), reason });
  await addEvent(c, `APPROVAL ${c.claim.approvals.length} of ${c.claim.requiredApprovals} by ${user}: ${reason}`);
  await audit({ user, ref, action: `approve (${c.claim.approvals.length}/${c.claim.requiredApprovals})`, reason });
  if (c.claim.approvals.length < c.claim.requiredApprovals) {
    return { ok: true, result: "awaiting_second_approval", message: `Approval ${c.claim.approvals.length} of ${c.claim.requiredApprovals} recorded. A second approver must approve before money moves.` };
  }
  return executeApproval(c, user, reason);
}

async function executeApproval(c: Case, user: string, reason: string): Promise<DecisionResult> {
  const ref = c.ref;
  const claim = c.claim!;
  const f = await store.get<Funding>(`funding:${c.fundingId}`);
  if (!f) return { ok: false, result: "refused", message: "Funding record missing." };

  const v = await verifyPayment(f.reference);
  if (!v.ok) {
    c.status = "approval_failed"; c.outcome = "provider_unreachable_on_approval";
    await addEvent(c, "approved, but provider unreachable; nothing executed");
    return { ok: false, result: "approval_failed", message: "Approved, but Paystack could not be reached, so nothing was executed. Retry later." };
  }
  claim.decision = { by: user, at: now(), action: "approved", reason };
  if (v.status !== "success") {
    c.status = "approved"; c.outcome = "approved_for_bank_dispute";
    await addEvent(c, "approved: no completed payment at provider; logged for bank dispute");
    return { ok: true, result: "approved_bank_dispute", message: "No completed payment exists, so there is nothing to refund. Logged to support the rider's bank dispute." };
  }
  if (f.refund) return { ok: false, result: "refused", message: "A refund was already made for this funding." };

  const bal = await balance(c.customerId);
  let debited = false;
  if (f.creditedAt) {
    if (bal < f.amountKobo) {
      c.status = "approval_blocked"; c.outcome = "funds_already_used";
      await addEvent(c, "approved but BLOCKED: credited funds already used; a refund would pay twice");
      return { ok: false, result: "approval_blocked", message: "Not executed: the credited funds were already used, so a refund would pay the rider twice. Handle manually." };
    }
    // Take the credit back before refunding, so the rider can never hold both.
    await store.set(`wallet:${c.customerId}`, bal - f.amountKobo);
    await store.listPush(`ledger:${c.customerId}`, { type: "reversal", amountKobo: f.amountKobo, at: now(), fundingId: f.id, note: `refund approved ${ref}` } satisfies LedgerEntry);
    debited = true;
  }

  const r = await refundPayment(f.reference, f.amountKobo, `Approved claim ${ref}`);
  if (!r.ok) {
    if (debited) { // compensate: put the wallet back exactly as it was
      await store.set(`wallet:${c.customerId}`, bal);
      await store.listPush(`ledger:${c.customerId}`, { type: "reversal_undo", amountKobo: f.amountKobo, at: now(), fundingId: f.id, note: `refund failed ${ref}` } satisfies LedgerEntry);
    }
    c.status = "approval_failed"; c.outcome = "refund_call_failed";
    await addEvent(c, `approved but Paystack refused the refund (${r.detail}); wallet restored=${debited}`);
    return { ok: false, result: "approval_failed", message: `Paystack refused the refund (${r.detail}). Nothing was changed${debited ? "; the wallet was restored" : ""}.` };
  }

  f.refund = { id: r.refundId, at: now() };
  await store.set(`funding:${f.id}`, f);
  c.status = "approved"; c.outcome = "refunded";
  await addEvent(c, `refund ${r.refundId} submitted to Paystack (${naira(f.amountKobo)}, status ${r.status})`);
  return { ok: true, result: "refund_submitted", message: `Refund of ${naira(f.amountKobo)} submitted to Paystack (status: ${r.status}).` };
}

// ---------- 4. read models for the console ----------

export async function allCases() {
  const refs = await store.listAll<string>("case_refs");
  const cases = (await Promise.all(refs.map((r) => store.get<Case>(`case:${r}`)))).filter(Boolean) as Case[];
  for (const c of cases) await expireIfStale(c);
  return cases.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function caseDetail(refRaw: string) {
  const c = await store.get<Case>(`case:${String(refRaw ?? "").trim().toUpperCase()}`);
  if (!c) return null;
  await expireIfStale(c);
  const funding = await store.get<Funding>(`funding:${c.fundingId}`);
  const customer = await store.get<Customer>(`customer:${c.customerId}`);
  return { c, funding, customer, balance: await balance(c.customerId), ledger: await ledger(c.customerId) };
}

export const auditLog = async () => (await store.listAll<AuditEntry>("audit")).reverse();

export async function smsOutbox() {
  const keys = await store.keys("sms:");
  const all = (await Promise.all(keys.map((k) => store.listAll<SmsMessage>(k)))).flat();
  return all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export async function exceptionsReport() {
  const cases = await allCases();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const touchedToday = cases.filter((c) => new Date(c.updatedAt).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }) === today);
  const count = (pred: (c: Case) => boolean) => touchedToday.filter(pred).length;
  const amountOf = async (c: Case) => naira((await store.get<Funding>(`funding:${c.fundingId}`))?.amountKobo ?? 0);

  return {
    date: today,
    cases_today: touchedToday.length,
    auto_resolved: {
      wallets_credited: count((c) => c.outcome === "wallet_credited"),
      explained_no_action_needed: count((c) => c.outcome.startsWith("explained:")),
    },
    agent_refunds_today: {
      count: count((c) => c.claim?.decision?.by === AGENT && c.outcome === "refunded"),
      total: naira((await Promise.all(touchedToday.filter((c) => c.claim?.decision?.by === AGENT && c.outcome === "refunded").map(async (c) => (await store.get<Funding>(`funding:${c.fundingId}`))?.amountKobo ?? 0))).reduce((a, b) => a + b, 0)),
    },
    decisions_today: {
      approved: count((c) => c.status === "approved" && c.claim?.decision?.by !== AGENT),
      rejected: count((c) => c.status === "rejected"),
    },
    awaiting_decision: await Promise.all(cases.filter((c) => c.status === "awaiting_owner").map(async (c) => ({
      case_ref: c.ref, amount: await amountOf(c), risk: c.claim?.riskLevel,
      approvals: `${c.claim?.approvals.length ?? 0} of ${c.claim?.requiredApprovals ?? 1}`,
      waiting_hours: Math.round(hoursSince(c.claim?.openedAt ?? c.createdAt)),
    }))),
    expired_escalated: cases.filter((c) => c.status === "expired").map((c) => c.ref),
    needs_ops_attention: await Promise.all(cases.filter((c) => c.status === "approval_blocked" || c.status === "approval_failed").map(async (c) => ({ case_ref: c.ref, amount: await amountOf(c), reason: c.outcome }))),
    provider_errors_today: touchedToday.filter((c) => c.events.some((e) => e.what.includes("provider unreachable"))).length,
  };
}
