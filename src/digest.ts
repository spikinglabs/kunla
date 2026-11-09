// The weekly digest (KD-52): the Briefing for people who don't open Kunla. A workspace can switch it
// on and give a chat webhook (Slack, Discord, or any URL taking JSON); the daily cron sends it on the
// chosen weekday. Read-only: built from the record like everything else, nobody writes it.
import { parseDigest, type Ctx, type Member, type DigestSettings } from './core';
import { asks } from './views';

const DAY_MS = 86400_000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export { DAYS };

const now = (c: Ctx) => (c.now ? c.now() : new Date());

/** A week of work in one workspace: per project what finished and what is open, who did what, and what waits. */
export async function build(c: Ctx, days = 7) {
  const d = await collect(c, days);
  return { ...d, text: render(d, c.baseUrl) };
}

async function collect(c: Ctx, days: number) {
  const since = new Date(now(c).getTime() - days * DAY_MS).toISOString();
  const ws = await c.db.prepare(`SELECT key, name FROM projects WHERE id = ?`).bind(c.space).first<{ key: string; name: string }>();
  const projects = (await c.db.prepare(
    `SELECT id, key, name, kind FROM projects WHERE space_id = ? ORDER BY kind = 'workspace', focus DESC, rank, created_at`).bind(c.space)
    .all<{ id: string; key: string; name: string; kind: string }>()).results;
  const finished = (await c.db.prepare(
    `SELECT DISTINCT t.key, t.title, t.project_id, m.name AS worker, m.kind AS worker_kind FROM events e JOIN tasks t ON t.id = e.task_id
     LEFT JOIN members m ON m.id = t.assignee_id WHERE e.space_id = ? AND e.type = 'approved' AND e.created_at > ? ORDER BY e.id DESC`)
    .bind(c.space, since).all<{ key: string; title: string; project_id: string; worker: string | null; worker_kind: string | null }>()).results;
  const open = (await c.db.prepare(
    `SELECT project_id, status, COUNT(*) AS n FROM tasks WHERE space_id = ? AND status IN ('ready','in_progress','blocked','review') GROUP BY project_id, status`)
    .bind(c.space).all<{ project_id: string; status: string; n: number }>()).results;
  const people = (await c.db.prepare(
    `SELECT m.name, m.kind, SUM(CASE WHEN e.type = 'approved' THEN 0 ELSE 1 END) AS updates,
       COUNT(DISTINCT CASE WHEN e.type IN ('submitted','work_logged') THEN e.task_id END) AS tasks
     FROM events e JOIN members m ON m.id = e.actor_id WHERE e.space_id = ? AND e.created_at > ? AND e.task_id IS NOT NULL
     GROUP BY m.id ORDER BY tasks DESC, updates DESC`).bind(c.space, since).all<{ name: string; kind: string; updates: number; tasks: number }>()).results;
  const auto = await c.db.prepare(
    `SELECT SUM(CASE WHEN m.kind = 'ai' OR e.actor_id IS NULL THEN 1 ELSE 0 END) AS a, COUNT(*) AS n FROM events e LEFT JOIN members m ON m.id = e.actor_id
     WHERE e.space_id = ? AND e.created_at > ? AND e.task_id IS NOT NULL AND e.type NOT IN ('approved','changes_requested','rule_added','answered','accepted','declined')`)
    .bind(c.space, since).first<{ a: number | null; n: number }>();
  const byProject = projects.map((p) => {
    const counts = Object.fromEntries(open.filter((o) => o.project_id === p.id).map((o) => [o.status, o.n]));
    return { key: p.key, name: p.kind === 'workspace' ? 'No project' : p.name, finished: finished.filter((f) => f.project_id === p.id).map(({ key, title, worker, worker_kind }) => ({ key, title, worker, worker_kind })), open: counts };
  }).filter((p) => p.finished.length || Object.keys(p.open).length);
  const waiting = await asks(c);
  return {
    workspace: ws, since, days, link: c.baseUrl ? `${c.baseUrl}/app/` : null,
    finished_count: finished.length,
    agent_recorded_share: auto?.n ? Math.round(((auto.a ?? 0) / auto.n) * 100) : null,
    projects: byProject, people, asks: waiting,
  };
}

type Digest = Awaited<ReturnType<typeof collect>>;

/** Plain text that reads well in Slack, Discord, Teams or an email. */
export function render(d: Digest, baseUrl: string): string {
  const link = (key: string) => (baseUrl ? `${baseUrl}/t/${key}` : key);
  const lines: string[] = [];
  lines.push(`Kunla weekly digest: ${d.workspace?.name ?? 'workspace'} (last ${d.days} days)`);
  const share = d.agent_recorded_share === null ? '' : ` Agents recorded ${d.agent_recorded_share}% of the updates themselves.`;
  lines.push(`${d.finished_count} task${d.finished_count === 1 ? '' : 's'} finished.${share}`);
  for (const p of d.projects) {
    const o = p.open as Record<string, number>;
    const openBits = [['in_progress', 'in progress'], ['review', 'in review'], ['blocked', 'blocked'], ['ready', 'ready']].filter(([k]) => o[k]).map(([k, l]) => `${o[k]} ${l}`);
    lines.push('', `${p.name}${p.key && p.name !== 'No project' ? ` (${p.key})` : ''}: ${p.finished.length} finished${openBits.length ? ', ' + openBits.join(', ') : ''}`);
    for (const f of p.finished.slice(0, 6)) lines.push(`• ${f.key} ${f.title}${f.worker ? ` (${f.worker})` : ''} ${link(f.key)}`);
    if (p.finished.length > 6) lines.push(`• and ${p.finished.length - 6} more`);
  }
  if (d.people.length) {
    lines.push('', 'Who did what');
    for (const m of d.people.slice(0, 10)) lines.push(`• ${m.name}${m.kind === 'ai' ? ' (AI)' : ''}: worked on ${m.tasks} task${m.tasks === 1 ? '' : 's'}`);
  }
  if (d.asks.length) {
    lines.push('', 'Waiting too long');
    for (const a of d.asks) lines.push(`• ${a.line}${a.task ? ' ' + link(a.task.key) : ''}`);
  }
  if (d.link) lines.push('', `Open Kunla: ${d.link}`);
  return lines.join('\n');
}

/** The body for each kind of webhook. */
export function body(format: DigestSettings['format'], d: Awaited<ReturnType<typeof build>>) {
  if (format === 'discord') return { content: d.text.length > 1990 ? d.text.slice(0, 1987) + '...' : d.text };
  if (format === 'json') return d;
  return { text: d.text }; // Slack, Mattermost, Google Chat and many others take {text}
}

export async function send(c: Ctx, settings: DigestSettings, fetcher: typeof fetch = fetch) {
  if (!settings.url) return { ok: false, status: null, error: 'No webhook address yet.' };
  const d = await build(c);
  let status: number | null = null; let error: string | undefined;
  try {
    const res = await fetcher(settings.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Kunla-Digest/1' }, body: JSON.stringify(body(settings.format, d)), signal: AbortSignal.timeout(8000) });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) { error = (e as Error).message || 'network error'; }
  await c.db.prepare('INSERT INTO events (task_id, actor_id, type, note, data, space_id, created_at) VALUES (?,?,?,?,?,?,?)').bind(
    null, null, error ? 'digest_failed' : 'digest_sent', error ? `Could not send the weekly digest (${error}).` : 'Sent the weekly digest.',
    JSON.stringify({ status, finished: d.finished_count }), c.space, now(c).toISOString()).run();
  return { ok: !error, status, ...(error ? { error } : {}) };
}

/** Daily cron: send every switched-on digest whose weekday is today (UTC). */
export async function sendDue(c: Omit<Ctx, 'space' | 'me'>, fetcher: typeof fetch = fetch) {
  const today = now(c as Ctx).getUTCDay();
  const rows = (await c.db.prepare(`SELECT id, digest FROM projects WHERE kind = 'workspace' AND digest IS NOT NULL`).all<{ id: string; digest: string }>()).results;
  let sent = 0;
  for (const r of rows) {
    const s = parseDigest(r.digest);
    if (!s?.on || !s.url || s.day !== today) continue;
    // Kunla itself is reading; an admin-like reader so the digest shows every kind of ask.
    const me = { id: '', name: 'Kunla', kind: 'human', roles: '["admin"]' } as unknown as Member;
    const res = await send({ ...c, space: r.id, me } as Ctx, s, fetcher);
    if (res.ok) sent++;
  }
  return sent;
}
