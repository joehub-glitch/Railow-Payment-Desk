// Demo data. Made up: no real customers, numbers or payments.
// Each rider exists to show one case. In live mode, pass real Paystack TEST references for the
// scenarios marked `live`; scenarios marked SIM_ stay simulated because Paystack test mode cannot
// produce them on demand.

import { store } from "./store.js";
import type { Customer, Funding, LedgerEntry } from "./domain.js";
import type { MockPayment } from "./paystack.js";

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const N = (naira: number) => naira * 100;

export type ScenarioKey =
  | "ada_paid_not_credited" | "bayo_already_credited" | "chioma_failed" | "dapo_pending"
  | "emeka_spent_then_claims" | "funke_duplicate_a" | "funke_duplicate_b" | "gbenga_over_limit"
  | "halima_provider_timeout" | "ife_amount_mismatch" | "kemi_refundfail";

interface Scenario {
  key: ScenarioKey;
  customer: { id: string; phone: string; name: string; ageDays: number; startBalance: number };
  funding: { id: string; amount: number; minsAgo: number; credited?: boolean };
  // What the payment provider says (used in mock mode, or always for SIM_ references).
  provider: MockPayment;
  live: boolean; // can be reproduced with a real Paystack test payment
  rides?: { amount: number; minsAgo: number }[];
  priorClaimsDaysAgo?: number[];
}

export const scenarios: Scenario[] = [
  { key: "ada_paid_not_credited", live: true,
    customer: { id: "cus_ada", phone: "+2348010000001", name: "Ada Okafor", ageDays: 400, startBalance: 1200 },
    funding: { id: "fnd_ada_1", amount: 5000, minsAgo: 35 },
    provider: { status: "success", amountKobo: N(5000), paidAt: ago(34), channel: "card" } },
  { key: "bayo_already_credited", live: true,
    customer: { id: "cus_bayo", phone: "+2348010000002", name: "Bayo Adeyemi", ageDays: 220, startBalance: 3800 },
    funding: { id: "fnd_bayo_1", amount: 3000, minsAgo: 90, credited: true },
    provider: { status: "success", amountKobo: N(3000), paidAt: ago(89), channel: "card" } },
  { key: "chioma_failed", live: true,
    customer: { id: "cus_chioma", phone: "+2348010000003", name: "Chioma Eze", ageDays: 150, startBalance: 500 },
    funding: { id: "fnd_chioma_1", amount: 10000, minsAgo: 20 },
    provider: { status: "failed", amountKobo: N(10000), paidAt: null, channel: "card" } },
  { key: "dapo_pending", live: false,
    customer: { id: "cus_dapo", phone: "+2348010000004", name: "Dapo Bello", ageDays: 60, startBalance: 0 },
    funding: { id: "fnd_dapo_1", amount: 2000, minsAgo: 6 },
    provider: { status: "pending", amountKobo: N(2000), paidAt: null, channel: "bank_transfer" } },
  { key: "emeka_spent_then_claims", live: true,
    customer: { id: "cus_emeka", phone: "+2348010000005", name: "Emeka Nwosu", ageDays: 9, startBalance: 0 },
    funding: { id: "fnd_emeka_1", amount: 50000, minsAgo: 26 * 60, credited: true },
    provider: { status: "success", amountKobo: N(50000), paidAt: ago(26 * 60 - 1), channel: "card" },
    rides: [{ amount: 18000, minsAgo: 25 * 60 }, { amount: 30000, minsAgo: 20 * 60 }],
    priorClaimsDaysAgo: [6, 17] },
  { key: "funke_duplicate_a", live: true,
    customer: { id: "cus_funke", phone: "+2348010000006", name: "Funke Lawal", ageDays: 300, startBalance: 2000 },
    funding: { id: "fnd_funke_1", amount: 8000, minsAgo: 50, credited: true },
    provider: { status: "success", amountKobo: N(8000), paidAt: ago(49), channel: "card" } },
  { key: "funke_duplicate_b", live: true,
    customer: { id: "cus_funke", phone: "+2348010000006", name: "Funke Lawal", ageDays: 300, startBalance: 2000 },
    funding: { id: "fnd_funke_2", amount: 8000, minsAgo: 47 },
    provider: { status: "success", amountKobo: N(8000), paidAt: ago(46), channel: "card" } },
  { key: "gbenga_over_limit", live: true,
    customer: { id: "cus_gbenga", phone: "+2348010000007", name: "Gbenga Ojo", ageDays: 500, startBalance: 0 },
    funding: { id: "fnd_gbenga_1", amount: 150000, minsAgo: 15 },
    provider: { status: "success", amountKobo: N(150000), paidAt: ago(14), channel: "card" } },
  { key: "halima_provider_timeout", live: false,
    customer: { id: "cus_halima", phone: "+2348010000008", name: "Halima Musa", ageDays: 80, startBalance: 700 },
    funding: { id: "fnd_halima_1", amount: 4000, minsAgo: 12 },
    provider: { status: "success", amountKobo: N(4000), paidAt: ago(11), channel: "card" } },
  { key: "ife_amount_mismatch", live: true,
    customer: { id: "cus_ife", phone: "+2348010000009", name: "Ife Ogunleye", ageDays: 120, startBalance: 900 },
    funding: { id: "fnd_ife_1", amount: 4000, minsAgo: 25 },
    provider: { status: "success", amountKobo: N(3500), paidAt: ago(24), channel: "card" } },
  // Credited and unused, like Bayo, but paid with Paystack's "refund fails" test card, so an approved
  // refund genuinely fails at Paystack and the desk must restore the wallet.
  { key: "kemi_refundfail", live: true,
    customer: { id: "cus_kemi", phone: "+2348010000010", name: "Kemi Balogun", ageDays: 260, startBalance: 1500 },
    funding: { id: "fnd_kemi_1", amount: 6000, minsAgo: 70, credited: true },
    provider: { status: "success", amountKobo: N(6000), paidAt: ago(69), channel: "card" } },
];

// Paystack test cards (expiry 09/27): https://paystack.com/docs/payments/test-payments/
const CARD_SUCCESS = "4084 0840 8408 4081, CVV 408";
const CARD_DECLINED = "4084 0800 0000 5408, CVV 001";
const CARD_REFUND_FAILS = "4084 0800 0067 1803, CVV 180";

// What to PAY at checkout for each live scenario, and with which card.
// (For the mismatch scenario you pay less than the funding expects.)
export const livePaymentPlan = scenarios.filter((s) => s.live).map((s) => ({
  key: s.key,
  payNaira: s.provider.amountKobo / 100,
  card: s.provider.status === "failed" ? CARD_DECLINED : s.key === "kemi_refundfail" ? CARD_REFUND_FAILS : CARD_SUCCESS,
  outcome: s.provider.status === "failed" ? "should be DECLINED" : "should succeed",
}));

export async function seed(liveRefs: Partial<Record<ScenarioKey, string>> = {}) {
  await store.flush();
  const seen = new Set<string>();
  for (const s of scenarios) {
    const reference = liveRefs[s.key] ?? `SIM_${s.key.toUpperCase()}${s.key === "halima_provider_timeout" ? "_TIMEOUT" : ""}`;
    const cu = s.customer;
    if (!seen.has(cu.id)) {
      seen.add(cu.id);
      await store.set<Customer>(`customer:${cu.id}`, { id: cu.id, phone: cu.phone, name: cu.name, createdAt: ago(cu.ageDays * 1440) });
      await store.set(`phone:${cu.phone}`, cu.id);
      await store.set(`wallet:${cu.id}`, N(cu.startBalance));
      await store.set(`fundings:${cu.id}`, []);
    }
    const f: Funding = {
      id: s.funding.id, customerId: cu.id, reference, amountKobo: N(s.funding.amount),
      createdAt: ago(s.funding.minsAgo), creditedAt: s.funding.credited ? ago(s.funding.minsAgo - 1) : null, refund: null,
    };
    await store.set(`funding:${f.id}`, f);
    const ids = (await store.get<string[]>(`fundings:${cu.id}`)) ?? [];
    await store.set(`fundings:${cu.id}`, [...ids, f.id]);
    if (f.creditedAt) {
      await store.set(`credited:${f.id}`, f.creditedAt);
      await store.set(`wallet:${cu.id}`, ((await store.get<number>(`wallet:${cu.id}`)) ?? 0) + f.amountKobo);
      await store.listPush<LedgerEntry>(`ledger:${cu.id}`, { type: "credit", amountKobo: f.amountKobo, at: f.creditedAt, fundingId: f.id, note: "normal credit" });
    }
    for (const r of s.rides ?? []) {
      await store.set(`wallet:${cu.id}`, ((await store.get<number>(`wallet:${cu.id}`)) ?? 0) - N(r.amount));
      await store.listPush<LedgerEntry>(`ledger:${cu.id}`, { type: "ride", amountKobo: N(r.amount), at: ago(r.minsAgo), note: "ride payment" });
    }
    if (s.priorClaimsDaysAgo) await store.set(`claims:${cu.id}`, s.priorClaimsDaysAgo.map((d) => ago(d * 1440)));
    if (!liveRefs[s.key]) await store.set<MockPayment>(`mockpay:${reference}`, s.provider);
  }
  return { riders: seen.size, fundings: scenarios.length, live_refs_used: Object.keys(liveRefs).length };
}
