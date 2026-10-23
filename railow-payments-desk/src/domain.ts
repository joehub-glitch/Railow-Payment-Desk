// The business rules. Every money decision is made here, in code, never by the AI.
// The agent chooses WHICH function to call; these functions decide WHETHER money moves.
//
// Rule of the desk: we may put money where it was already paid (credit a wallet for a
// confirmed payment). We never send money out without an owner's code-verified approval.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { config, naira } from "./config.js";
import { store } from "./store.js";
import { verifyPayment, refundPayment, type VerifyResult } from "./paystack.js";
import { notifyOwner } from "./notify.js";

// ---------- types ----------

export interface Customer { id: string; phone: string; name: string; createdAt: string }
export interface Funding {
  id: string; customerId: string; reference: string; amountKobo: number; createdAt: string;
  creditedAt: string | null; refund: { id: string; at: string } | null;
}
export interface LedgerEntry { type: "credit" | "ride" | "reversal" | "reversal_undo"; amountKobo: number; at: string; fundingId?: string; note: string }
export type CaseStatus = "open" | "resolved" | "awaiting_owner" | "approved" | "rejected" | "approval_blocked" | "approval_failed";
export interface CaseEvent { at: string; what: string }
export interface Claim {
  statement: string; openedAt: string; riskLevel: "LOW" | "MEDIUM" | "HIGH"; flags: string[];
  recommendation: string; providerStatus: string;
}
export interface Case {
  ref: string; customerId: string; fundingId: string; createdAt: string; updatedAt: string;
  status: CaseStatus; outcome: string; claim: Claim | null; events: CaseEvent[];
}
interface CodeRecord { hash: string; expiresAt: string; attempts: number }

export type Classification =
  | "paid_not_credited" | "paid_and_credited" | "failed" | "abandoned" | "pending"
  | "reversed" | "amount_mismatch" | "not_found";

// ---------- helpers ----------

const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hoursSince = (iso: string) => (Date.now() - Date.parse(iso)) / 36e5;
const lagosTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;

export function normalizePhone(raw: string): string {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1);
  if (d.length === 10 && !d.startsWith("234")) d = "234" + d;
  return "+" + d;
}

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

// Every lookup is scoped to the phone number of the person writing. A rider can only ever see
// or act on their own fundings, even if they quote someone else's funding id.
async function ownedFunding(phone: string, fundingId: string) {
  const c = await customerByPhone(phone);
  if (!c) return { error: "customer_not_found" as const };
  const f = await store.get<Funding>(`funding:${fundingId}`);
  if (!f || f.customerId !== c.id) return { error: "funding_not_found_for_this_customer" as const };
  return { customer: c, funding: f };
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

// ---------- tools ----------

export async function findCustomer(phone: string) {
  const c = await customerByPhone(phone);
  if (!c) return { found: false, guidance: "No account for this number. Ask once for the phone number registered on the app." };
  return { found: true, customer_id: c.id, name: c.name.split(" ")[0], wallet_balance: naira(await balance(c.id)) };
}

export async function listRecentFundings(phone: string, limit = 5) {
  const c = await customerByPhone(phone);
  if (!c) return { found: false, fundings: [] };
  const list = (await fundingsOf(c.id)).slice(0, Math.max(1, Math.min(limit, 10)));
  return {
    found: true,
    fundings: list.map((f) => ({
      funding_id: f.id,
      amount: naira(f.amountKobo),
      started_at: lagosTime(f.createdAt),
      wallet_credited: Boolean(f.creditedAt),
    })),
  };
}

export async function checkPayment(phone: string, fundingId: string) {
  const o = await ownedFunding(phone, fundingId);
  if ("error" in o) return { ok: false, error: o.error };
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
    paid_at: lagosTime(v.paidAt),
    wallet_credited_at: lagosTime(funding.creditedAt),
    wallet_balance: naira(await balance(customer.id)),
  };
}

export async function creditWallet(phone: string, fundingId: string) {
  const o = await ownedFunding(phone, fundingId);
  if ("error" in o) return { ok: false, error: o.error };
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

export async function openClaim(phone: string, fundingId: string, statement: string) {
  const o = await ownedFunding(phone, fundingId);
  if ("error" in o) return { ok: false, error: o.error };
  const { customer, funding } = o;
  const c = await ensureCase(customer, funding);

  if (c.status === "awaiting_owner") {
    return { ok: true, result: "already_under_review", case_ref: c.ref, guidance: "Tell the rider this case is already with the payments team." };
  }

  // ----- evidence, computed in code -----
  const v = await verifyPayment(funding.reference);
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

  c.claim = { statement: statement.slice(0, 500), openedAt: now(), riskLevel, flags, recommendation, providerStatus };
  c.status = "awaiting_owner";
  c.outcome = "";
  await addEvent(c, `open_claim: risk ${riskLevel}`);
  const claims = (await store.get<string[]>(`claims:${customer.id}`)) ?? [];
  await store.set(`claims:${customer.id}`, [...claims, now()]);

  // ----- one-time code, sent to the owner out of band; never returned to the agent -----
  const code = String(randomInt(100000, 1000000));
  await store.set<CodeRecord>(`casecode:${c.ref}`, {
    hash: sha(`${c.ref}:${code}`),
    expiresAt: new Date(Date.now() + config.codeTtlHours * 36e5).toISOString(),
    attempts: 0,
  });
  await notifyOwner({
    at: now(),
    caseRef: c.ref,
    subject: `[${config.brand}] ${riskLevel} risk claim ${c.ref}: ${naira(funding.amountKobo)}`,
    body: [
      `Case ${c.ref} — ${riskLevel} risk`,
      `Rider: ${customer.name} (${customer.phone}), account ${Math.floor(ageDays)} days old`,
      `Funding: ${naira(funding.amountKobo)} started ${lagosTime(funding.createdAt)}, ref ${funding.reference}`,
      `Provider status: ${providerStatus}`,
      `Rider says: "${c.claim.statement}"`,
      ``,
      `Flags:`,
      ...(flags.length ? flags.map((f) => `  - ${f}`) : ["  - none"]),
      ``,
      `Recommendation: ${recommendation}`,
      ``,
      `To decide, send to the ${config.brand} WhatsApp desk:`,
      `  APPROVE ${c.ref} ${code}`,
      `  REJECT ${c.ref} ${code}`,
      `Code expires in ${config.codeTtlHours}h and locks after ${config.codeMaxAttempts} wrong attempts.`,
    ].join("\n"),
  });

  return {
    ok: true,
    result: "sent_to_review",
    case_ref: c.ref,
    guidance: "Tell the rider their case reference and that the payments team will review it. Do not promise a refund or a timeline. Do not mention risk flags.",
  };
}

export async function decideClaim(caseRefRaw: string, decisionRaw: string, codeRaw: string) {
  const ref = String(caseRefRaw ?? "").trim().toUpperCase();
  const decision = String(decisionRaw ?? "").trim().toLowerCase();
  const code = String(codeRaw ?? "").replace(/\D/g, "");
  const refused = (reason: string) => ({ ok: false, result: "refused", reason });

  if (!["approve", "reject"].includes(decision)) return refused("Decision must be APPROVE or REJECT.");
  const c = await store.get<Case>(`case:${ref}`);
  const rec = await store.get<CodeRecord>(`casecode:${ref}`);
  if (!c || !rec) return refused("No case is awaiting a decision under that reference.");
  if (c.status !== "awaiting_owner") return refused(`This case was already decided (${c.status}).`);
  if (rec.attempts >= config.codeMaxAttempts) return refused("This case is locked after too many wrong codes. Decide it from the ops console.");
  if (Date.parse(rec.expiresAt) < Date.now()) return refused("The code has expired. Re-open the claim to issue a new one.");

  const a = Buffer.from(sha(`${ref}:${code}`)), b = Buffer.from(rec.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    rec.attempts += 1;
    await store.set(`casecode:${ref}`, rec);
    await addEvent(c, `decide_claim: wrong code (attempt ${rec.attempts})`);
    return refused(rec.attempts >= config.codeMaxAttempts ? "Code not accepted. The case is now locked." : "Code not accepted.");
  }

  // Valid code: it is spent whatever happens next.
  await store.del(`casecode:${ref}`);

  if (decision === "reject") {
    c.status = "rejected"; c.outcome = "owner_rejected";
    await addEvent(c, "decide_claim: owner REJECTED");
    return { ok: true, result: "rejected", case_ref: ref, rider_message: "After review, this request was not approved. The wallet stays as it is." };
  }

  // APPROVE: execute safely.
  const f = await store.get<Funding>(`funding:${c.fundingId}`);
  if (!f) return refused("Funding record missing.");
  const v = await verifyPayment(f.reference);
  if (!v.ok) {
    c.status = "approval_failed"; c.outcome = "provider_unreachable_on_approval";
    await addEvent(c, "decide_claim: APPROVED but provider unreachable");
    return { ok: false, result: "approval_failed", case_ref: ref, reason: "Approved, but the payment provider could not be reached to execute it. Ops must retry from the console." };
  }
  if (v.status !== "success") {
    c.status = "approved"; c.outcome = "approved_for_bank_dispute";
    await addEvent(c, "decide_claim: APPROVED, no completed payment; logged for bank dispute");
    return { ok: true, result: "approved_bank_dispute", case_ref: ref, rider_message: "We have no completed payment for this funding, so the money did not reach us. If your bank debited you, it will reverse it; we have logged your case to support a dispute with your bank." };
  }
  if (f.refund) return refused("A refund was already made for this funding.");

  const bal = await balance(c.customerId);
  let debited = false;
  if (f.creditedAt) {
    if (bal < f.amountKobo) {
      c.status = "approval_blocked"; c.outcome = "funds_already_used";
      await addEvent(c, "decide_claim: APPROVED but blocked, funds already used");
      return { ok: false, result: "approval_blocked", case_ref: ref, reason: "Approval recorded but not executed: the credited funds have already been used, so a refund would pay twice. Ops must handle this manually." };
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
    await addEvent(c, `decide_claim: APPROVED but refund failed (${r.detail}); wallet restored=${debited}`);
    return { ok: false, result: "approval_failed", case_ref: ref, reason: "Approved, but the refund could not be submitted. Nothing was changed. Ops must retry." };
  }

  f.refund = { id: r.refundId, at: now() };
  await store.set(`funding:${f.id}`, f);
  c.status = "approved"; c.outcome = "refunded";
  await addEvent(c, `decide_claim: APPROVED, refund ${r.refundId} submitted (${naira(f.amountKobo)})`);
  return { ok: true, result: "refund_submitted", case_ref: ref, amount: naira(f.amountKobo), rider_message: `Your refund of ${naira(f.amountKobo)} has been approved and submitted. Card refunds usually take a few working days to show.` };
}

export async function caseStatus(phone: string, refRaw: string) {
  const ref = String(refRaw ?? "").trim().toUpperCase();
  const c = await store.get<Case>(`case:${ref}`);
  const cust = await customerByPhone(phone);
  if (!c || !cust || c.customerId !== cust.id) return { found: false, guidance: "No case with that reference for this number." };
  const plain: Record<CaseStatus, string> = {
    open: "We are still checking this.",
    resolved: "This case is resolved.",
    awaiting_owner: "This is with the payments team for review.",
    approved: "This was approved.",
    rejected: "This request was not approved after review.",
    approval_blocked: "This is with the payments team.",
    approval_failed: "This is with the payments team.",
  };
  return { found: true, case_ref: ref, status: plain[c.status], last_update: lagosTime(c.updatedAt) };
}

export async function exceptionsReport() {
  const refs = await store.listAll<string>("case_refs");
  const cases = (await Promise.all(refs.map((r) => store.get<Case>(`case:${r}`)))).filter(Boolean) as Case[];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const touchedToday = cases.filter((c) => new Date(c.updatedAt).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }) === today);

  const count = (pred: (c: Case) => boolean) => touchedToday.filter(pred).length;
  const awaiting = cases.filter((c) => c.status === "awaiting_owner");
  const needsOps = cases.filter((c) => c.status === "approval_blocked" || c.status === "approval_failed");
  const amountOf = async (c: Case) => naira((await store.get<Funding>(`funding:${c.fundingId}`))?.amountKobo ?? 0);

  return {
    date: today,
    cases_today: touchedToday.length,
    auto_resolved: {
      wallets_credited: count((c) => c.outcome === "wallet_credited"),
      explained_no_action_needed: count((c) => c.outcome.startsWith("explained:")),
    },
    owner_decisions_today: {
      approved: count((c) => c.status === "approved"),
      rejected: count((c) => c.status === "rejected"),
    },
    awaiting_owner_decision: await Promise.all(awaiting.map(async (c) => ({
      case_ref: c.ref, amount: await amountOf(c), risk: c.claim?.riskLevel, waiting_hours: Math.round(hoursSince(c.claim?.openedAt ?? c.createdAt)),
    }))),
    needs_ops_attention: await Promise.all(needsOps.map(async (c) => ({ case_ref: c.ref, amount: await amountOf(c), reason: c.outcome }))),
    provider_errors_today: touchedToday.filter((c) => c.events.some((e) => e.what.includes("provider unreachable"))).length,
  };
}
