# Go-live note for the Railow owner

**What it does.** When a rider says "I funded my wallet and it's not showing", the desk first
confirms it is really them with a code sent to the phone on their Railow account (once per chat; it lapses after 15 quiet minutes). It then checks
the payment with Paystack and your wallet records. If the payment went through and the wallet
missed it, it credits the wallet on the spot, once. If the payment failed or is still pending, it
explains that clearly. Refunds up to the limit you set in Chord (₦100,000 in this demo) are done
by the desk itself, but only for low-risk cases it can prove; everything else becomes a claim in
your Ops Console with the evidence and a recommendation. Your team approves or rejects there, with
a reason; claims of ₦50,000 and above need two people. Every
decision is logged, and the console has a daily exceptions report.

**What it does not do.** It never refunds above your limit or for risky cases, and nobody can
approve a claim from the chat. Set the limit to 0 in Chord, or flip the switch in the Ops Console, and it stops refunding entirely. It does not handle ride, driver or account problems; those go to a person. It
cannot see your bank's side of a transfer, only what Paystack reports.

**Before it goes live with real riders**
- Switch Paystack from test to **live keys**, and connect the desk to your real wallet system
  instead of the demo ledger.
- Connect your **WhatsApp Business number** through Chord, and a real **SMS (or WhatsApp
  authentication template) provider** for verification codes. WhatsApp only allows free-form
  replies within 24 hours of the rider's last message; outcome updates need approved templates.
- Decide **who the approvers are**, give each their own login, and who covers when they are away.
  Claims expire after 24 hours, so someone must check the console daily.
- Confirm the **limits**: agent refunds up to the amount set in Chord, automatic wallet credit up
  to ₦100,000, two approvers from ₦50,000. Start low (or at 0) and raise them as you watch the
  audit log.
- Agree **alerts**: who is told when Paystack is unreachable, a refund fails, or a claim expires.
  All three already show in the console's "Needs attention" list and daily report.
- Check your **data obligations**: the desk handles names, phone numbers and payment details
  (Nigeria Data Protection Act). Keep the minimum and set how long case records are kept.

**Real risks.** A wrong limit costs money; start low and raise it. If Paystack is down, riders are
told to try later rather than given a guess, so expect a spike in waiting cases. Verification is
only as strong as the rider's SIM: SIM-swap fraud is a known Nigerian risk, so pair it with your
existing device and SIM-change checks before raising limits.
