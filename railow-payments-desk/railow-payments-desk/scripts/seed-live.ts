// Live-mode seeding with real Paystack TEST payments.
//
//   1) npm run seed:links   -> creates one Paystack test checkout per live scenario and saves the
//                              references to seed/live-refs.json. Open each link and pay as told.
//   2) npm run seed:apply   -> loads the demo riders into your store using those references.
//
// Needs PAYSTACK_SECRET_KEY (an sk_test_ key, never a live key) and, for step 2, Upstash env vars.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { initializePayment } from "../src/paystack.js";
import { livePaymentPlan, seed, type ScenarioKey } from "../src/seed.js";
import { config } from "../src/config.js";

const file = "seed/live-refs.json";
const cmd = process.argv[2];

if (!config.paystackSecret.startsWith("sk_test_")) {
  console.error("Refusing to run: PAYSTACK_SECRET_KEY must be a TEST key (sk_test_...).");
  process.exit(1);
}

if (cmd === "links") {
  await mkdir("seed", { recursive: true });
  const refs: Record<string, string> = {};
  const stamp = Date.now().toString(36);
  for (const p of livePaymentPlan) {
    const reference = `RW_${p.key}_${stamp}`;
    const url = await initializePayment(`demo+${p.key}@example.com`, p.payNaira * 100, reference);
    refs[p.key] = reference;
    console.log(`\n${p.key}\n  pay ₦${p.payNaira.toLocaleString()} with ${p.card} (${p.outcome})\n  ${url}`);
  }
  await writeFile(file, JSON.stringify(refs, null, 2));
  console.log(`\nSaved ${Object.keys(refs).length} references to ${file}. Pay each link, then run: npm run seed:apply`);
} else if (cmd === "apply") {
  const refs = JSON.parse(await readFile(file, "utf8")) as Partial<Record<ScenarioKey, string>>;
  console.log(await seed(refs));
} else {
  console.log("Usage: tsx scripts/seed-live.ts links | apply");
}
