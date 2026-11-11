// Waking agents: when a person decides something about an agent's work (approves it, sends it back,
// answers its question, or hands it a task), Kunla calls that agent's wake-up URL so it carries on
// by itself within seconds. One signed POST per decision, sent after the response; no polling.
import type { Ctx, Member, Task } from './core';

export type WakeEvent = 'approved' | 'changes_requested' | 'answered' | 'assigned' | 'work_ready' | 'taken_over' | 'unblocked' | 'assumption_corrected' | 'ping';
export type WakeFormat = 'kunla' | 'github_dispatch';

/** Stored as JSON in members.callback. The secret signs every call; auth is an optional Authorization header. */
export interface Callback { url: string; format: WakeFormat; secret: string; auth?: string | null }

export interface Wake {
  member: { id: string; name: string };
  callback: Callback;
  event: WakeEvent;
  task: { id: string; key: string; title: string; status: string } | null;
  note: string | null;
  by: string;
  baseUrl: string;
  merge?: { pr: string; by_kunla: boolean } | null;
}

export function parseCallback(raw: string | null | undefined): Callback | null {
  if (!raw) return null;
  try { const c = JSON.parse(raw); return c?.url && c?.secret ? c : null; } catch { return null; }
}

/** What the Team page and the API show: never the secret or the auth header. */
export function publicCallback(raw: string | null | undefined) {
  const c = parseCallback(raw);
  return c ? { url: c.url, format: c.format, has_auth: !!c.auth } : null;
}

const NEXT: Record<WakeEvent, (key: string) => string> = {
  approved: (k) => `${k} was approved. Call next_task and carry on with the next piece of work.`,
  changes_requested: (k) => `${k} was sent back. Call get_task ${k}, read the review and the rules, fix it, and submit again.`,
  answered: (k) => `Your question on ${k} was answered. Call get_task ${k} and continue.`,
  assigned: (k) => `${k} was handed to you. Call get_task ${k}, claim it and start.`,
  work_ready: (k) => `${k ? `${k} is` : 'New work is'} ready in your lane (continuous mode). Call next_task, claim what it gives you, and keep taking the next task until next_task says stop.`,
  taken_over: (k) => `${k} is no longer yours: someone took it over. Stop working on it and don't push more changes for it. Log anything useful with log_work ${k}, then call next_task.`,
  unblocked: (k) => `${k} is no longer waiting on anything. Call get_task ${k} and start (or carry on).`,
  assumption_corrected: (k) => `A person corrected an assumption you made on ${k}. Call get_task ${k}, read the correction under assumptions, adjust the work and carry on (submit again if it was in review).`,
  ping: () => 'Test call from Kunla. Nothing to do.',
};

export function payload(w: Wake) {
  const key = w.task?.key ?? '';
  const next = w.merge && w.event === 'approved' && !w.merge.by_kunla
    ? `${key} was approved. Merge ${w.merge.pr} (squash) once its checks are green; if they fail, fix them first. Then call next_task.`
    : NEXT[w.event](key);
  const body = {
    event: w.event,
    agent: w.member.name,
    by: w.by,
    note: w.note,
    task: w.task ? { key, title: w.task.title, status: w.task.status, link: `${w.baseUrl}/t/${key}` } : null,
    next,
    merge: w.merge ?? null,
    kunla_url: w.baseUrl,
    sent_at: new Date().toISOString(),
  };
  // GitHub repository_dispatch: lets a GitHub Action (e.g. Claude Code) run when Kunla calls.
  return w.callback.format === 'github_dispatch' ? { event_type: `kunla-${w.event.replace('_', '-')}`, client_payload: body } : body;
}

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Send one wake-up call, retrying once. Success and failure both land in the task's history. */
export async function deliver(db: D1Database, w: Wake, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const body = JSON.stringify(payload(w));
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'user-agent': 'Kunla-Wake/1',
    'x-kunla-event': w.event, 'x-kunla-signature-256': await hmac(w.callback.secret, body),
  };
  if (w.callback.auth) headers.authorization = w.callback.auth;
  if (w.callback.format === 'github_dispatch') headers.accept = 'application/vnd.github+json';
  let status: number | null = null; let error: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetcher(w.callback.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
      status = res.status;
      if (res.ok) { error = undefined; break; }
      error = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // a wrong URL or token won't fix itself
    } catch (e) { error = (e as Error).message || 'network error'; }
  }
  if (w.task && w.event !== 'ping') {
    const ok = !error;
    // The event lands in the task's own workspace.
    await db.prepare(`INSERT INTO events (task_id, actor_id, type, note, data, created_at, space_id) VALUES (?,?,?,?,?,?, (SELECT space_id FROM tasks WHERE id = ?))`).bind(
      w.task.id, null, ok ? 'woke' : 'wake_failed',
      ok ? `Woke ${w.member.name} so it carries on.` : `Could not wake ${w.member.name} (${error}). Its sponsor can check the wake-up URL on the Team page.`,
      JSON.stringify({ member_id: w.member.id, event: w.event, status }), new Date().toISOString(), w.task.id).run();
  }
  return { ok: !error, status, error };
}

/**
 * Called from the core when a decision concerns an agent. Looks up the agent's wake-up URL and, if it
 * has one, hands the call to c.notify (the Worker sends it after the response with waitUntil).
 */
export async function wakeMember(c: Ctx, memberId: string | null | undefined, event: WakeEvent, task: Task, note?: string | null, extra: { merge?: string; by_kunla?: boolean } = {}) {
  if (!c.notify || !memberId || memberId === c.me.id) return;
  const m = await c.db.prepare('SELECT id, name, kind, callback FROM members WHERE id = ? AND removed_at IS NULL AND space_id = ?')
    .bind(memberId, c.space).first<Pick<Member, 'id' | 'name' | 'kind'> & { callback: string | null }>();
  const callback = m && m.kind === 'ai' ? parseCallback(m.callback) : null;
  if (!m || !callback) return;
  const fresh = await c.db.prepare('SELECT id, key, title, status FROM tasks WHERE id = ?').bind(task.id).first<{ id: string; key: string; title: string; status: string }>();
  c.notify({ member: { id: m.id, name: m.name }, callback, event, task: fresh, note: note ?? null, by: c.me.name, baseUrl: c.baseUrl,
    merge: extra.merge ? { pr: extra.merge, by_kunla: !!extra.by_kunla } : null });
  // A continuous agent that was stopped is now on its way, so new work doesn't wake it a second time.
  await c.db.prepare(`UPDATE members SET run_state = json_set(run_state, '$.state', 'woken', '$.reason', NULL) WHERE id = ? AND continuous IS NOT NULL AND json_extract(run_state, '$.state') = 'stopped'`).bind(m.id).run();
}
