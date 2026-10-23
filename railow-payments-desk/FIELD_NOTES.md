# Deployment field notes

> **Working log.** Add an entry the moment something breaks: paste the exact error, screenshot it,
> note the time. Before submitting, keep the 2–3 most instructive problems and delete the rest.
> Each entry below carries a status. Only submit an entry once its behaviour is confirmed on Chord.

Format for each problem:
**What happened** (exact error) · **How I found the cause** · **Fix or workaround** ·
**What I'd change in Chord, its docs or API**

---

## 1. Owner decisions failed schema validation because owners type in capitals
*Status: hit in my own end-to-end tests. Chord behaviour still to confirm.*

**What happened.** Relaying `APPROVE RW-1006 …` failed before reaching my code:
`MCP error -32602: Input validation error: Invalid arguments for tool decide_claim: Invalid option:
expected one of "approve"|"reject" at decision`.
**How I found it.** The test client threw on the tool result; the message named the enum.
**Fix.** Made `decision` a plain string; the server normalises case and still rejects anything
other than approve/reject.
**Feedback for Chord.** *(after testing on Chord)* Does a tool-validation error reach the agent so
it can recover, or does the turn fail? Showing it in "Why this reply" would save builders time.

## 2. No documented way to set handover conditions for a skill-based teammate
*Status: confirmed in docs and app UI (21 Oct). Runtime behaviour to test once credits arrive.*

**What I found.** The Escalation rules guide defines conditions as procedures tagged `escalation`.
The Procedures guide says procedures are the legacy API for teammates not yet migrated to skills,
and the Skill files guide says migration disables legacy procedure injection; it mentions
handover only as something to "check" in staging. In the app, teammate settings show
Collaboration, Allowed links, Tools, Channels and Lifecycle, with no escalation section.
**Workaround.** The skill has a "Hand over to a human when" section. *(Record whether
`handover_to_human` actually fires from it, and the exact thread state you see.)*
**Feedback for Chord.** One page stating where a skill-based teammate's handover conditions live,
with a worked example.

## 3. Amount-based escalation cannot see amounts from tools
*Status: confirmed in docs. A design constraint, not a runtime failure; keep only if space allows.*

`AMOUNT_THRESHOLD` matches amounts written in the customer's message, and stored escalation rules
are off by default (creating one returns `ESCALATION_RULES_DEPRECATED`). A rider who writes "I
funded my wallet" never trips a ₦ limit even when the tool shows ₦150,000. **Workaround:** limits
live in the MCP server. **Feedback:** let handover conditions reference tool-result fields.

## 4. Proactive follow-up into the simulator conversation
*Status: docs suggest not supported; asked TSG Labs on 21 Oct, awaiting reply.*

The simulator connects as a partner app. The partner chat guide says the initial contract supports
synchronous text sends and paginated history only, and does not mention outbound messages.
Scheduled `MESSAGE` tasks list WhatsApp and Direct Line routes but not partner threads.
**Workaround:** pending payments are explained; the rider rechecks with their case reference.
*(Update with TSG's answer.)*

## 5. Tools cannot verify who the rider is
*Status: confirmed in docs.*

The partner chat guide states that `sender_id` is a reference supplied by the app, not proof of
identity, and no guide describes passing the verified sender to MCP tools: the model fills in the
phone number. **Workaround:** the money paths are safe even if the model is fooled (credits only go
to the rightful owner of a verified payment; refunds need an owner code the model never sees).
**Feedback:** pass the channel-verified sender to tool calls as a header the model cannot set.

## Observed in the app (21 Oct), not problems

- Credits showed 0 on login, so nothing can be tested until TSG adds them.
- The default "Chord Assistant" teammate runs on legacy instructions and offers an import to skills.
- Chord already has a first-party **Paystack** tool, plus "Custom tools (API)" via OpenAPI import.
  I still used a custom MCP server because the money rules (re-verify, credit once atomically,
  owner codes the model never sees) must run in code, not as separate model-chosen calls.
- Teammates can **consult each other** (Collaboration → "Accept requests from teammates").

## Credits log

| Date | Credits left | What used them |
|---|---|---|
| 21 Oct | 0 | waiting for TSG to add credits |
