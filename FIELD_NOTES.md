# Field notes: deploying Railow Payments Desk on Chord

I built and tested this between 21 and 24 October in the TSG Labs WhatsApp simulator. These are the three problems I learned the most from, then a few smaller ones.

## 1. The agent took back refunds it had actually made

This was the one that worried me most. In a single turn everything worked: the rider verified, the agent checked Paystack, then credited or refunded. But on the rider's next message, the agent asked for a new code and started "correcting" itself.

After Ada said "none thanks", it told her to "ignore the credit, balance and case reference I mentioned before." Bayo asked "what is my balance" after his ₦3,000 refund had gone through, and it said it "shouldn't have told you your refund was submitted." Gbenga typed "RW-1004 update" and just got another code. I saw this in four chats on 23 October.

The credit and the refund were real; my server's log showed both calls succeeding. For a payments product, telling someone their refund didn't happen when it did is about as bad as the opposite.

To find out why, I logged every tool call along with whatever Chord sends with it. There's no conversation ID anywhere, not in the headers and not in the MCP metadata, so my server couldn't tell which chat a call came from. It also looked like the agent could see its own earlier messages on a new turn but not the tool results behind them. My skill told it never to state an outcome it hadn't got from a tool, so it decided its own true messages were unsupported and withdrew them. Adding a line to the skill saying "earlier outcomes stand" didn't change anything.

What fixed it was putting the proof somewhere the agent can see: in its own messages. When a rider verifies, the server returns a short reference like V-7KQ2-M9XD, and the agent writes "Verified ✅ (ref …)" in the chat and reuses it on later turns. It runs out after 15 minutes of no messages, and a made-up one doesn't work. Every credit or refund also comes back with a one-line receipt ("✅ Railow confirmed: ₦5,000 credited…") that the agent quotes. After that change, a follow-up message went through with no new code and no retraction.

What I'd ask Chord for: send a stable conversation ID with every tool call, and say clearly in the docs whether tool results are kept between turns. If they aren't, a short summary would help, because an agent that can't see its own evidence ends up doubting it.

## 2. There's no way to hold an action for someone to approve

Railow's rule is normal for payments: the agent can refund small, low-risk cases itself, and anything else needs a person, or two people from ₦50,000. I looked for a way to do that inside Chord: teammate settings, the MCP server's menu, the Escalated and Needs review filters, and Activity → Needs you. Those are all about conversations. I couldn't find anything that pauses a tool call until someone approves it.

For comparison, Fin sends the request to the business's own system, and when the decision is made that system calls back so Fin can continue the same conversation.

I ended up building a small Ops Console next to the tools. Each claim shows the evidence, approving or rejecting needs a reason, two different people have to approve from ₦50,000, claims expire after 24 hours, and everything is logged. I took the approve tool away from the agent completely, so someone in the chat saying they're the owner has nothing to talk it into. The agent still stays in the conversation: it gives the rider a case reference and answers when they ask for an update.

Two gaps are left. Chord can't call back into the chat, so the rider only hears the decision when they message again (TSG confirmed messages into the simulator are limited). And plenty of small Nigerian businesses don't have a back office to approve things in at all.

What I'd ask Chord for: a way for a tool to say "waiting on a decision" with a callback that resumes the chat, and for businesses without their own system, built-in approvals in Needs you, with named approvers and an optional second approver above an amount.

## 3. The agent didn't know who it was talking to

In my first tests, the rider's phone number was just whatever they typed. Anyone who knew Ada's number could ask about Ada's wallet. My first design also let the owner approve refunds by messaging the same desk with a code, but in the simulator the owner's chat looked like any customer's.

The simulator connects as a partner app, and Chord's partner chat guide says the sender ID is "an app-supplied customer reference, not proof of a Chord identity." I couldn't find a way to pass a verified sender through to tools; the model fills in the number itself.

So I built it around what the server can check. The code goes to the phone registered on the account, not to the chat, and the reply is the same whether or not the account exists, so you can't use the chat to find out who's a customer. Codes expire, work once and lock after three wrong tries, and a badly typed number gets caught before anything is sent.

What I'd ask Chord for: pass the verified WhatsApp number to tools in a field the model can't change. Then most chats wouldn't need a code at all, and an approver's own phone could be trusted.

## Smaller things

The refund limit has to be typed into Custom headers as `X-Railow-Agent-Refund-Limit: 100,000`. A typo in the name does nothing, and an extra zero gives the agent ten times the authority. My server treats anything it can't read as off. It would be better if an MCP server could declare proper settings that Chord shows as fields.

When I updated the skill, the old and new versions were both attached at once with no warning. The agent mixed the two sets of instructions, told a rider a code was wrong without checking it, and went round in circles.

My receipt line started with ✅ and showed up in WhatsApp as "âś…". The server wasn't saying the reply was UTF-8 and Chord's client guessed wrong. I fixed it on my side, but ₦ and Yoruba, Igbo or Hausa letters would hit the same problem.

I couldn't find documentation for where a skill-based teammate's handover rules go; the escalation guide still describes the older procedures.

Not Chord's fault, but worth saying: my tests passed on an in-memory store and then the live database read data slightly differently and crashed the console. A diagnose page that checks each dependency directly found that, and an earlier suspended database account.

## Credits

| Date | Credits left | Used on |
|---|---|---|
| 21–22 Oct | 0 | waiting for credits, building offline |
| 23 Oct | 50 | credits added, simulator connected |
| 23 Oct | 48 | first test rounds |
| 24 Oct | 45 | full test round and demo recording |
