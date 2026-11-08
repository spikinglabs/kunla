// Approve in Kunla = merge the PR. When a person approves a task whose work is an open GitHub pull
// request, the PR is merged (squash) once its checks are green. With a GitHub token stored in Kunla,
// Kunla merges it itself; without one, the woken agent is told to merge it. Red checks or a conflict
// send the task back to the agent with the reason. Nothing polls: waiting for checks rides on
// GitHub's check_suite webhook.
import { type Ctx, type Task } from './core';
import { wakeMember } from './wake';
import { installationToken, getApp, installations } from './githubapp';
import { findKeys } from './github';

const WAIT_PREFIX = 'merge_wait:';
const API = 'https://api.github.com';

export interface PrRef { url: string; owner: string; repo: string; number: number }
export type Checks = 'green' | 'pending' | 'red' | 'none';
export interface PrState { state: 'open' | 'merged' | 'closed'; checks: Checks; mergeable: boolean | null; conflict: boolean; sha: string; title: string }

/** The first GitHub pull request among a task's deliverables. */
export function prFromLinks(links: { url: string }[]): PrRef | null {
  for (const l of links) {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(l.url ?? '');
    if (m) return { url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  return null;
}

// Settings are per workspace: the first workspace keeps the plain key, others append ':<space_id>'
// (the same scheme as other per-workspace settings).
async function firstSpace(db: D1Database): Promise<string> {
  const r = await db.prepare(`SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1`).first<{ id: string }>();
  return r?.id ?? 'workspace';
}
async function scoped(db: D1Database, space: string, key: string) {
  return space === (await firstSpace(db)) ? key : `${key}:${space}`;
}
const waitKey = (db: D1Database, space: string, repo: string, n: number | string) => scoped(db, space, `${WAIT_PREFIX}${repo}#${n}`);

/**
 * The PR that is this task's work: the newest PR deliverable, skipping PRs that are another task's
 * work (their title cites other task keys but not this one), so approving never merges someone else's PR.
 */
export async function taskPr(db: D1Database, taskId: string): Promise<PrRef | null> {
  const t = await db.prepare('SELECT key FROM tasks WHERE id = ?').bind(taskId).first<{ key: string }>();
  const rows = (await db.prepare('SELECT url, title FROM deliverables WHERE task_id = ? ORDER BY created_at DESC').bind(taskId).all<{ url: string; title: string | null }>()).results;
  return prFromLinks(rows.filter((r) => { const k = findKeys(r.title); return !k.length || (!!t && k.includes(t.key)); }));
}

/** A token that can act on this PR: a short-lived installation token of the Kunla app, if it's installed here. */
export async function tokenFor(c: Pick<Ctx, 'db' | 'space'>, pr: PrRef, fetcher: typeof fetch = fetch): Promise<string | null> {
  return installationToken(c, pr.owner, pr.repo, fetcher).catch(() => null);
}

/** Can Kunla merge PRs itself in this workspace? (The app, with merge rights, installed here.) */
export async function canMerge(c: Pick<Ctx, 'db' | 'space'>): Promise<boolean> {
  const app = await getApp(c.db);
  return !!app?.merge && (await installations(c.db, c.space)).length > 0;
}

const gh = (token: string, fetcher: typeof fetch) => async (method: string, path: string, body?: unknown) => {
  const res = await fetcher(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Kunla', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
};

/** PR state plus a summary of its check runs. */
export async function prState(token: string, pr: PrRef, fetcher: typeof fetch = fetch): Promise<PrState> {
  const call = gh(token, fetcher);
  const p = await call('GET', `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`);
  if (!p.ok) throw new Error(`GitHub said ${p.status} for ${pr.url}${p.data?.message ? ': ' + p.data.message : ''}`);
  const sha = p.data.head?.sha;
  const runs = await call('GET', `/repos/${pr.owner}/${pr.repo}/commits/${sha}/check-runs?per_page=100`);
  const list: any[] = runs.ok ? runs.data.check_runs ?? [] : [];
  const checks: Checks = !list.length ? 'none'
    : list.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion)) ? 'red'
    : list.some((r) => r.status !== 'completed') ? 'pending' : 'green';
  return {
    state: p.data.merged ? 'merged' : p.data.state === 'closed' ? 'closed' : 'open',
    checks, mergeable: p.data.mergeable ?? null, conflict: p.data.mergeable_state === 'dirty' || p.data.mergeable === false,
    sha, title: p.data.title ?? '',
  };
}

async function note(c: Ctx, taskId: string, type: string, text: string, data: object = {}) {
  // The event lands in the task's own workspace.
  await c.db.prepare('INSERT INTO events (task_id, actor_id, type, note, data, created_at, space_id) VALUES (?,?,?,?,?,?, (SELECT space_id FROM tasks WHERE id = ?))')
    .bind(taskId, null, type, text, JSON.stringify(data), new Date().toISOString(), taskId).run();
}

/** Approved, but the PR can't go in: the task goes back to its agent with the reason, and the agent is woken. */
async function sendBack(c: Ctx, task: Task, pr: PrRef, reason: string) {
  const t = await c.db.prepare('SELECT * FROM tasks WHERE id = ? AND space_id = ?').bind(task.id, c.space).first<Task>();
  if (!t) return;
  if (t.status === 'done') await c.db.prepare(`UPDATE tasks SET status = 'in_progress', lease_expires_at = NULL, updated_at = ? WHERE id = ? AND space_id = ?`).bind(new Date().toISOString(), t.id, c.space).run();
  await note(c, t.id, 'merge_blocked', `Approved, but PR #${pr.number} can't be merged yet: ${reason}. Back to ${t.assignee_id ? 'its agent' : 'In progress'} to fix.`, { pr: pr.url, reason });
  await wakeMember(c, t.assignee_id, 'changes_requested', t, `Approved, but PR #${pr.number} can't be merged: ${reason}. Fix it; it merges as soon as checks are green.`, { merge: pr.url });
}

/**
 * Try to merge an approved task's PR now. Green → squash-merge. Pending → remember it and merge when
 * GitHub reports the check suite finished. Red or conflicting → send the task back.
 */
export async function mergeApproved(c: Ctx, task: Task, pr: PrRef, fetcher: typeof fetch = fetch, approver = c.me.name) {
  const token = await tokenFor(c, pr, fetcher);
  if (!token) return { done: false, reason: 'no token' };
  try {
    const s = await prState(token, pr, fetcher);
    if (s.state === 'merged') return { done: true, reason: 'already merged' };
    if (s.state === 'closed') { await note(c, task.id, 'merge_blocked', `PR #${pr.number} is closed, so nothing was merged.`, { pr: pr.url }); return { done: false, reason: 'closed' }; }
    if (s.conflict) { await sendBack(c, task, pr, 'it conflicts with the base branch'); return { done: false, reason: 'conflict' }; }
    if (s.checks === 'red') { await sendBack(c, task, pr, 'checks are failing'); return { done: false, reason: 'red' }; }
    if (s.checks === 'pending' || s.mergeable === null) {
      await c.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(await waitKey(c.db, c.space, `${pr.owner}/${pr.repo}`, pr.number), JSON.stringify({ task: task.id, by: approver }), new Date().toISOString()).run();
      await note(c, task.id, 'merge_waiting', `PR #${pr.number} merges as soon as its checks pass.`, { pr: pr.url });
      return { done: false, reason: 'pending' };
    }
    const m = await gh(token, fetcher)('PUT', `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
      merge_method: 'squash', sha: s.sha, commit_title: `${s.title} (#${pr.number})`, commit_message: `Task: ${task.key} ${c.baseUrl}/t/${task.key}\nApproved in Kunla by ${approver}.`,
    });
    if (!m.ok) { await sendBack(c, task, pr, m.data?.message || `GitHub said ${m.status}`); return { done: false, reason: 'merge failed' }; }
    await note(c, task.id, 'merged', `Merged PR #${pr.number} because ${approver} approved it.`, { pr: pr.url, sha: m.data?.sha });
    return { done: true, reason: 'merged' };
  } catch (e) {
    await note(c, task.id, 'merge_blocked', `Could not merge PR #${pr.number}: ${(e as Error).message}.`, { pr: pr.url });
    return { done: false, reason: 'error' };
  }
}

/** GitHub says a check suite finished: merge any approved PR that was waiting for it. */
export async function onCheckSuite(c: Ctx, payload: any, fetcher: typeof fetch = fetch) {
  const suite = payload?.check_suite;
  const repo = payload?.repository?.full_name;
  if (!suite || !repo || payload.action !== 'completed') return [];
  const done: string[] = [];
  for (const p of suite.pull_requests ?? []) {
    const key = await waitKey(c.db, c.space, repo, p.number);
    const w = await c.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    if (!w) continue;
    let wait: { task: string; by: string };
    try { wait = JSON.parse(w.value); } catch { wait = { task: w.value, by: 'a person' }; }
    const task = await c.db.prepare('SELECT * FROM tasks WHERE id = ? AND space_id = ?').bind(wait.task, c.space).first<Task>();
    const [owner, name] = repo.split('/');
    const pr = { url: `https://github.com/${repo}/pull/${p.number}`, owner, repo: name, number: Number(p.number) };
    const r = task ? await mergeApproved(c, task, pr, fetcher, wait.by) : { reason: 'gone' };
    if (r.reason !== 'pending') await c.db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    if (task) done.push(`${task.key}:${r.reason}`);
  }
  return done;
}
