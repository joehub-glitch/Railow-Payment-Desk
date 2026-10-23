// Tiny key-value store. Upstash Redis in production, a Map for local runs and tests.
// setIfAbsent is the important one: it makes "credit this funding once" atomic, so two
// simultaneous requests can never both credit the same wallet.

import { Redis } from "@upstash/redis";
import { config } from "./config.js";

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  setIfAbsent<T>(key: string, value: T): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  listPush<T>(key: string, value: T): Promise<void>;
  listAll<T>(key: string): Promise<T[]>;
  keys(prefix: string): Promise<string[]>;
  flush(): Promise<void>;
}

class MemoryStore implements Store {
  private m = new Map<string, unknown>();
  async get<T>(k: string) { return (this.m.has(k) ? structuredClone(this.m.get(k)) : null) as T | null; }
  async set<T>(k: string, v: T) { this.m.set(k, structuredClone(v)); }
  async setIfAbsent<T>(k: string, v: T) { if (this.m.has(k)) return false; this.m.set(k, structuredClone(v)); return true; }
  async del(k: string) { this.m.delete(k); }
  async incr(k: string) { const n = ((this.m.get(k) as number) ?? 0) + 1; this.m.set(k, n); return n; }
  async listPush<T>(k: string, v: T) { const l = (this.m.get(k) as T[]) ?? []; l.push(structuredClone(v)); this.m.set(k, l); }
  async listAll<T>(k: string) { return structuredClone((this.m.get(k) as T[]) ?? []); }
  async keys(prefix: string) { return [...this.m.keys()].filter((k) => k.startsWith(prefix)); }
  async flush() { this.m.clear(); }
}

class RedisStore implements Store {
  // Created on first use, so a bad URL shows up as a readable error instead of crashing the server.
  private _r?: Redis;
  private get r() { return (this._r ??= new Redis({ url: config.upstashUrl, token: config.upstashToken })); }
  private p = "railow:"; // namespace so a shared database stays tidy
  async get<T>(k: string) { return (await this.r.get<T>(this.p + k)) ?? null; }
  async set<T>(k: string, v: T) { await this.r.set(this.p + k, v); }
  async setIfAbsent<T>(k: string, v: T) { return (await this.r.set(this.p + k, v, { nx: true })) === "OK"; }
  async del(k: string) { await this.r.del(this.p + k); }
  async incr(k: string) { return this.r.incr(this.p + k); }
  async listPush<T>(k: string, v: T) { await this.r.rpush(this.p + k, JSON.stringify(v)); }
  async listAll<T>(k: string) {
    const raw = await this.r.lrange(this.p + k, 0, -1);
    return raw.map((x) => (typeof x === "string" ? JSON.parse(x) : x)) as T[];
  }
  async keys(prefix: string) {
    const out: string[] = [];
    let cursor: string | number = 0;
    do {
      const [next, batch]: [string | number, string[]] = await this.r.scan(cursor, { match: `${this.p}${prefix}*`, count: 200 });
      out.push(...batch.map((k) => k.slice(this.p.length)));
      cursor = next;
    } while (String(cursor) !== "0");
    return out;
  }
  async flush() { for (const k of await this.keys("")) await this.del(k); }
}

export const store: Store = config.upstashUrl && config.upstashToken ? new RedisStore() : new MemoryStore();
export const storeKind = store instanceof RedisStore ? "upstash-redis" : "in-memory";
