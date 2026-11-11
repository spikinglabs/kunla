// Plans for Kunla Cloud (KD-72). People are billed per person; AI members are always free. A hosted Kunla starts
// on the free plan for small teams (KUNLA_FREE_SEATS people, 5 by default). The Kunla Cloud control plane, which
// owns billing (Stripe), sets the plan here after a payment and reads the head count to bill, through two calls
// signed with KUNLA_CLOUD_SECRET. Self-hosted copies have no plan and no limit (a licence may still set seats).
//
// Signing: header x-kunla-timestamp (unix seconds) and x-kunla-signature-256 = "sha256=" + hex HMAC-SHA256 of
// "<timestamp>.<body>" (empty body for GET). Requests older than five minutes are refused.

export interface Plan { name: string; seats: number | null; updated_at?: string }
export interface PlanEnv { KUNLA_CLOUD_SECRET?: string; KUNLA_FREE_SEATS?: string }

const KEY = 'plan';
let cfg: { secret: string; freeSeats: number } | null = null;

export function configure(env: PlanEnv) {
  cfg = env.KUNLA_CLOUD_SECRET ? { secret: env.KUNLA_CLOUD_SECRET, freeSeats: Math.max(1, Number(env.KUNLA_FREE_SEATS) || 5) } : null;
}
export const hosted = () => !!cfg;

/** The plan this Kunla is on, or null when self-hosted. */
export async function current(db: D1Database): Promise<Plan | null> {
  if (!cfg) return null;
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first<{ value: string }>();
  try { if (r) return JSON.parse(r.value) as Plan; } catch { /* fall back to free */ }
  return { name: 'free', seats: cfg.freeSeats };
}

/** How many people the plan allows, or null for no limit. */
export async function seatLimit(db: D1Database): Promise<number | null> {
  return (await current(db))?.seats ?? null;
}

export async function headcount(db: D1Database) {
  const r = await db.prepare(`SELECT SUM(kind = 'human') AS people, SUM(kind = 'ai') AS agents FROM members WHERE removed_at IS NULL`).first<{ people: number | null; agents: number | null }>();
  return { people: r?.people ?? 0, agents: r?.agents ?? 0 };
}

async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Check a control-plane call. Returns an error message, or null when it is genuine. */
export async function verify(req: Request, body: string, now = Date.now()): Promise<string | null> {
  if (!cfg) return 'This Kunla is not hosted by Kunla Cloud.';
  const ts = Number(req.headers.get('x-kunla-timestamp'));
  if (!ts || Math.abs(now / 1000 - ts) > 300) return 'Stale or missing timestamp.';
  const want = `sha256=${await hmac(cfg.secret, `${ts}.${body}`)}`;
  const got = req.headers.get('x-kunla-signature-256') || '';
  // Constant-time compare.
  let diff = want.length ^ got.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff ? 'Bad signature.' : null;
}

/** The control plane sets the plan after a payment, a downgrade or a cancellation (back to free). */
export async function set(db: D1Database, input: unknown): Promise<Plan> {
  const d = (input ?? {}) as { name?: unknown; seats?: unknown };
  const name = String(d.name ?? '').trim().slice(0, 40);
  if (!name) throw new Error('name is required');
  const seats = d.seats === null ? null : Number(d.seats);
  if (seats !== null && !(Number.isInteger(seats) && seats > 0)) throw new Error('seats must be a positive whole number or null');
  const plan: Plan = { name, seats, updated_at: new Date().toISOString() };
  await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(KEY, JSON.stringify(plan), plan.updated_at).run();
  return plan;
}

export const _test = { hmac };
