# Go-live note for the Railow owner

**What it does.** When a rider says "I funded my wallet and it's not showing", the agent confirms
it's really them (a code to the phone on their account, once per chat), checks the payment with
Paystack and your wallet records, and credits a missed top-up once. Low-risk refunds up to the
limit you set in Chord (₦100,000 in this demo) it does itself. Everything else becomes a claim in
your Ops Console with the evidence; your team approves or rejects with a reason, two people from
₦50,000. Every decision is logged.

**What it does not do.** It never approves money in the chat, never refunds above your limit or
for risky cases (money already spent, amount mismatch, Paystack unreachable), and doesn't handle
ride or driver issues. Set the limit to 0 in Chord, or switch refunds off in the console, and it
stops refunding at once.

**Before going live**
- Live Paystack keys, and connect it to your real wallet system instead of the demo ledger.
- Your WhatsApp Business number through Chord, and a real SMS or WhatsApp-template provider for codes.
- Named approvers with their own logins, and cover for when they're away; claims expire after 24h.
- Start the limit low (or at 0) and raise it as you watch the audit log.
- Agree who is alerted when Paystack is down or a refund fails; set data retention (NDPA).

**Real risks.** A wrong limit costs money. A Paystack outage means riders wait, not guesses. Codes
are only as safe as the rider's SIM, so add your SIM-swap checks before raising limits. Riders
learn a team decision when they write back, until Chord supports callbacks or WhatsApp templates
are set up.
