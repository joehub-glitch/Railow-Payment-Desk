// Agent refund authority. Two controls, and the STRICTER one always wins:
//
// 1. Chord (the ceiling, set by the business owner):
//    Admin -> Channels & Tools -> (this MCP server) -> Custom headers:
//        X-Railow-Agent-Refund-Limit: 100,000
//    Chord sends it with every tool call; the AI cannot see or change it.
//    "100,000", "₦100,000", "NGN 100000" and "100000" all mean ₦100,000. "0", "off", a missing header
//    or anything unreadable means OFF (fail closed). The server caps it at AGENT_REFUND_HARD_CAP_KOBO.
//
// 2. Ops Console (day-to-day control by the payments team):
//    an On/Off kill switch and an optional lower limit, changed with a reason and audit-logged.

import { config, naira } from "./config.js";
import { store } from "./store.js";

export const LIMIT_HEADER = "x-railow-agent-refund-limit";

export interface ChordPolicy {
  status: "on" | "off" | "missing" | "invalid";
  raw: string | null;          // exactly what Chord sent
  requestedKobo: number;       // what the header asked for
  limitKobo: number;           // after the server's hard ceiling (0 = off)
  cappedByServer: boolean;
}

export interface ConsoleSettings {
  enabled: boolean;            // kill switch
  limitKobo: number | null;    // optional lower limit; null = use Chord's limit
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AgentPolicy {
  limitKobo: number;           // what the agent may actually refund (0 = off)
  chord: ChordPolicy;
  console: ConsoleSettings;
  decidedBy: "chord" | "console";
}

const DEFAULT_SETTINGS: ConsoleSettings = { enabled: true, limitKobo: null, updatedBy: null, updatedAt: null };

/** Reads a naira amount the way people type it: "100,000", "₦100,000", "NGN 100000". */
export function parseNaira(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase().replace(/₦|ngn|naira|,|\s/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function parsePolicy(rawHeader: string | string[] | undefined): ChordPolicy {
  const raw = Array.isArray(rawHeader) ? rawHeader.join(",") : rawHeader ?? null;
  if (raw === null || raw.trim() === "") return { status: "missing", raw, requestedKobo: 0, limitKobo: 0, cappedByServer: false };
  if (["off", "0"].includes(raw.trim().toLowerCase())) return { status: "off", raw, requestedKobo: 0, limitKobo: 0, cappedByServer: false };
  const requestedKobo = parseNaira(raw);
  if (requestedKobo === null) return { status: "invalid", raw, requestedKobo: 0, limitKobo: 0, cappedByServer: false };
  const limitKobo = Math.min(requestedKobo, config.agentRefundHardCapKobo);
  return { status: limitKobo > 0 ? "on" : "off", raw, requestedKobo, limitKobo, cappedByServer: requestedKobo > config.agentRefundHardCapKobo };
}

export const getConsoleSettings = async () => (await store.get<ConsoleSettings>("settings:agent_refunds")) ?? DEFAULT_SETTINGS;
export const saveConsoleSettings = (s: ConsoleSettings) => store.set("settings:agent_refunds", s);

/** The stricter of Chord's ceiling and the console's switch/limit. */
export function combine(chord: ChordPolicy, cs: ConsoleSettings): AgentPolicy {
  if (!cs.enabled) return { limitKobo: 0, chord, console: cs, decidedBy: "console" };
  if (cs.limitKobo !== null && cs.limitKobo < chord.limitKobo) return { limitKobo: cs.limitKobo, chord, console: cs, decidedBy: "console" };
  return { limitKobo: chord.limitKobo, chord, console: cs, decidedBy: "chord" };
}

export const effectivePolicy = async (chord: ChordPolicy) => combine(chord, await getConsoleSettings());

export function describeChord(c: ChordPolicy) {
  switch (c.status) {
    case "on": return `${naira(c.limitKobo)}${c.cappedByServer ? ` (Chord asked for ${naira(c.requestedKobo)}; capped by the server)` : ""}`;
    case "off": return "off (limit set to 0 in Chord)";
    case "missing": return "off (no limit set in Chord)";
    case "invalid": return `off (Chord sent an unreadable limit: "${c.raw}")`;
  }
}

export function describePolicy(p: AgentPolicy) {
  if (!p.console.enabled) return `Agent refunds are OFF (switched off in the Ops Console${p.console.updatedBy ? ` by ${p.console.updatedBy}` : ""})`;
  if (p.limitKobo <= 0) return `Agent refunds are OFF: Chord limit ${describeChord(p.chord)}`;
  return p.decidedBy === "console"
    ? `Agent may refund up to ${naira(p.limitKobo)} (lower limit set in the Ops Console; Chord allows ${naira(p.chord.limitKobo)})`
    : `Agent may refund up to ${naira(p.limitKobo)} (limit set in Chord)`;
}

/** Remembers the Chord header last received, so the Ops Console can show it. Writes only on change. */
export async function recordPolicySeen(c: ChordPolicy) {
  const last = await store.get<ChordPolicy & { at: string }>("policy:last");
  if (last && last.raw === c.raw && last.limitKobo === c.limitKobo) return;
  await store.set("policy:last", { ...c, at: new Date().toISOString() });
}

export const lastPolicySeen = () => store.get<ChordPolicy & { at: string }>("policy:last");
