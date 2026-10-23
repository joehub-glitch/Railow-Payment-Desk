# Deployment field notes

> **Working log.** Add an entry the moment something breaks: paste the exact error, screenshot it,
> note the time. Before submitting, keep the 2–3 most instructive problems and delete the rest.
> Each entry carries a status. Only submit an entry once its behaviour is confirmed on Chord.

Format for each problem:
**What happened** (exact error) · **How I found the cause** · **Fix or workaround** ·
**What I'd change in Chord, its docs or API**

---

## 1. The agent could not tell who it was talking to, rider or owner
*Status: found while testing in the simulator (23 Oct). Strongest candidate.*

**What happened.** Two things showed up in the first simulator conversations. First, the rider's
phone number was whatever they typed: anyone who knew Ada's number could have asked about Ada's
balance and fundings. Second, my first design let the owner approve refunds by messaging the same
desk (`APPROVE RW-1004 <code>`), but in the simulator the "owner" chat was indistinguishable from any
customer chat. The one-time code kept money safe, but the customer-facing agent still had an
approve tool.
**How I found the cause.** The simulator connects as a partner app. Chord's partner chat guide
says `sender_id` is "an app-supplied customer reference, not proof of a Chord identity", and no
guide describes passing a verified sender to MCP tools: the model fills in the phone number itself.
**Fix.** Redesigned both paths around what the server can prove:
- **Rider identity:** `start_verification` sends a one-time code to the phone *registered on the
  Railow account*; `verify_rider` returns a 15-minute session that every other tool requires. Same
  answer whether or not an account exists, so the chat cannot be used to discover customers.
- **Approvals:** removed the approve tool from the agent entirely (see note 3 for where they went).
**Feedback for Chord.** Pass the channel-verified sender (the WhatsApp number Chord already knows)
to tool calls in a field the model cannot set. Builders would not need to bolt on their own OTP, and
approvals from a registered approver's phone would become safe.

## 2. On the next message, the agent took back money actions it had really made
*Status: reproduced in 4 simulator chats (23 Oct, 7:40–8:00pm); confirmed with the server's tool log.*

**What happened.** Within one turn everything worked: verify, check, credit or refund. On the
rider's next message the agent asked for a new code and "corrected" itself:
- Ada, after "none thanks": *"please ignore the credit, balance and case reference I mentioned."*
- Bayo, after "what is my balance" (his ₦3,000 refund had gone through): *"I shouldn't have told you
  your refund was submitted … I hadn't confirmed that with our system."*
- Gbenga typed "RW-1004 update" and got a new code instead of an update.
The tool log shows the credit and refund calls succeeded (`credit_wallet → credited`,
`refund_payment → refunded`); the retractions were false.
**How I found the cause.** I logged every tool call and the request Chord sends with it. There is
no conversation or thread id in any header and no `_meta` (only the bearer token, my custom
header, and the hosting provider's own headers, from `Java-http-client/23.0.2`). So the server
cannot tell which chat a call belongs to, and the agent apparently cannot see earlier tool results
on a new turn, only its own earlier text. With "never state an outcome you did not get from a tool
in this conversation" in the skill, it judged its own true messages unsupported and took them back.
A skill rule ("earlier outcomes stand", "call the tools without a session") did not fix it.
**Workaround.** Put the state where the agent can see it: its own messages.
- Verification returns a readable ref (`V-7KQ2-M9XD`); the agent ends that reply with
  `Verified ✅ (ref …)` and reuses it on later turns. It expires after 15 quiet minutes.
- Every money result carries a receipt line (`✅ Railow confirmed: ₦5,000 credited … Case RW-1001.`)
  that the agent quotes; the skill says ✅ lines came from the server and are never retracted.
**Feedback for Chord.**
1. Send a stable conversation id with every tool call (a header or MCP `_meta`), so servers can
   keep per-chat state such as "this rider is verified" without showing anything to the customer.
2. Document whether tool results stay in the model's context on later turns. If they are dropped,
   keep a summary, because an agent that cannot see its own evidence will disown it.

## 3. A business that wants a person to approve the agent's bigger actions has to build its own back office
*Status: checked in the app (23 Oct): teammate settings, the MCP server's actions, the Escalated /
Needs review filters and Activity → Needs you.*

**What happened.** Railow's rule is ordinary for a payments business: the agent refunds low-risk
cases up to ₦100,000 on its own; everything else goes to a person, and to two people from ₦50,000. I
looked for a way to do that inside Chord. Teammate settings offer Collaboration, Allowed links,
Tools, Channels and Lifecycle. The MCP server's menu offers Health, Tools, Prompts, Edit and Delete,
and its tool list has no "requires approval" switch per tool. The inbox can filter conversations by
Escalated and Needs review, and Activity has a "Needs you" list, but I found nothing that holds a
tool call (an action) until a named person approves it.
**What it cost.** I built a small signed-in Ops Console on the tool server: claims with the
evidence, approve/reject with a reason, two approvers from ₦50,000, expiry, audit log. This is the
same shape as Fin's human-in-the-loop approvals: Fin sends the request to "an external system of
your choice", the business decides there, and its system calls a per-conversation callback URL so
Fin resumes the conversation with the outcome. Two differences matter:
- Fin has the **callback**: the decision flows back into the same conversation. Chord has no
  equivalent I could find, so the rider only hears the outcome when they write again (note 6).
- Fin still assumes the business **has** a system to decide in. Many Nigerian SMEs, such as a
  pharmacy, a school or a small logistics firm, do not, so each builder rebuilds the same approval
  screen.
**What still works well.** The agent never leaves the conversation: it opens the case, gives the
rider a reference and keeps answering ("any update?" → `case_status`). Only a request for a person,
legal threats or abuse cause a full handover.
**Feedback for Chord.** Two steps, smallest first:
1. **A resume callback** (Fin's model): a tool can say "waiting on a decision"; the business's
   system later posts the outcome to a per-conversation URL and the agent tells the customer in the
   same thread. Merchants with a back office are covered.
2. **Native action approvals**, for merchants without one:
   - A tool (or a rule on it, e.g. `refund_payment` above ₦X) can return **needs approval**
     instead of running.
   - Chord pauses that action and shows it in **Needs you** with the tool's evidence, to named
     approvers, with an optional second approver above an amount.
   - On approve, Chord runs the call and the agent tells the customer in the same thread; on
     reject, the agent explains. Every decision is logged.
This gives every builder maker-checker without a back office, and keeps the money decision next to
the conversation it came from.

## 4. A business setting (the refund limit) can only be set as a raw header
*Status: confirmed in the app UI (23 Oct, Admin → Channels & Tools → Add MCP server).*

**What happened.** I wanted the business owner to set, in Chord, how much the agent may refund on
its own. The only place to configure an MCP server per workspace is the free-text **Custom headers**
box, so the owner has to type `X-Railow-Agent-Refund-Limit: 100,000` exactly. A typo in the header
name silently does nothing, and a typo in the amount (`1,000,000`) would grant ten times the
authority.
**How I found it.** Looked for a typed setting on the MCP server form; there is Name, URL, Auth,
Transport, Allowed tools and Custom headers only.
**Workaround.** The server reads the header, accepts `100,000` / `₦100,000` / `100000`, treats a
missing or unreadable value as **off** (fail closed), and caps it at a hard ceiling. The Ops Console
shows the value Chord last sent, and adds the ops team's own kill switch and lower limit; the
stricter control wins and every change is audit-logged.
**Feedback for Chord.** Let an MCP server declare its own settings (name, type, default, e.g.
"Refund limit, ₦, default 0") and render them as proper fields in the server's settings page, with
validation and a change history. Business owners would then configure agent authority without
typing headers.

## 5. No documented way to set handover conditions for a skill-based teammate
*Status: confirmed in docs and app UI (21 Oct). Runtime behaviour still to test.*

**What I found.** The Escalation rules guide defines conditions as procedures tagged `escalation`.
The Procedures guide says procedures are the legacy API for teammates not yet migrated to skills,
and the Skill files guide says migration disables legacy procedure injection; it mentions
handover only as something to "check" in staging. In the app, teammate settings show
Collaboration, Allowed links, Tools, Channels and Lifecycle, with no escalation section.
**Workaround.** The skill has a "Hand over to a human when" section. *(Record whether
`handover_to_human` actually fires from it, and the exact thread state you see.)*
**Feedback for Chord.** One page stating where a skill-based teammate's handover conditions live,
with a worked example.

## 6. No proactive follow-up into the simulator conversation
*Status: confirmed by TSG Labs on 23 Oct ("limitations to scheduled tasks especially in the
context of the simulator").*

**What happened.** I wanted the desk to recheck a pending payment, and to tell a rider when their
claim was decided, without them writing again. The partner chat guide describes only synchronous
replies and paginated history, and scheduled `MESSAGE` tasks list WhatsApp and Direct Line routes
but not partner threads.
**How I found the cause.** Docs review, then asked TSG Labs before building it (21 Oct); they
confirmed the limitation (23 Oct).
**Workaround.** Pending payments and claims get a case reference; the rider checks back with
`case_status`. The daily exceptions report moved into the Ops Console instead of a Chord schedule.
**Feedback for Chord.** State in the scheduling and partner-chat guides which delivery routes reach
partner-app threads, so builders know before designing around proactive follow-ups.

## 7. Amount-based escalation cannot see amounts from tools
*Status: confirmed in docs. A design constraint, not a runtime failure; keep only if space allows.*

`AMOUNT_THRESHOLD` matches amounts written in the customer's message, and stored escalation rules
are off by default (creating one returns `ESCALATION_RULES_DEPRECATED`). A rider who writes "I
funded my wallet" never trips a ₦ limit even when the tool shows ₦150,000. **Workaround:** limits
live in the MCP server. **Feedback:** let handover conditions reference tool-result fields.

## 8. Deployment: the database error hid the real cause (not Chord; keep only if space allows)
*Status: hit on 23 Oct.*

**What happened.** Seeding failed with `Internal Server Error`, then `res.map is not a function`.
**How I found the cause.** Added a `/ops/diagnose` page that checks each dependency and pings the
database directly, bypassing the client library. Its raw reply showed the real error: the Upstash
account behind the database was suspended. The client library's automatic pipelining expected an
array and turned the provider's error message into `res.map is not a function`.
**Fix.** Moved to a separate Redis database created through Vercel's storage integration, turned
off auto-pipelining so provider errors surface verbatim, and kept the diagnose page.

## Small: emoji and ₦ in tool results arrived garbled
*Status: seen 23 Oct, 9:15pm.* My receipt line started with ✅; the agent's WhatsApp reply showed
`âś…` (the UTF-8 bytes read as Windows-1250). The MCP SDK sends `application/json` without a charset
and Chord's client (`Java-http-client`) did not default to UTF-8, which JSON requires. **Fix:** the
server now sends `charset=utf-8` explicitly. **Feedback:** decode MCP responses as UTF-8 by default;
₦ and Yoruba/Igbo/Hausa diacritics will hit the same bug.

## Observed in the app (21 Oct), not problems

- Credits showed 0 on login, so nothing could be tested until TSG added them.
- The default "Chord Assistant" teammate runs on legacy instructions and offers an import to skills.
- Chord already has a first-party **Paystack** tool, plus "Custom tools (API)" via OpenAPI import.
  I still used a custom MCP server because the money rules (verify the rider, re-verify the
  payment, credit once atomically, no approvals from the chat) must run in code, not as separate
  model-chosen calls.
- Teammates can **consult each other** (Collaboration → "Accept requests from teammates").

## Credits log

| Date | Credits left | What used them |
|---|---|---|
| 21 Oct | 0 | waiting for TSG to add credits; emailed account address and design question |
| 22 Oct | 0 | no reply yet; kept building offline |
| 23 Oct | 50 | credits added, simulator access via Connected Apps; 5-day window starts |
| 23 Oct | 49.24 | first simulator test (paid but not credited, then repeat credit) |
| 23 Oct | 48 | v2 tests: skill conflict loop (Ife), credit then retraction (Ada) |
