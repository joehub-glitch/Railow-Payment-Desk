# Go-live note for Railow

The desk handles one thing: a rider who topped up their wallet and something went wrong. It checks it's really them with a code to the phone on their account, looks at the payment on Paystack and at the wallet, and credits the wallet if the money came in but didn't show. It will refund on its own only for low-risk cases under the limit you set in Chord (₦100,000 in this demo). Everything else lands in the Ops Console for your team, and anything from ₦50,000 needs two people to approve.

It won't approve anything from the chat, won't refund if the rider has already spent the money or the amounts don't match, and won't guess when Paystack isn't answering. Ride and driver problems go to a person. If you want it to stop refunding, set the limit to 0 in Chord or switch it off in the console.

Before real riders use it, you'd need live Paystack keys and a link to your actual wallet system, your WhatsApp Business number on Chord, and a real SMS or WhatsApp provider for the codes. Decide who your approvers are and who covers for them, because claims expire after 24 hours. Start with a low limit, or zero, and raise it once you're comfortable with what you see in the audit log. Agree who gets told when Paystack is down or a refund fails, and how long you keep case records.

The main risks: a limit set too high costs real money; when Paystack is down, riders will have to wait; and a code is only as safe as the rider's SIM, so keep your SIM-swap checks in place. Riders also only hear about a team decision when they message again, until Chord can send updates back into the chat.
