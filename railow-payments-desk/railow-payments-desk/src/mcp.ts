// The MCP surface Chord sees. Descriptions are written for the model: they say when to use each
// tool and what the server will refuse, so the agent never has to guess the rules.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as d from "./domain.js";
import { config } from "./config.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });

// Wrap every tool so an unexpected exception becomes a clear, safe answer instead of a crash.
const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return json(await fn(a)); }
  catch (e) {
    console.error("[tool error]", e);
    return json({ ok: false, error: "internal_error", guidance: "Something went wrong on our side. Tell the rider you could not complete this right now and to try again shortly. Do not guess the outcome." });
  }
};

const phone = z.string().describe("WhatsApp number of the person writing, e.g. +2348010000001 or 08010000001");
const fundingId = z.string().describe("funding_id from list_recent_fundings");

export function buildMcpServer() {
  const s = new McpServer({ name: `${config.brand} payments desk`, version: "1.0.0" });

  s.registerTool("find_customer", {
    title: "Find rider",
    description: "Look up the rider by the WhatsApp number they are writing from. Call this first in every conversation.",
    inputSchema: { phone },
    annotations: { readOnlyHint: true },
  }, safe(({ phone }: { phone: string }) => d.findCustomer(phone)));

  s.registerTool("list_recent_fundings", {
    title: "List recent wallet fundings",
    description: "The rider's most recent wallet top-ups (newest first) with amount, time and whether the wallet was credited. Use it to confirm which funding they mean.",
    inputSchema: { phone, limit: z.number().int().min(1).max(10).optional() },
    annotations: { readOnlyHint: true },
  }, safe(({ phone, limit }: { phone: string; limit?: number }) => d.listRecentFundings(phone, limit)));

  s.registerTool("check_payment", {
    title: "Check a funding with the payment provider",
    description: "Asks the payment provider what actually happened to this funding and compares it with the wallet. Returns `result`: paid_not_credited | paid_and_credited | failed | abandoned | pending | reversed | amount_mismatch | not_found, plus a case_ref. If ok=false the provider could not be reached: never guess the outcome.",
    inputSchema: { phone, funding_id: fundingId },
    annotations: { readOnlyHint: true },
  }, safe(({ phone, funding_id }: { phone: string; funding_id: string }) => d.checkPayment(phone, funding_id)));

  s.registerTool("credit_wallet", {
    title: "Credit the wallet for a confirmed payment",
    description: "Credits the wallet ONLY if the provider confirms the payment succeeded, the amount matches, it was never credited before, and it is under the automatic limit. The server re-verifies everything itself and refuses otherwise. Safe to call twice: a repeat returns already_credited.",
    inputSchema: { phone, funding_id: fundingId },
    annotations: { idempotentHint: true, destructiveHint: false },
  }, safe(({ phone, funding_id }: { phone: string; funding_id: string }) => d.creditWallet(phone, funding_id)));

  s.registerTool("open_claim", {
    title: "Send a money-back claim to the payments team",
    description: "Use for any refund, reversal, 'return my money', duplicate charge, amount mismatch, or credit refused over the limit. The server gathers evidence and notifies the owner privately. You will only get a case_ref back; never promise an outcome.",
    inputSchema: { phone, funding_id: fundingId, rider_statement: z.string().describe("The rider's request in their own words") },
  }, safe(({ phone, funding_id, rider_statement }: { phone: string; funding_id: string; rider_statement: string }) => d.openClaim(phone, funding_id, rider_statement)));

  s.registerTool("decide_claim", {
    title: "Relay an owner's decision",
    description: "Use ONLY when someone sends 'APPROVE <case ref> <code>' or 'REJECT <case ref> <code>'. Pass exactly what they typed. The server alone checks the code; if it refuses, report that and do not retry with another code.",
    inputSchema: {
      case_ref: z.string().describe("e.g. RW-1004"),
      // Plain string on purpose: owners type APPROVE in capitals, and a strict enum made the
      // model's call fail validation. The server normalises case and rejects anything else.
      decision: z.string().describe("approve or reject (any case)"),
      code: z.string().describe("The 6-digit code exactly as typed"),
    },
  }, safe(({ case_ref, decision, code }: { case_ref: string; decision: string; code: string }) => d.decideClaim(case_ref, decision, code)));

  s.registerTool("case_status", {
    title: "Case status",
    description: "Status of a case for the rider who owns it, by case reference.",
    inputSchema: { phone, case_ref: z.string() },
    annotations: { readOnlyHint: true },
  }, safe(({ phone, case_ref }: { phone: string; case_ref: string }) => d.caseStatus(phone, case_ref)));

  s.registerTool("exceptions_report", {
    title: "Daily exceptions report",
    description: "Today's wallet-funding cases for the ops team: auto-resolved, owner decisions, cases awaiting a decision and anything needing manual attention. For the scheduled daily report only; never share with a rider.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, safe(() => d.exceptionsReport()));

  return s;
}
