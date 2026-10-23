// Paystack client. Live mode calls the real Paystack API with a TEST secret key.
// Mock mode answers from seeded data so the whole flow can be tested offline.
// Either way, callers get the same shape back, and every failure is a typed result, not a throw.

import { config } from "./config.js";
import { store } from "./store.js";

export type ProviderStatus = "success" | "failed" | "abandoned" | "pending" | "reversed" | "not_found";

export type VerifyResult =
  | { ok: true; status: ProviderStatus; amountKobo: number; paidAt: string | null; channel: string | null; gatewayResponse: string | null }
  | { ok: false; error: "timeout" | "provider_error" | "not_configured"; detail: string };

export type RefundResult =
  | { ok: true; refundId: string; status: string }
  | { ok: false; error: "timeout" | "provider_error" | "not_configured"; detail: string };

export interface MockPayment { status: ProviderStatus; amountKobo: number; paidAt: string | null; channel: string | null }

const mapStatus = (s: string): ProviderStatus => {
  switch (s) {
    case "success": return "success";
    case "failed": return "failed";
    case "abandoned": return "abandoned";
    case "reversed": return "reversed";
    // Paystack uses several in-flight states; for our purposes they all mean "not confirmed yet".
    case "ongoing": case "pending": case "processing": case "queued": return "pending";
    default: return "pending";
  }
};

async function call(path: string, init: RequestInit = {}) {
  if (!config.paystackSecret) return { kind: "not_configured" as const };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.paystackTimeoutMs);
  try {
    const res = await fetch(`https://api.paystack.co${path}`, {
      ...init,
      signal: ac.signal,
      headers: { Authorization: `Bearer ${config.paystackSecret}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as any;
    return { kind: "response" as const, httpStatus: res.status, body };
  } catch (e: any) {
    return e?.name === "AbortError" ? { kind: "timeout" as const } : { kind: "network" as const, detail: String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

export async function verifyPayment(reference: string): Promise<VerifyResult> {
  // References starting with SIM_ are always simulated, even in live mode. They cover states
  // Paystack test mode cannot produce on demand (a payment stuck in "pending", a provider
  // timeout). They are labelled SIM_ so nobody mistakes them for real test payments.
  if (config.paystackMode === "mock" || reference.startsWith("SIM_")) {
    if (reference.includes("TIMEOUT")) return { ok: false, error: "timeout", detail: "simulated provider timeout" };
    const p = await store.get<MockPayment>(`mockpay:${reference}`);
    if (!p) return { ok: true, status: "not_found", amountKobo: 0, paidAt: null, channel: null, gatewayResponse: null };
    return { ok: true, status: p.status, amountKobo: p.amountKobo, paidAt: p.paidAt, channel: p.channel, gatewayResponse: null };
  }

  const r = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (r.kind === "not_configured") return { ok: false, error: "not_configured", detail: "PAYSTACK_SECRET_KEY is not set" };
  if (r.kind === "timeout") return { ok: false, error: "timeout", detail: "Paystack did not answer in time" };
  if (r.kind === "network") return { ok: false, error: "provider_error", detail: r.detail };
  // Paystack answers an unknown reference with HTTP 400 / status:false.
  if (r.httpStatus === 400 || r.httpStatus === 404) {
    return { ok: true, status: "not_found", amountKobo: 0, paidAt: null, channel: null, gatewayResponse: r.body?.message ?? null };
  }
  if (r.httpStatus >= 400 || !r.body?.status || !r.body?.data) {
    return { ok: false, error: "provider_error", detail: `HTTP ${r.httpStatus}: ${r.body?.message ?? "unexpected response"}` };
  }
  const d = r.body.data;
  return {
    ok: true,
    status: mapStatus(String(d.status)),
    amountKobo: Number(d.amount ?? 0),
    paidAt: d.paid_at ?? d.paidAt ?? null,
    channel: d.channel ?? null,
    gatewayResponse: d.gateway_response ?? null,
  };
}

export async function refundPayment(reference: string, amountKobo: number, note: string): Promise<RefundResult> {
  if (config.paystackMode === "mock" || reference.startsWith("SIM_")) {
    if (reference.includes("REFUNDFAIL")) return { ok: false, error: "provider_error", detail: "simulated refund failure" };
    return { ok: true, refundId: `mock_refund_${Date.now()}`, status: "pending" };
  }
  const r = await call(`/refund`, { method: "POST", body: JSON.stringify({ transaction: reference, amount: amountKobo, merchant_note: note }) });
  if (r.kind === "not_configured") return { ok: false, error: "not_configured", detail: "PAYSTACK_SECRET_KEY is not set" };
  if (r.kind === "timeout") return { ok: false, error: "timeout", detail: "Paystack did not answer in time" };
  if (r.kind === "network") return { ok: false, error: "provider_error", detail: r.detail };
  if (r.httpStatus >= 400 || !r.body?.status) {
    return { ok: false, error: "provider_error", detail: `HTTP ${r.httpStatus}: ${r.body?.message ?? "refund refused"}` };
  }
  return { ok: true, refundId: String(r.body.data?.id ?? ""), status: String(r.body.data?.status ?? "pending") };
}

// Used by the seed script in live mode: creates a checkout link you pay with a Paystack test card.
export async function initializePayment(email: string, amountKobo: number, reference: string) {
  const r = await call(`/transaction/initialize`, { method: "POST", body: JSON.stringify({ email, amount: amountKobo, reference }) });
  if (r.kind !== "response" || !r.body?.status) throw new Error(`initialize failed: ${JSON.stringify(r)}`);
  return r.body.data.authorization_url as string;
}

// Diagnostic only: confirms the key works without exposing it.
export async function pingPaystack() {
  const r = await call(`/transaction?perPage=1`);
  if (r.kind === "not_configured") return { ok: false, detail: "PAYSTACK_SECRET_KEY is not set" };
  if (r.kind === "timeout") return { ok: false, detail: "Paystack did not answer in time" };
  if (r.kind === "network") return { ok: false, detail: r.detail };
  return r.body?.status
    ? { ok: true, detail: "key accepted" }
    : { ok: false, detail: `HTTP ${r.httpStatus}: ${r.body?.message ?? "rejected"}` };
}
