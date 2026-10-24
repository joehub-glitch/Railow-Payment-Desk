# Railow Payments Desk

A Chord agent on WhatsApp that sorts out failed wallet top-ups for Railow, a made-up Lagos
ride-hailing app. It checks who the rider is, checks the payment on Paystack (test mode) against
the wallet, credits or refunds when that's safe and within the limit the business sets in Chord,
and sends everything else to a small approval console.

Submission notes: [FIELD_NOTES.md](FIELD_NOTES.md) · [GO_LIVE.md](GO_LIVE.md) · design and rules:
[docs/DESIGN.md](docs/DESIGN.md)

## Tools (MCP)

| Tool | Does |
|---|---|
| `start_verification` | Sends a one-time code to the phone registered on the account (same answer either way) |
| `verify_rider` | Checks the code; returns a readable verification ref (e.g. `V-7KQ2-M9XD`) the agent shows once and reuses for the rest of the chat (15 quiet minutes ends it) |
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
src/conversation.ts          ready to tie verification to a chat if Chord sends a conversation id (it does not yet)
src/mcp.ts                   tool definitions Chord sees
src/paystack.ts              Paystack client (live test mode / simulated)
src/app.ts, api/index.ts     HTTP + Vercel entry
src/seed.ts, scripts/        demo riders and live seeding
test/scenarios.ts            end-to-end tests
FIELD_NOTES.md, GO_LIVE.md   submission notes
docs/DESIGN.md               rules, approvals, safety, vision
```
