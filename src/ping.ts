// Opt-in anonymous usage ping (KD-69). Off by default. When a copy sets KUNLA_USAGE_PING=on, its daily cron sends
// one small JSON message: a random installation id, the version and edition, and five counts. Nothing else: no
// names, addresses, keys, titles or content. It tells Spiking Labs how many teams self-host and how big they are,
// to decide when hosted Kunla Cloud is worth starting (KD-60).
import { VERSION } from './version';
import { KunlaError } from './core';

export const DEFAULT_PING_URL = 'https://kunla.spikinglabs.workers.dev/api/ping';

export interface Ping {
  install_id: string; version: string; edition: string;
  workspaces: number; people: number; agents: number; tasks: number; tasks_7d: number;
}

/** This installation's random id, made on first use. It identifies a copy, never a person or team. */
async function installId(db: D1Database) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'install_id'`).first<{ value: string }>();
  if (row) return row.value;
  const idv = crypto.randomUUID();
  await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('install_id', ?, ?) ON CONFLICT(key) DO NOTHING`).bind(idv, new Date().toISOString()).run();
  return (await db.prepare(`SELECT value FROM settings WHERE key = 'install_id'`).first<{ value: string }>())!.value;
}

/** Exactly what would be sent. GET /api/ping/preview shows it to admins before they turn the ping on. */
export async function build(db: D1Database, edition: string, now = new Date()): Promise<Ping> {
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const r = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM projects WHERE kind = 'workspace') AS workspaces,
      (SELECT COUNT(*) FROM members WHERE kind = 'human' AND removed_at IS NULL) AS people,
      (SELECT COUNT(*) FROM members WHERE kind = 'ai' AND removed_at IS NULL) AS agents,
      (SELECT COUNT(*) FROM tasks) AS tasks,
      (SELECT COUNT(*) FROM tasks WHERE created_at >= ?) AS tasks_7d`).bind(week)
    .first<{ workspaces: number; people: number; agents: number; tasks: number; tasks_7d: number }>();
  return { install_id: await installId(db), version: VERSION, edition, ...r! };
}

/** From the cron: sends today's ping when the copy opted in. Never throws; a failed ping is just skipped. */
export async function send(db: D1Database, env: { KUNLA_USAGE_PING?: string; KUNLA_PING_URL?: string }, edition: string, fetcher: typeof fetch = fetch) {
  if ((env.KUNLA_USAGE_PING || '').toLowerCase() !== 'on') return { sent: false };
  try {
    const body = await build(db, edition);
    const res = await fetcher(env.KUNLA_PING_URL || DEFAULT_PING_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { sent: res.ok };
  } catch (e) {
    console.error('usage ping failed', e);
    return { sent: false };
  }
}

const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e9 ? (v as number) : null);

/** On the collecting Kunla: keeps one row per installation, overwritten by each ping. */
export async function receive(db: D1Database, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const idv = typeof b.install_id === 'string' && /^[0-9a-f-]{36}$/i.test(b.install_id) ? b.install_id.toLowerCase() : null;
  const version = typeof b.version === 'string' && /^[\w.+-]{1,32}$/.test(b.version) ? b.version : null;
  const edition = b.edition === 'enterprise' ? 'enterprise' : b.edition === 'community' ? 'community' : null;
  const n = ['workspaces', 'people', 'agents', 'tasks', 'tasks_7d'].map((k) => count(b[k]));
  if (!idv || !version || !edition || n.some((x) => x === null)) throw new KunlaError(400, 'Not a Kunla usage ping.');
  const t = new Date().toISOString();
  await db.prepare(`INSERT INTO usage_pings (install_id, version, edition, workspaces, people, agents, tasks, tasks_7d, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(install_id) DO UPDATE SET version = excluded.version, edition = excluded.edition, workspaces = excluded.workspaces,
        people = excluded.people, agents = excluded.agents, tasks = excluded.tasks, tasks_7d = excluded.tasks_7d, last_seen = excluded.last_seen`)
    .bind(idv, version, edition, ...n, t, t).run();
  return { ok: true };
}

/** For admins of the collecting Kunla: how many copies are alive, how big, on which versions. */
export async function summary(db: D1Database, now = new Date()) {
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const totals = await db.prepare(`SELECT
      SUM(last_seen >= ?1) AS active_7d, SUM(last_seen >= ?2) AS active_30d, COUNT(*) AS ever,
      SUM(CASE WHEN last_seen >= ?2 THEN people ELSE 0 END) AS people_30d,
      SUM(CASE WHEN last_seen >= ?2 THEN agents ELSE 0 END) AS agents_30d,
      SUM(last_seen >= ?2 AND tasks_7d > 0) AS working_30d
    FROM usage_pings`).bind(ago(7), ago(30)).first<Record<string, number | null>>();
  const versions = (await db.prepare(`SELECT version, COUNT(*) AS copies FROM usage_pings WHERE last_seen >= ? GROUP BY version ORDER BY copies DESC`)
    .bind(ago(30)).all<{ version: string; copies: number }>()).results;
  return { ...Object.fromEntries(Object.entries(totals ?? {}).map(([k, v]) => [k, v ?? 0])), versions };
}
