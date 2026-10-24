# Deployment field notes: Railow Payments Desk on Chord

Built and tested 21–24 Oct 2026 in the TSG Labs WhatsApp simulator. Three problems taught me the
most; the rest are short notes at the end. Each one: what happened, how I found the cause, what I
did, and what I'd change in Chord.

---

## 1. On the next message, the agent took back money actions it had really made

**What happened.** Within a single turn everything worked: verify the rider, check Paystack,
credit or refund. On the rider's *next* message the agent asked for a new code and "corrected"
itself. I reproduced it in four chats on 23 Oct:
- Ada, after "none thanks": *"please ignore the credit, balance and case reference I mentioned."*
- Bayo, after "what is my balance" (his ₦3,000 refund had gone through): *"I shouldn't have told you
  your refund was submitted … I hadn't confirmed that with our system."*
- Gbenga typed "RW-1004 update" and got a new code instead of an update.

The server's tool log shows the calls succeeded (`credit_wallet → credited`,
`refund_payment → refunded`). The retractions were false, and in a payments product a false "your
refund didn't happen" is as damaging as a false "it did".

**How I found the cause.** I logged every tool call and the request Chord sends with it. There is no
conversation or thread id anywhere: no header, no MCP `_meta`. Only my bearer token, my custom
header and the host's own headers arrive (client: `Java-http-client/23.0.2`). So the server cannot
tell which chat a call belongs to. And on a new turn the agent apparently sees its own earlier text
but not the tool results behind it. My skill said "never state an outcome you did not get from a
tool in this conversation", so the agent judged its own true messages unsupported and withdrew
them. Adding skill rules ("earlier outcomes stand") did not fix it.

**What I did.** Put the state where the agent *can* see it: in its own messages.
- Verification returns a short, readable reference (`V-7KQ2-M9XD`). The agent ends that reply with
  `Verified ✅ (ref …)` and passes the ref on later turns; it expires after 15 quiet minutes, and a
  made-up ref is refused.
- Every money result carries a receipt line (`✅ Railow confirmed: ₦5,000 credited to your wallet.
  Balance ₦6,200. Case RW-1001.`). The agent quotes it, and the skill says ✅ lines came from the
  server and are never retracted.

After the change, a follow-up message reused the ref with no new code and no retraction.

**What I'd change in Chord.**
1. Send a stable conversation id with every tool call (a header or MCP `_meta`). Servers could then
   keep per-chat state such as "this rider is verified" without showing anything to the customer.
2. Document whether tool results stay in the model's context on later turns. If they are dropped,
   keep a summary: an agent that cannot see its own evidence will disown it.

## 2. Approving the agent's bigger actions needs a back office Chord doesn't provide

**What happened.** Railow's rule is ordinary for payments: the agent refunds low-risk cases up to
₦100,000 itself; anything else goes to a person, and to two people from ₦50,000. I looked for a way
to hold an action for approval inside Chord. Teammate settings offer Collaboration, Allowed links,
Tools, Channels and Lifecycle; the MCP server's menu offers Health, Tools, Prompts, Edit and Delete,
with no "requires approval" switch per tool. The inbox filters (Escalated, Needs review) and
Activity → "Needs you" are about conversations, not about a pending tool call.

**How I found it.** Went through each of those screens on 23 Oct, then compared with Fin. Fin's
human-in-the-loop approvals send the request to "an external system of your choice", and that system
calls a per-conversation callback URL so Fin resumes the chat with the outcome.

**What I did.** Built a small signed-in Ops Console next to the tools: each claim shows the
evidence the server computed, approve or reject needs a written reason, two different approvers from
₦50,000, claims expire after 24 hours, everything is audit-logged. Approvals never happen in the
chat; the agent has no approve tool at all, so a customer claiming to be "the owner" has nothing to
talk it into. The agent stays in the conversation: it gives a case reference and answers "any
update?" with `case_status`.

Two gaps remain. Chord has no callback, so the rider only hears the decision when they write
again (TSG Labs confirmed proactive messages into the simulator are limited). And many Nigerian
SMEs, such as a pharmacy, a school or a small logistics firm, have no back office to approve in at
all.

**What I'd change in Chord.**
1. **A resume callback:** a tool can return "waiting on a decision"; the business's system later
   posts the outcome to a per-conversation URL and the agent tells the customer in the same thread.
2. **Built-in action approvals** for merchants without a back office: a tool, or a rule on it (e.g.
   `refund_payment` above ₦X), returns "needs approval"; Chord shows it in "Needs you" with the
   evidence, to named approvers, with an optional second approver above an amount; on approve it
   runs the call and the agent continues the chat.

## 3. The agent couldn't tell who it was talking to

**What happened.** In my first simulator tests the rider's phone number was simply whatever they
typed, so anyone who knew Ada's number could ask about Ada's balance. My first design also let the
owner approve refunds by messaging the same desk with a one-time code, but the "owner" chat looked
exactly like any customer chat.

**How I found the cause.** The simulator connects as a partner app. Chord's partner chat guide says
`sender_id` is "an app-supplied customer reference, not proof of a Chord identity", and no guide
describes passing a verified sender to tools: the model fills in the phone number itself.

**What I did.** Redesigned around what the server can prove. `start_verification` sends a code to
the phone *registered on the account* and gives the same answer whether or not an account exists, so
the chat can't be used to discover customers. Codes expire, work once and lock after 3 tries; a
mistyped number is caught by format before anything is sent. The approve tool was removed from the
agent (see note 2).

**What I'd change in Chord.** Pass the channel-verified sender (on WhatsApp, the number Chord
already knows) to tool calls in a field the model cannot set. Builders wouldn't need their own OTP
for every chat, and a registered approver's phone could safely approve.

---

## Shorter notes

- **Business settings are a raw header.** The owner sets the agent's refund limit by typing
  `X-Railow-Agent-Refund-Limit: 100,000` into Custom headers. A typo in the name silently does
  nothing; a typo in the amount grants ten times the authority. The server fails closed and caps it.
  *Ask:* let an MCP server declare typed settings that Chord renders as validated fields.
- **Two versions of a skill ran at once.** After an update, the old and new skill were both
  attached with conflicting instructions, with no warning. The agent mixed them, told a rider a code
  was wrong without checking it, and looped on verification. *Ask:* warn when two attached skills
  overlap, or replace by name.
- **✅ and ₦ arrived garbled.** Replies showed `âś…`: the MCP SDK sends `application/json` without a
  charset and Chord's client didn't default to UTF-8, which JSON requires. Fixed by sending
  `charset=utf-8`. *Ask:* decode as UTF-8 by default; ₦ and Yoruba/Igbo/Hausa letters hit the same bug.
- **Handover conditions for skill teammates aren't documented.** The escalation guide uses legacy
  procedures, which skills replace. *Ask:* one page with a worked example.
- **Amount-based escalation reads only the customer's text**, not amounts from tools, so "I funded my
  wallet" never trips a ₦ limit. Limits live in the server instead.
- **Not Chord:** the live database decoded list items differently from my in-memory test store
  ("RW-1001" crashed the console), and a suspended database account first showed as
  `res.map is not a function`. A `/ops/diagnose` page that pings each dependency found both.

## Credits log

| Date | Credits left | What used them |
|---|---|---|
| 21–22 Oct | 0 | waiting for credits; built and tested offline |
| 23 Oct | 50 | credits added; simulator access via Connected Apps |
| 23 Oct | 49.24 | first simulator test |
| 23 Oct | 48 | v2 tests: skill conflict loop, credit then retraction |
| 24 Oct | 45 | full test round and the recorded demo |
