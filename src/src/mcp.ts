// The MCP surface Chord sees. Descriptions are written for the model: they say when to use each
// tool and what the server will refuse, so the agent never has to guess the rules.
//
// The agent may refund only within the authority the business set in Chord (a custom header on this
// MCP connection, which the model cannot see or change). Approving or rejecting claims is not here
// at all: that lives only in the Ops Console, behind a login.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as d from "./domain.js";
import { config } from "./config.js";
import type { AgentPolicy } from "./policy.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });

// Wrap every tool so an unexpected exception becomes a clear, safe answer instead of a crash.
const safe = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return json(await fn(a)); }
  catch (e) {
    console.error("[tool error]", e);
    return json({ ok: false, error: "internal_error", guidance: "Something went wrong on our side. Tell the rider you could not complete this right now and to try again shortly. Do not guess the outcome." });
  }
};

const phone = z.string().describe("The phone number the rider says is registered on their Railow account, e.g. 08010000001");
const session = z.string().describe("The session value returned by verify_rider. Required for every account tool.");
const fundingId = z.string().describe("funding_id from list_recent_fundings");

export function buildMcpServer(policy: AgentPolicy) {
  const s = new McpServer({ name: `${config.brand} payments desk`, version: "2.0.0" });

  s.registerTool("start_verification", {
    title: "Send the rider a verification code",
    description: "First step in every conversation about an account. Sends a 6-digit code by SMS to the phone REGISTERED on the Railow account (never to the chat). Always answers the same way whether or not the account exists. You never see the code.",
    inputSchema: { phone },
  }, safe(({ phone }: { phone: string }) => d.startVerification(phone)));

  s.registerTool("verify_rider", {
    title: "Check the rider's verification code",
    description: "Checks the 6-digit code the rider typed. On success returns a `session` to pass to every other tool (do not show it to the rider). Codes expire, work once, and lock after 3 wrong attempts.",
    inputSchema: { phone, code: z.string().describe("The 6-digit code exactly as the rider typed it") },
  }, safe(({ phone, code }: { phone: string; code: string }) => d.verifyRider(phone, code)));

  s.registerTool("list_recent_fundings", {
    title: "List recent wallet fundings",
    description: "The verified rider's wallet balance and most recent top-ups (newest first): amount, time, and whether the wallet was credited. Use it to confirm which funding they mean.",
    inputSchema: { session, limit: z.number().int().min(1).max(10).optional() },
    annotations: { readOnlyHint: true },
  }, safe(({ session, limit }: { session: string; limit?: number }) => d.listRecentFundings(session, limit)));

  s.registerTool("check_payment", {
    title: "Check a funding with the payment provider",
    description: "Asks the payment provider what actually happened to this funding and compares it with the wallet. Returns `result`: paid_not_credited | paid_and_credited | failed | abandoned | pending | reversed | amount_mismatch | not_found, plus a case_ref. If ok=false the provider could not be reached: never guess the outcome.",
    inputSchema: { session, funding_id: fundingId },
    annotations: { readOnlyHint: true },
  }, safe(({ session, funding_id }: { session: string; funding_id: string }) => d.checkPayment(session, funding_id)));

  s.registerTool("credit_wallet", {
    title: "Credit the wallet for a confirmed payment",
    description: "Credits the wallet ONLY if the provider confirms the payment succeeded, the amount matches, it was never credited before, and it is under the automatic limit. The server re-verifies everything itself and refuses otherwise. Safe to call twice: a repeat returns already_credited.",
    inputSchema: { session, funding_id: fundingId },
    annotations: { idempotentHint: true, destructiveHint: false },
  }, safe(({ session, funding_id }: { session: string; funding_id: string }) => d.creditWallet(session, funding_id)));

  s.registerTool("refund_payment", {
    title: "Refund a payment (within the business's limit)",
    description: "Use when a verified rider wants money back: a duplicate charge, or a payment they want returned instead of kept in the wallet. The server refunds it itself only if the business allows agent refunds, the amount is within the limit, Paystack confirms the payment, and the case is low risk. Otherwise it automatically sends the request to the payments team and returns a case_ref. Either way, report what the result says; never promise an outcome beforehand.",
    inputSchema: { session, funding_id: fundingId, rider_statement: z.string().describe("The rider's request in their own words") },
  }, safe(({ session, funding_id, rider_statement }: { session: string; funding_id: string; rider_statement: string }) => d.agentRefund(session, funding_id, rider_statement, policy)));

  s.registerTool("open_claim", {
    title: "Send a case to the payments team",
    description: "Use for problems that need a person but are not a simple refund request: an amount mismatch, a payment the provider cannot find, a credit refused over the limit, or a reversal the rider's bank should handle. The server gathers evidence and puts the claim in the payments team's review queue. You only get a case_ref back. Never promise an outcome.",
    inputSchema: { session, funding_id: fundingId, rider_statement: z.string().describe("The rider's request in their own words") },
  }, safe(({ session, funding_id, rider_statement }: { session: string; funding_id: string; rider_statement: string }) => d.openClaim(session, funding_id, rider_statement)));

  s.registerTool("case_status", {
    title: "Case status",
    description: "Where a case stands, for the verified rider who owns it, by case reference. Use it when a rider asks for an update.",
    inputSchema: { session, case_ref: z.string() },
    annotations: { readOnlyHint: true },
  }, safe(({ session, case_ref }: { session: string; case_ref: string }) => d.caseStatus(session, case_ref)));

  return s;
}
