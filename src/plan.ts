// Plans for Kunla Cloud (KD-72). People are billed per person; AI members are always free. A hosted Kunla starts
// on the free plan for small teams (KUNLA_FREE_SEATS people, 5 by default). The Kunla Cloud control plane, which
// owns billing (Stripe), sets the plan here after a payment and reads the head count to bill, through two calls
// signed with KUNLA_CLOUD_SECRET. Self-hosted copies have no plan and no limit (a licence may still set seats).
//
// Shared hosting (KUNLA_CLOUD_SHARED=true): one Kunla holds several customers' workspaces (Kunla Cloud's pilot
// mode), so each workspace has its own plan and head count, and the signed calls name it with ?workspace=<id or key>.
//
// Signing: header x-kunla-timestamp (unix seconds) and x-kunla-signature-256 = "sha256=" + hex HMAC-SHA256 of
// "<timestamp>.<body>" (empty body for GET). Requests older than five minutes are refused.

export interface Plan { name: string; seats: number | null; updated_at?: string }
export interface PlanEnv { KUNLA_CLOUD_SECRET?: string; KUNLA_FREE_SEATS?: string; KUNLA_CLOUD_SHARED?: string }

let cfg: { secret: string; freeSeats: number; shared: boolean } | null = null;

export function configure(env: PlanEnv) {
  cfg = env.KUNLA_CLOUD_SECRET
    ? { secret: env.KUNLA_CLOUD_SECRET, freeSeats: Math.max(1, Number(env.KUNLA_FREE_SEATS) || 5), shared: env.KUNLA_CLOUD_SHARED === 'true' }
    : null;
}
export const hosted = () => !!cfg;
/** Several customers' workspaces in this one Kunla: plans, seats and workspace creation are per workspace. */
export const shared = () => !!cfg?.shared;

// The plan is one setting for the whole Kunla, or one per workspace when shared.
const keyFor = (space?: string | null) => (cfg?.shared ? `plan:${space ?? ''}` : 'plan');

/** The plan this Kunla (or, when shared, this workspace) is on, or null when self-hosted. */
export async function current(db: D1Database, space?: string | null): Promise<Plan | null> {
  if (!cfg) return null;
  if (cfg.shared && !space) return null;
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(keyFor(space)).first<{ value: string }>();
  try { if (r) return JSON.parse(r.value) as Plan; } catch { /* fall back to free */ }
  return { name: 'free', seats: cfg.freeSeats };
}

/** How many people the plan allows, or null for no limit. */
export async function seatLimit(db: D1Database, space?: string | null): Promise<number | null> {
  return (await current(db, space))?.seats ?? null;
}

/** People and agents: across the Kunla, or in one workspace when shared. */
export async function headcount(db: D1Database, space?: string | null) {
  const one = cfg?.shared && space;
  const r = await db.prepare(`SELECT SUM(kind = 'human') AS people, SUM(kind = 'ai') AS agents FROM members WHERE removed_at IS NULL${one ? ' AND space_id = ?' : ''}`)
    .bind(...(one ? [space] : [])).first<{ people: number | null; agents: number | null }>();
  return { people: r?.people ?? 0, agents: r?.agents ?? 0 };
}

/** Shared hosting: the workspace a control-plane call names (?workspace=<id or key>), or an error message. */
export async function workspaceOf(db: D1Database, req: Request): Promise<{ space: string | null; error?: string }> {
  if (!cfg?.shared) return { space: null };
  const w = new URL(req.url).searchParams.get('workspace') || '';
  if (!w) return { space: null, error: 'Name the workspace: ?workspace=<id or key>.' };
  const r = await db.prepare(`SELECT id FROM projects WHERE kind = 'workspace' AND (id = ? OR key = ?)`).bind(w, w.toUpperCase()).first<{ id: string }>();
  return r ? { space: r.id } : { space: null, error: `No workspace ${w}.` };
}

async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Headers for a call this Kunla makes to the control plane, signed the same way. */
export async function signedHeaders(body: string, now = Date.now()): Promise<Record<string, string>> {
  if (!cfg) throw new Error('Not hosted.');
  const ts = Math.floor(now / 1000);
  return { 'x-kunla-timestamp': String(ts), 'x-kunla-signature-256': `sha256=${await hmac(cfg.secret, `${ts}.${body}`)}` };
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
export async function set(db: D1Database, input: unknown, space?: string | null): Promise<Plan> {
  const d = (input ?? {}) as { name?: unknown; seats?: unknown };
  const name = String(d.name ?? '').trim().slice(0, 40);
  if (!name) throw new Error('name is required');
  const seats = d.seats === null ? null : Number(d.seats);
  if (seats !== null && !(Number.isInteger(seats) && seats > 0)) throw new Error('seats must be a positive whole number or null');
  const plan: Plan = { name, seats, updated_at: new Date().toISOString() };
  await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(keyFor(space), JSON.stringify(plan), plan.updated_at).run();
  return plan;
}

export const _test = { hmac };
