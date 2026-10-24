# Go-live note for Railow

The desk handles one thing: a rider whose wallet top-up went wrong. It checks it's really them with a code to the phone on their account, checks the payment on Paystack against the wallet, and credits the wallet if the money came in but didn't show. It refunds on its own only for low-risk cases under the limit you set in Chord (₦100,000 here). Everything else goes to your Ops Console, and anything from ₦50,000 needs two approvers.

It never approves money from the chat. It won't refund if the rider has already spent the money or the amounts don't match, and it doesn't handle ride or driver problems. If a payment failed, it tells the rider no money reached Railow and to try again. If Paystack isn't answering, it says it can't check right now rather than guessing. To stop it refunding, set the limit to 0 in Chord or switch it off in the console.

Before real riders use it, you need:

- live Paystack keys and a link to your real wallet system;
- your WhatsApp Business number connected in Chord;
- a real SMS or WhatsApp provider for the codes;
- named approvers who check the console daily (claims expire after 24 hours).

Failed refunds, Paystack outages and expired claims already show under "Needs attention" in the console. Decide who gets those alerts by email or Slack. Start with a low limit and raise it as you watch the audit log, and keep your SIM-swap checks in place, because a code is only as safe as the rider's SIM.
