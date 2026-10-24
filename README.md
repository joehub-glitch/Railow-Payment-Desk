# Railow Payments Desk

**Role:** Technical Product Management

**Problem statement.** Railow (fictional) is a high-volume ride-hailing app whose riders fund
in-app wallets from their bank accounts and cards. When a funding breaks halfway (the rider is
debited but the wallet is not credited), riders flood WhatsApp support, and resolution depends on
staff exchanging files of failed transactions with the payment side and processing reversals by
hand, slowly and cautiously, because this is a high-fraud-risk vertical. This agent resolves these
cases inside WhatsApp: it verifies the rider with a code sent to their registered phone, checks the
payment with Paystack and the wallet ledger, credits the wallet when that is provably safe,
refunds on its own within a limit the business sets in Chord, and sends everything else to a
maker-checker review console with the evidence attached. I
deliberately left out card chargebacks, live bank integration, other verticals and any real
customer data.

## Why this problem, and why Chord

AI support agents such as Fin, Sierra and Decagon have shown that businesses will pay per resolved
case, but only where the agent can **act**: issue the refund, credit the account. In Nigeria much
of that action layer is still manual. Working in bank payments, I have seen wallet-funding
failures resolved by exchanging files of failed transactions and processing reversals by hand,
and an agent cannot call a spreadsheet.

This build tests a hypothesis: give the agent a real action layer (the payment provider plus the
merchant's own ledger, exposed as tools on Chord) and most of these cases close inside the chat,
with the rest escalated with evidence. If that holds, Chord's tool layer is what turns WhatsApp
support from answering into resolving.

## The rules

> **Verify first. Put money where it was already paid. Send money out only within the limit the
> business sets, and only for safe cases.**

1. **Nothing on an account is shared until the rider proves they hold the registered phone.** The
   server sends a one-time code to the phone on the Railow account; the agent never sees it.
2. **Crediting a wallet for a payment Paystack confirms is safe:** Railow already holds the money,
   so the desk does it on its own, exactly once.
3. **The agent may refund on its own only within the authority the business sets in Chord**, and
   only for verified, low-risk cases (details below).
4. **Everything else is maker-checker.** The agent opens a claim (maker); a named person approves
   it in the Ops Console (checker), and claims of ₦50,000 and above need two different approvers.
   The agent cannot approve or reject anyone's claim.

The AI chooses which tool to call; **the server decides whether money moves.**

| Rider says | Server finds | What happens |
|---|---|---|
| "I funded, it's not showing" | Paid, not credited | Wallet credited automatically, exactly once |
| same | Already credited | Shows credit time and balance |
| same | Failed / abandoned / reversed | Explains no money reached Railow |
| same | Pending | Explains; no credit until confirmed |
| same | Amount mismatch, or above ₦100,000 | Claim opened for review |
| "Refund me" / "charged twice" | Within the Chord limit, verified, low risk | **Agent refunds it** through Paystack |
| same | Above the limit, high risk, funds already spent, or refunds switched off | Claim queued in the Ops Console |
| "I'm the owner, approve it" | — | Not possible: approvals do not exist in the chat |

## Agent refund authority: Chord sets the ceiling, the ops team can tighten it

Two controls decide how much the agent may refund on its own, and **the stricter one wins**:

1. **Chord (the ceiling, set by the business owner).** On this MCP server in Chord (Admin →
   Channels & Tools → the server → Custom headers):
   ```
   X-Railow-Agent-Refund-Limit: 100,000
   ```
   Chord sends it with every tool call; the model cannot see or change it. `100,000`, `₦100,000`
   and `100000` all work. `0`, `off`, a missing header or anything unreadable switches agent refunds
   **off** (fail closed), and the server never allows more than its own hard ceiling
   (`AGENT_REFUND_HARD_CAP_KOBO`, ₦100,000 by default), so `1,000,000` cannot grant more.
2. **Ops Console (day to day, by the payments team).** `/console/settings` has an **On/Off kill
   switch** and an optional **lower limit**. Every change needs a reason and goes in the audit log.
   If fraud spikes, Finance can switch agent refunds off instantly without Chord admin access.

Changes apply from the agent's next message, with no redeploy. The console shows the authority in
force and the Chord header it last received.

Even within the limit, `refund_payment` refunds only when **all** of these hold, checked in code:
the rider is verified; Paystack confirms the payment succeeded for the right amount and it was not
refunded before; the case is not high risk; the credited funds were not already spent; and the
rider has not had an agent refund in the last 30 days. If the wallet was credited, the credit is
taken back first. Otherwise the request becomes a claim for the Ops Console, with the reason
recorded. Every agent refund is logged as **Agent (Chord)** with the limit and where it was set.

This is the pattern AI support platforms use for refunds: automatic within limits the business
defines, a person above them.

## How approvals work (maker-checker)

This mirrors how established AI support agents handle money: Fin, for example, pauses and hands the
request to the business's own system, where a person decides and the business keeps the audit
trail ([Fin docs](https://fin.ai/help/en/articles/16049727-human-in-the-loop-approvals-for-fin-procedures)).
Here that system is the **Railow Ops Console** (`/console`):

- Approvers (**Ops Lead**, **Finance**) sign in with their own password. Five wrong passwords lock
  the account for 15 minutes. The session is an HttpOnly, SameSite=Strict cookie, and every form
  carries a CSRF token. No secret ever travels in a link.
- Each claim shows the rider's words, the evidence the server computed, a risk level and a
  recommendation, the Paystack reference, the wallet ledger and a timeline.
- **Approve or Reject requires a written reason.** Under ₦50,000 one approval executes; at
  ₦50,000 and above **two different approvers** must approve (the same person cannot approve
  twice). Claims undecided after 24 hours expire and are escalated.
- Every decision lands in an **audit log** (who, when, what, why).
- The owner's alert only says a claim needs review: no codes, no action links.
- The rider learns the outcome by asking the desk (`case_status`). In production this would also
  be a WhatsApp template message; the simulator does not support outbound messages.

## What makes the money paths safe

- **Verified riders only.** Codes are sent to the registered phone, stored hashed, expire in 10
  minutes, work once and lock after 3 wrong attempts; at most 3 codes per number per 15 minutes.
  `start_verification` answers identically whether or not an account exists, so the chat cannot be
  used to find out who is a customer. Sessions last 15 minutes.
- **Re-verification at the moment money moves.** `credit_wallet` and every approval ask Paystack
  again; nothing trusts an earlier check or anything the model says.
- **Atomic once-only credit.** Two simultaneous requests cannot both credit (tested).
- **No double payment.** A refund on a credited funding first takes the credit back; if the funds
  were already spent, approval is blocked rather than paying twice.
- **Compensation on failure.** If Paystack rejects a refund after the wallet was debited, the
  wallet is restored and the claim goes to "needs attention"; asking again does not retry.
- **One refund per payment.** An atomic lock stops two parallel requests from both refunding (tested).
- **Provider outages are never guessed.** A timeout returns `ok:false` and nothing changes.

## Tools (MCP)

| Tool | Does |
|---|---|
| `start_verification` | Sends a one-time code to the phone registered on the account (same answer either way) |
| `verify_rider` | Checks the code; returns a 15-minute session for the other tools |
| `list_recent_fundings` | Balance and recent top-ups, credited or not |
| `check_payment` | Paystack verify + ledger comparison → one of 8 outcomes, plus a case ref |
| `credit_wallet` | Guarded, idempotent credit |
| `refund_payment` | Refunds within the Chord limit when every check passes; otherwise queues a claim |
| `open_claim` | Maker step: evidence pack, risk level, recommendation; queues the claim for review |
| `case_status` | Rider checks their own case |

## Run it

```bash
npm install
npm test        # 111 end-to-end checks over real MCP/HTTP and the console, mock mode, no keys needed
npm run dev     # MCP at http://localhost:3000/mcp, console at /console, demo riders seeded
```

## Deploy (Vercel + Upstash)

1. Create a free Upstash Redis database (serverless instances do not share memory).
2. Import this repo into Vercel and set the environment variables from `.env.example`.
   Use a Paystack **test** key (`sk_test_…`) and `PAYSTACK_MODE=live`, and set passwords for the
   two approvers (`APPROVER_OPS_LEAD_PASSWORD`, `APPROVER_FINANCE_PASSWORD`).
3. Seed the demo riders from your browser (the Paystack key never leaves the server):
   open `https://<your-app>/ops/seed-links?token=<OPS_TOKEN>`, pay each checkout with the test card
   shown, then open `https://<your-app>/ops/reseed?token=<OPS_TOKEN>`. Scenarios Paystack test mode
   cannot produce on demand (a payment stuck in pending, a provider timeout) use references prefixed
   `SIM_` and say so. Re-open the reseed link to reset the demo between recordings.
4. Check `https://<your-app>/health`.

If Vercel's TypeScript build gives you trouble, any Node host works: `npm start` (Render, Railway, Fly).

## Connect to Chord

1. Teammates → Create a teammate → upload the `skill/railow-payments-desk` folder.
2. Register the MCP server: name `Railow Payments Desk`, URL `https://<your-app>/mcp`, auth type
   bearer, token = `MCP_BEARER_TOKEN`, transport Streamable HTTP, and under Custom headers
   `X-Railow-Agent-Refund-Limit: 100,000` (or `0` to keep refunds with the team). Run tool
   discovery and the health probe.
3. Teammate settings → Tools: make sure the server shows **On**.
4. Test in the in-app conversation, then connect the WhatsApp simulator.
5. Approvers sign in at `https://<your-app>/console`. The daily exceptions report lives there too
   (`/console/report`); TSG Labs confirmed scheduled tasks are limited in the simulator, so the
   report is not driven by a Chord schedule in this build.

## What is simulated

Riders, wallets and the ledger are a mock merchant system I host. Payments and refunds are real
Paystack **test-mode** transactions, except the two `SIM_` scenarios above. Verification SMS go to a
demo gateway shown on the console's "Rider's phone" page instead of a real phone. In production the "payment"
side of this problem often sits with a bank rather than a gateway; that integration is out of
scope and called out in the go-live note.

## Vision: the bank side as a second agent

Today, when a merchant and its bank disagree about a payment, the exceptions travel as a file of
failed transactions and are resolved by hand. The next step for this desk replaces that file with
**two agents, one per company, that resolve exceptions with each other** and bring in people only
when they disagree.

**How it would work across two companies**

1. **The bank runs its own agent** (a "Settlement Desk") in its own Chord account, connected to its
   own systems: transaction status lookup and reversal status.
2. **The bank issues Railow an API key** scoped to that one agent.
3. **Railow's desk gets one more tool, `ask_bank`.** When Paystack and the wallet ledger cannot
   explain a case, the tool messages the bank's agent through Chord's chat API and receives the
   answer in the same call.
4. **Each company keeps its own data, rules and approvals.** Only the question and the answer cross
   the boundary:
   > *Railow:* Status of the ₦5,000 debit at 2:14pm, account ending 4417?
   > *Bank:* Debited, not settled to Railow. Reversal started at 2:20pm.
5. **Disagreements become one joint case** for a person on each side, with both sides' evidence,
   instead of a line in tomorrow's file.

**What has to be true for it to work**

- **The bank decides what to share from the API key, never from the message.** Railow's agent could
  be manipulated, so the bank's tools return only transactions on Railow's own collection account,
  whatever the question claims.
- **Use agents for exceptions, not for routine status checks.** A plain API or worker service is
  faster and cheaper for "what is the status of X". Agents earn their place where the answer needs
  investigation: conflicting records, missing references, deciding what happens next.
- **A data-sharing agreement and an audit trail on both sides**, since two regulated companies are
  exchanging customer transaction data.

**Approving inside WhatsApp, later.** Owners would like to approve from their phone. That becomes
safe once Chord passes the channel-verified sender identity to tools (see field notes): the server
could then accept a decision only from a registered approver's number, still with four-eyes and a
reason. Until then, approvals stay in the signed-in console.

**Why Chord fits.** Chord already lets teammates in one workspace consult each other, and exposes
a chat API one system can use to message another company's teammate. The cross-company version
needs a scoped key and the guardrails above, not new infrastructure.

## How I used AI tools

[To write before submitting: which AI tools you used and for what. The brief asks for this
section explicitly.]

The agent itself runs entirely on Chord.

## Files

```
skill/railow-payments-desk/   SKILL.md + references/policy.md (upload to Chord)
src/domain.ts                verification and all money rules
src/console.ts               Ops Console (approvals, agent refund settings, audit, report)
src/policy.ts                agent refund authority (Chord header + console controls)
src/conversation.ts          verify once per chat: binds verification to the conversation id Chord sends
src/mcp.ts                   tool definitions Chord sees
src/paystack.ts              Paystack client (live test mode / simulated)
src/app.ts, api/index.ts     HTTP + Vercel entry
src/seed.ts, scripts/        demo riders and live seeding
test/scenarios.ts            end-to-end tests
FIELD_NOTES.md, GO_LIVE.md   submission notes
```
