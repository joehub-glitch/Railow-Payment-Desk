// All tunables in one place. Every value can be overridden with an environment variable.

// Copy-paste cleanup: stray spaces, wrapping quotes and trailing slashes break URLs and tokens.
const clean = (v: string | undefined) => (v ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
const cleanUrl = (v: string | undefined) => clean(v).replace(/\/+$/, "");

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  brand: process.env.BRAND_NAME ?? "Railow",

  // "mock" uses seeded fake payments (local tests). "live" calls Paystack test mode.
  paystackMode: (process.env.PAYSTACK_MODE ?? "mock") as "mock" | "live",
  paystackSecret: clean(process.env.PAYSTACK_SECRET_KEY),
  paystackTimeoutMs: num(process.env.PAYSTACK_TIMEOUT_MS, 8000),

  // Money rules. All amounts in kobo (₦1 = 100 kobo).
  autoCreditLimitKobo: num(process.env.AUTO_CREDIT_LIMIT_KOBO, 100_000_00), // ₦100,000
  newAccountDays: num(process.env.NEW_ACCOUNT_DAYS, 14),
  repeatClaimWindowDays: num(process.env.REPEAT_CLAIM_WINDOW_DAYS, 30),
  duplicateWindowMinutes: num(process.env.DUPLICATE_WINDOW_MINUTES, 10),

  // Rider verification: one-time code sent to the phone registered on the Railow account.
  otpTtlMinutes: num(process.env.OTP_TTL_MINUTES, 10),
  otpMaxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 3),
  otpMaxSendsPerWindow: num(process.env.OTP_MAX_SENDS, 3), // per phone, per 15 minutes
  sessionTtlMinutes: num(process.env.SESSION_TTL_MINUTES, 15),

  // Agent refund authority. The business sets the limit in Chord (MCP server -> Custom headers:
  // "X-Railow-Agent-Refund-Limit: 100,000"). Missing or 0 means agent refunds are off. The server
  // never allows more than this hard ceiling, whatever the header says.
  agentRefundHardCapKobo: num(process.env.AGENT_REFUND_HARD_CAP_KOBO, 100_000_00), // ₦100,000
  agentRefundWindowDays: num(process.env.AGENT_REFUND_WINDOW_DAYS, 30),            // one agent refund per rider per window

  // Maker-checker approvals in the Ops Console.
  fourEyesKobo: num(process.env.FOUR_EYES_KOBO, 50_000_00), // ₦50,000 and above needs two approvers
  claimTtlHours: num(process.env.CLAIM_TTL_HOURS, 24),      // undecided claims expire
  consoleSessionHours: num(process.env.CONSOLE_SESSION_HOURS, 8),
  approvers: [
    { id: "ops-lead", name: "Ops Lead", password: clean(process.env.APPROVER_OPS_LEAD_PASSWORD) },
    { id: "finance", name: "Finance", password: clean(process.env.APPROVER_FINANCE_PASSWORD) },
  ].filter((a) => a.password),

  // Shared secret Chord sends as "Authorization: Bearer ..." when calling this server.
  mcpBearerToken: clean(process.env.MCP_BEARER_TOKEN),
  // Protects the small developer endpoints (diagnose, seeding).
  opsToken: clean(process.env.OPS_TOKEN),

  // Optional ways to reach the owner outside the WhatsApp chat.
  ownerWebhookUrl: process.env.OWNER_WEBHOOK_URL ?? "",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  ownerEmail: process.env.OWNER_EMAIL ?? "",
  ownerEmailFrom: process.env.OWNER_EMAIL_FROM ?? "Railow Payments Desk <onboarding@resend.dev>",

  // Storage: Upstash-compatible Redis REST API when configured, in-memory otherwise (local only).
  // Vercel's Redis storage integration sets KV_REST_API_URL / KV_REST_API_TOKEN; a standalone
  // Upstash database uses UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. KV_* wins if both exist.
  upstashUrl: cleanUrl(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
  upstashToken: clean(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
};

export const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
