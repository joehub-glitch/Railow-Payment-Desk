# Go-live note for the Railow owner

**What it does.** When a rider says "I funded my wallet and it's not showing", the desk checks the
payment with Paystack and your wallet records. If the payment went through and the wallet missed
it, it credits the wallet on the spot, once. If the payment failed or is still pending, it explains
that clearly. Anything that would send money **out** (refunds, reversals, duplicate charges) comes
to you with the evidence and a recommendation. You reply on WhatsApp with the one-time code we send
you. Every case gets a reference, and you get a daily summary at 6pm.

**What it does not do.** It never refunds or reverses on its own. It does not handle ride, driver
or account problems; those go to a person. It cannot see your bank's side of a transfer, only what
Paystack reports.

**Before it goes live with real riders**
- Switch Paystack from test to **live keys**, and connect the desk to your real wallet system
  instead of the demo ledger.
- Connect your **WhatsApp Business number** through Chord. WhatsApp only allows free-form replies
  within 24 hours of the rider's last message; later follow-ups need pre-approved templates.
- Decide **who receives approval codes** (named people, email or a private channel) and who covers
  when they are away. Codes expire after 24 hours.
- Confirm the **limits**: automatic credit up to ₦100,000 per funding is a starting point.
- Make sure Chord passes the rider's **verified WhatsApp number** to the tools, not a number typed
  into the conversation.
- Agree **alerts**: who is told when Paystack is unreachable, a refund fails, or a case is locked
  after wrong codes. All three already appear in the daily report.
- Check your **data obligations**: the desk handles names, phone numbers and payment details
  (Nigeria Data Protection Act). Keep the minimum and set how long case records are kept.

**Real risks.** A wrong limit costs money; start low and raise it. If Paystack is down, riders are
told to try later rather than given a guess, so expect a spike in waiting cases. Approval by WhatsApp
is only as safe as the owner's phone; treat codes like a bank OTP.
