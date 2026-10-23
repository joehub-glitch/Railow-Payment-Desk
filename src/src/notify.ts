// Tells the payments team, outside the WhatsApp conversation, that a claim is waiting in the Ops
// Console. Alerts carry no codes and no action links: decisions happen only behind the console login.

import { config } from "./config.js";
import { store } from "./store.js";

export interface OwnerNotice {
  at: string;
  caseRef: string;
  subject: string;
  body: string; // includes the one-time code
}

export async function notifyOwner(n: OwnerNotice): Promise<string[]> {
  const delivered: string[] = [];

  // 1. Always kept in the ops inbox (GET /ops/inbox, protected by OPS_TOKEN). Useful for demos.
  await store.listPush("owner_inbox", n);
  delivered.push("ops_inbox");

  // 2. Optional email via Resend.
  if (config.resendApiKey && config.ownerEmail) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.ownerEmailFrom, to: [config.ownerEmail], subject: n.subject, text: n.body }),
      });
      if (res.ok) delivered.push("email");
      else console.error("[notify] email failed", res.status, await res.text().catch(() => ""));
    } catch (e) {
      console.error("[notify] email error", e);
    }
  }

  // 3. Optional webhook (Slack, a Zapier hook, your own service...).
  if (config.ownerWebhookUrl) {
    try {
      const res = await fetch(config.ownerWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${n.subject}\n\n${n.body}`, ...n }),
      });
      if (res.ok) delivered.push("webhook");
    } catch (e) {
      console.error("[notify] webhook error", e);
    }
  }

  console.log(`[notify] ${n.caseRef} -> ${delivered.join(", ")}`);
  return delivered;
}
