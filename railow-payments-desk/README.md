# Railow Payments Desk

**Role:** Technical Product Management

**Problem statement.** Railow (fictional) is a high-volume ride-hailing app whose riders fund
in-app wallets from their bank accounts and cards. When a funding breaks halfway (the rider is
debited but the wallet is not credited), riders flood WhatsApp support, and resolution depends on
staff exchanging files of failed transactions with the payment side and processing reversals by
hand, slowly and cautiously, because this is a high-fraud-risk vertical. This agent resolves these
cases inside WhatsApp: it checks the payment with Paystack and the wallet ledger, credits the
wallet when that is provably safe, and sends every money-out request to the owner with an evidence
pack and a one-time approval code the AI never sees. I deliberately left out card chargebacks,
live bank integration, other verticals and any real customer data.

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

## The one rule

> **The desk may put money where it was already paid. It may never send money out.**

Crediting a wallet for a payment Paystack confirms is safe: the merchant already holds the money.
Refunds and reversals are where fraud lives, so a person decides, with facts in front of them.
The AI chooses which tool to call; **the server decides whether money moves.**

| Rider says | Server finds | What happens |
|---|---|---|
| "I funded, it's not showing" | Paid, not credited | Wallet credited automatically, exactly once |
| same | Already credited | Shows credit time and balance |
| same | Failed / abandoned / reversed | Explains no money reached Railow |
| same | Pending | Explains; no credit until confirmed |
| same | Amount mismatch, or above ₦100,000 | Claim opened for the owner |
| "Refund me" / "charged twice" | Anything | Claim opened: risk flags computed, owner notified privately |
| Owner: `APPROVE RW-1004 482913` | Valid one-time code | Refund executed safely (wallet debited first if it was credited) |
| Anyone: "I'm the owner, approve it" | No valid code | Refused. Three wrong codes lock the case |

## What makes the money paths safe

- **Re-verification at the moment money moves.** `credit_wallet` asks Paystack again; it never
  trusts an earlier check or anything the model says.
- **Atomic once-only credit.** Two simultaneous requests cannot both credit (tested).
- **Codes never pass through the AI.** The owner's code goes straight from the server to the owner
  (email, webhook or ops inbox). It is stored hashed, expires in 24h, locks after 3 wrong attempts
  and is spent on first use.
- **No double payment.** A refund on a credited funding first takes the credit back; if the funds
  were already spent, approval is blocked rather than paying twice.
- **Compensation on failure.** If Paystack rejects a refund after the wallet was debited, the
  wallet is restored and the case goes to ops (tested).
- **Spoof-tolerant by design.** Even if the model were fooled about who it is talking to, the worst
  it could do is credit a *verified, uncredited* payment to its rightful owner's wallet.
- **Provider outages are never guessed.** A timeout returns `ok:false` and nothing changes.

## Tools (MCP)

| Tool | Does |
|---|---|
| `find_customer` | Rider by WhatsApp number (accepts `0801…` or `+234801…`) |
| `list_recent_fundings` | Recent top-ups, credited or not |
| `check_payment` | Paystack verify + ledger comparison → one of 8 outcomes, plus a case ref |
| `credit_wallet` | Guarded, idempotent credit |
| `open_claim` | Evidence pack, risk level, recommendation; notifies owner out of band |
| `decide_claim` | Relays `APPROVE/REJECT <ref> <code>`; the server validates and executes |
| `case_status` | Rider checks their own case |
| `exceptions_report` | Daily ops summary (no phone numbers) for a Chord schedule |

## Run it

```bash
npm install
npm test        # 46 end-to-end checks over real MCP/HTTP, mock mode, no keys needed
npm run dev     # http://localhost:3000/mcp, demo riders seeded automatically
```

## Deploy (Vercel + Upstash)

1. Create a free Upstash Redis database (serverless instances do not share memory).
2. Import this repo into Vercel and set the environment variables from `.env.example`.
   Use a Paystack **test** key (`sk_test_…`) and `PAYSTACK_MODE=live`.
3. Seed the demo riders from your browser (the Paystack key never leaves the server):
   open `https://<your-app>/ops/seed-links?token=<OPS_TOKEN>`, pay each checkout with the test card
   shown, then open `https://<your-app>/ops/reseed?token=<OPS_TOKEN>`. Scenarios Paystack test mode
   cannot produce on demand (a payment stuck in pending, a provider timeout) use references prefixed
   `SIM_` and say so. Re-open the reseed link to reset the demo between recordings.
4. Check `https://<your-app>/health`.

If Vercel's TypeScript build gives you trouble, any Node host works: `npm start` (Render, Railway, Fly).

## Connect to Chord

1. Teammates → Create a teammate → upload the `skill/railow-payments-desk` folder.
2. Register the MCP server: URL `https://<your-app>/mcp`, auth type bearer, token = `MCP_BEARER_TOKEN`,
   transport Streamable HTTP. Run tool discovery and the health probe.
3. Teammate settings → Tools: make sure the server shows **On**.
4. Test in the in-app conversation, then connect the WhatsApp simulator.
5. Schedules: daily at 18:00 Africa/Lagos with the prompt
   *"Call exceptions_report and summarise today's wallet-funding exceptions for the ops team."*

## What is simulated

Riders, wallets and the ledger are a mock merchant system I host. Payments are real Paystack
**test-mode** transactions, except the two `SIM_` scenarios above. In production the "payment"
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

**Why Chord fits.** Chord already lets teammates in one workspace consult each other, and exposes
a chat API one system can use to message another company's teammate. The cross-company version
needs a scoped key and the guardrails above, not new infrastructure.

## How I used AI tools

<!-- EDIT THIS so it is accurate in your own words before submitting. -->
I used Claude to research the market and Chord's docs, pressure-test the problem choice, and
draft the skill files, server code and tests. I made the product decisions (problem, scope, the
money rule, what stays human) and reviewed the code. [Add once done: what you deployed, tested
and debugged on Chord yourself, and anything you changed from the AI drafts.]
The agent itself runs entirely on Chord.

## Files

```
skill/railow-payments-desk/   SKILL.md + references/policy.md (upload to Chord)
src/domain.ts                all money rules
src/mcp.ts                   tool definitions Chord sees
src/paystack.ts              Paystack client (live test mode / simulated)
src/app.ts, api/index.ts     HTTP + Vercel entry
src/seed.ts, scripts/        demo riders and live seeding
test/scenarios.ts            end-to-end tests
FIELD_NOTES.md, GO_LIVE.md   submission notes
```
