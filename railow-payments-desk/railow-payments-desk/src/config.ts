// All tunables in one place. Every value can be overridden with an environment variable.

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  brand: process.env.BRAND_NAME ?? "Railow",

  // "mock" uses seeded fake payments (local tests). "live" calls Paystack test mode.
  paystackMode: (process.env.PAYSTACK_MODE ?? "mock") as "mock" | "live",
  paystackSecret: process.env.PAYSTACK_SECRET_KEY ?? "",
  paystackTimeoutMs: num(process.env.PAYSTACK_TIMEOUT_MS, 8000),

  // Money rules. All amounts in kobo (₦1 = 100 kobo).
  autoCreditLimitKobo: num(process.env.AUTO_CREDIT_LIMIT_KOBO, 100_000_00), // ₦100,000
  newAccountDays: num(process.env.NEW_ACCOUNT_DAYS, 14),
  repeatClaimWindowDays: num(process.env.REPEAT_CLAIM_WINDOW_DAYS, 30),
  duplicateWindowMinutes: num(process.env.DUPLICATE_WINDOW_MINUTES, 10),

  // Owner approval codes.
  codeTtlHours: num(process.env.CODE_TTL_HOURS, 24),
  codeMaxAttempts: num(process.env.CODE_MAX_ATTEMPTS, 3),

  // Shared secret Chord sends as "Authorization: Bearer ..." when calling this server.
  mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? "",
  // Protects the small ops endpoints (owner inbox, reseed).
  opsToken: process.env.OPS_TOKEN ?? "",

  // Optional ways to reach the owner outside the WhatsApp chat.
  ownerWebhookUrl: process.env.OWNER_WEBHOOK_URL ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  ownerEmail: process.env.OWNER_EMAIL ?? "",
  ownerEmailFrom: process.env.OWNER_EMAIL_FROM ?? "Railow Payments Desk <onboarding@resend.dev>",

  // Storage: Upstash Redis when configured, in-memory otherwise (local only).
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL ?? "",
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
};

export const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
