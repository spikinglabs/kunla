// GitHub webhooks: commits and pull requests that cite a task key update the task by themselves,
// so nobody (person or agent) has to call log_work for work GitHub already knows about.
// One route, signature-verified, no polling: GitHub calls us only when something happens.
import * as core from './core';
import { onCheckSuite, getToken, canMerge } from './merge';
import type { Status, Task } from './core';
import * as ghapp from './githubapp';

export const GITHUB_EVENTS = ['pull_request', 'push', 'check_suite'];
const SECRET_KEY = 'github_webhook_secret';
const MAX_KEYS = 20;          // a PR citing more tasks than this is almost surely noise
const MAX_COMMITS = 50;       // a push carries at most 20 commits in the payload anyway
const DELIVERY_DAYS = 3;      // GitHub retries within hours; keep ids a little longer

// ---------- signature ----------

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
}

/** Constant-time check of X-Hub-Signature-256 against any of the configured secrets. */
export async function verifySignature(secrets: string[], body: string, header: string | null | undefined): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  let ok = false;
  for (const s of secrets) {
    const want = await sign(s, body);
    if (want.length !== header.length) continue;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
    if (diff === 0) ok = true;
  }
  return ok;
}

// ---------- secret (one per workspace) ----------
// Every workspace on a deployment shares the one webhook URL; the secret a delivery is signed with
// says which workspace it belongs to. The first workspace keeps the plain key it had before there
// were several, and GITHUB_WEBHOOK_SECRET (an env var) also belongs to the first workspace.

async function firstSpace(db: D1Database): Promise<string> {
  const r = await db.prepare(`SELECT id FROM projects WHERE kind = 'workspace' ORDER BY created_at LIMIT 1`).first<{ id: string }>();
  return r?.id ?? 'workspace';
}

async function secretKey(db: D1Database, space: string) {
  return space === (await firstSpace(db)) ? SECRET_KEY : `${SECRET_KEY}:${space}`;
}

export async function getSecret(db: D1Database, space: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(await secretKey(db, space)).first<{ value: string }>();
  return r?.value ?? null;
}

/** Every workspace's secret, so a delivery can be matched to the workspace that signed it. */
async function allSecrets(db: D1Database, envSecret?: string): Promise<{ space: string; secret: string }[]> {
  const first = await firstSpace(db);
  const rows = (await db.prepare(`SELECT key, value FROM settings WHERE key = ? OR key LIKE ?`).bind(SECRET_KEY, `${SECRET_KEY}:%`).all<{ key: string; value: string }>()).results;
  const out = rows.map((r) => ({ space: r.key === SECRET_KEY ? first : r.key.slice(SECRET_KEY.length + 1), secret: r.value }));
  if (envSecret) out.push({ space: first, secret: envSecret });
  return out;
}

function newSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(24)).buffer as ArrayBuffer);
}

export async function connectionInfo(c: core.Ctx, envSecret?: string) {
  const env = envSecret && c.space === (await firstSpace(c.db));
  const last = await c.db.prepare('SELECT MAX(created_at) AS at FROM webhook_log WHERE space_id = ? AND status < 300').bind(c.space).first<{ at: string | null }>();
  // Each repository that has sent this workspace something, with its latest delivery.
  const repos = (await c.db.prepare(
    `SELECT l.repo, l.event, l.status, l.result, l.created_at FROM webhook_log l
     JOIN (SELECT repo, MAX(id) AS id FROM webhook_log WHERE space_id = ? AND repo IS NOT NULL GROUP BY repo) m ON m.id = l.id
     ORDER BY l.created_at DESC LIMIT 20`).bind(c.space).all()).results;
  const recent = (await c.db.prepare('SELECT event, repo, status, result, created_at FROM webhook_log WHERE space_id = ? ORDER BY id DESC LIMIT 8').bind(c.space).all()).results;
  // A delivery whose signature matched no workspace: almost always a secret pasted wrong or replaced since.
  const rejected = await c.db.prepare(`SELECT event, repo, created_at FROM webhook_log WHERE space_id IS NULL AND created_at > ? ORDER BY id DESC LIMIT 1`)
    .bind(new Date(Date.now() - 2 * 86400_000).toISOString()).first();
  return {
    webhook_url: `${c.baseUrl}/hooks/github`,
    content_type: 'application/json',
    events: GITHUB_EVENTS,
    secret_set: !!(await getSecret(c.db, c.space)) || !!env,
    merge_token_set: !!(await getToken(c)),
    merge_ready: await canMerge(c),
    app: await ghapp.info(c),
    last_delivery_at: last?.at ?? null,
    repos, recent,
    rejected: rejected && (!last?.at || String(rejected.created_at) > last.at) ? rejected : null,
  };
}

/** An admin makes (or replaces) the webhook secret. It is shown once; the old one stops working at once. */
export async function rotateSecret(c: core.Ctx, envSecret?: string) {
  if (c.me.kind !== 'human' || !JSON.parse(c.me.roles || '[]').includes('admin')) throw new core.KunlaError(403, 'Only admins can connect GitHub.');
  const secret = newSecret();
  await c.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(await secretKey(c.db, c.space), secret, new Date().toISOString()).run();
  return { ...(await connectionInfo(c, envSecret)), secret };
}

// ---------- task keys ----------

/** Task keys like KD-12 in any text. Branch names are lower case (kd-12-fix-x), so case is ignored. */
export function findKeys(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  const re = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g;
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(re)) {
      out.add(`${m[1].toUpperCase()}-${Number(m[2])}`);
      if (out.size >= MAX_KEYS) return [...out];
    }
  }
  return [...out];
}

// ---------- status transitions ----------

export type PrMove = 'opened' | 'draft' | 'merged' | 'closed' | 'link';

/**
 * Where a task goes when a pull request citing it moves. Only ever forward: work that is done,
 * declined, still a proposal or waiting on a person's answer is left alone (it still gets the note).
 */
export function nextStatus(status: Status, move: PrMove, requireHumanReview: boolean): Status | null {
  const open = status === 'ready' || status === 'in_progress';
  switch (move) {
    case 'opened': return open ? 'review' : null;
    case 'draft': return status === 'ready' ? 'in_progress' : null;
    case 'merged':
      if (requireHumanReview) return open || status === 'blocked' ? 'review' : null;
      return open || status === 'blocked' || status === 'review' ? 'done' : null;
    default: return null;
  }
}

// ---------- the webhook ----------

type Result = { status: number; body: Record<string, unknown> };

// Kunla itself is the actor (events.actor_id NULL), and the note says who did it on GitHub.
function systemCtx(base: core.Ctx): core.Ctx {
  return { ...base, me: { id: null as unknown as string, name: 'GitHub', kind: 'ai', platform: 'github', sponsor_id: null, roles: '[]', scope: '[]', created_at: '', space_id: base.space } };
}

async function tasksFor(c: core.Ctx, keys: string[]) {
  if (!keys.length) return [];
  return (await c.db.prepare(
    `SELECT t.*, p.require_human_review AS rhr FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.space_id = ? AND t.key IN (${keys.map(() => '?').join(',')})`)
    .bind(c.space, ...keys).all<Task & { rhr: number }>()).results;
}

async function addLink(c: core.Ctx, taskId: string, url: string, title: string): Promise<boolean> {
  const r = await c.db.prepare('INSERT OR IGNORE INTO deliverables (id, task_id, url, title, added_by, created_at) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), taskId, url, title, null, new Date().toISOString()).run();
  return !!r.meta.changes;
}

async function onPullRequest(c: core.Ctx, p: any): Promise<Result> {
  const pr = p.pull_request;
  if (!pr?.html_url) return { status: 400, body: { error: 'No pull_request in payload.' } };
  const action: string = p.action;
  const move: PrMove | null =
    action === 'closed' ? (pr.merged ? 'merged' : 'closed')
    : ['opened', 'reopened', 'ready_for_review'].includes(action) ? (pr.draft ? 'draft' : 'opened')
    : action === 'converted_to_draft' ? 'draft'
    : ['edited', 'synchronize'].includes(action) ? 'link' : null;
  if (!move) return { status: 202, body: { ignored: `pull_request.${action}` } };

  const keys = findKeys(pr.title, pr.head?.ref, pr.body);
  const tasks = await tasksFor(c, keys);
  const who = pr.user?.login ? ` by @${pr.user.login}` : '';
  const ref = `PR #${pr.number}`;
  const updated: { key: string; from: Status; to: Status | null }[] = [];

  for (const t of tasks) {
    const isNew = await addLink(c, t.id, pr.html_url, `${ref}: ${String(pr.title).slice(0, 120)}`);
    // An edit or a new push only matters the first time it links a task (e.g. a key added to the
    // title, or the webhook connected after the PR was opened); then it counts as the PR opening.
    const effective: PrMove = move === 'link' ? (isNew ? (pr.draft ? 'draft' : 'opened') : 'link') : move;
    if (effective === 'link') continue;
    let to = nextStatus(t.status, effective, !!t.rhr);
    const open = to === 'done' ? await core.openSubtasks(c.db, t.id) : [];
    if (open.length) to = null; // a parent finishes only when its last sub-task does
    const verb = { opened: 'opened', draft: 'opened as a draft', merged: 'merged', closed: 'closed without merging', link: '' }[effective];
    const what = open.length ? `${ref} merged; ${t.key} finishes when ${open.join(', ')} ${open.length === 1 ? 'is' : 'are'} done`
      : effective === 'merged' && (to ?? t.status) === 'review' ? `${ref} merged; waiting for a person's review` : `${ref} ${verb}`;
    if (to && to !== t.status) {
      const fields: Partial<Task> = { status: to };
      if (to === 'review' || to === 'done') { fields.lease_expires_at = null; fields.blocked_question = null; fields.blocked_on_id = null; }
      await core.touch(c, t.id, fields);
    }
    await core.event(c, t.id, 'github', `${what}${who}: ${pr.title}`, { what, url: pr.html_url, from: t.status, to: to ?? t.status }, null);
    if (to === 'done') await core.rollUp(c, t.parent_id);
    updated.push({ key: t.key, from: t.status, to });
  }
  return { status: 200, body: { ok: true, keys, updated } };
}

async function onPush(c: core.Ctx, p: any): Promise<Result> {
  const commits: any[] = (p.commits ?? []).filter((x: any) => x?.distinct !== false).slice(0, MAX_COMMITS);
  const byKey = new Map<string, any[]>();
  for (const cm of commits) for (const k of findKeys(cm.message)) byKey.set(k, [...(byKey.get(k) ?? []), cm]);
  const tasks = await tasksFor(c, [...byKey.keys()].slice(0, MAX_KEYS));
  const branch = String(p.ref ?? '').replace(/^refs\/heads\//, '');
  const linked: string[] = [];
  for (const t of tasks) {
    for (const cm of byKey.get(t.key) ?? []) {
      const first = String(cm.message).split('\n')[0].slice(0, 120);
      const author = cm.author?.username ? `@${cm.author.username}` : cm.author?.name ?? 'someone';
      const what = `Commit ${String(cm.id).slice(0, 7)} on ${branch}`;
      await core.event(c, t.id, 'github', `${what} by ${author}: ${first}`, { what, url: cm.url, sha: cm.id }, null);
    }
    linked.push(t.key);
  }
  return { status: 200, body: { ok: true, linked } };
}

/** One line for the delivery log, in words a person reads on the Connect GitHub dialog. */
export function describe(kind: string, r: Result): string {
  const b = r.body as any;
  if (r.status === 401) return 'Rejected: the secret does not match';
  if (b.error) return String(b.error);
  if (b.pong) return 'Ping received: connected';
  if (b.uninstalled) return `Kunla app uninstalled from ${b.uninstalled === true ? 'an account' : b.uninstalled}`;
  if (b.duplicate) return 'Already received (GitHub resent it)';
  if (b.ignored) return `Ignored ${String(b.ignored).replace('pull_request.', 'pull request ').replace(/_/g, ' ')} (not needed)`;
  if (Array.isArray(b.updated)) return b.updated.length ? 'Updated ' + b.updated.map((u: any) => u.to && u.to !== u.from ? `${u.key} → ${u.to.replace('_', ' ')}` : u.key).join(', ') : 'No task key found in the title, branch or description';
  if (Array.isArray(b.linked)) return b.linked.length ? `Linked commits to ${b.linked.join(', ')}` : 'No task key found in the commit messages';
  if (Array.isArray(b.merged)) return b.merged.length ? `Checks finished: ${b.merged.join(', ')}` : 'Checks finished';
  return `HTTP ${r.status}`;
}

const LOG_DAYS = 30;

/** POST /hooks/github. Verifies the signature, counts each delivery once, applies the event, and logs the outcome. */
export async function handleWebhook(base: core.Ctx, req: Request, envSecret?: string): Promise<Result> {
  const raw = await req.text();
  const kind = req.headers.get('x-github-event') ?? '';
  const { result, space } = await verifyAndApply(base, req, raw, kind, envSecret);
  if (result.status !== 503) {
    let repo: string | null = null;
    try { repo = JSON.parse(raw)?.repository?.full_name ?? null; } catch { /* form-encoded or junk */ }
    const now = new Date();
    try {
      await base.db.prepare('INSERT INTO webhook_log (space_id, event, repo, status, result, created_at) VALUES (?,?,?,?,?,?)')
        .bind(space, kind || 'unknown', repo ? String(repo).slice(0, 140) : null, result.status, describe(kind, result).slice(0, 300), now.toISOString()).run();
      await base.db.prepare('DELETE FROM webhook_log WHERE created_at < ?').bind(new Date(now.getTime() - LOG_DAYS * 86400_000).toISOString()).run();
    } catch { /* logging never fails a delivery */ }
  }
  return result;
}

async function verifyAndApply(base: core.Ctx, req: Request, raw: string, kind: string, envSecret?: string): Promise<{ result: Result; space: string | null }> {
  const secrets = await allSecrets(base.db, envSecret);
  const app = await ghapp.getApp(base.db);
  if (!secrets.length && !app) return { space: null, result: { status: 503, body: { error: 'GitHub is not connected yet. An admin connects it in Kunla (Team → Connect GitHub).' } } };
  const sig = req.headers.get('x-hub-signature-256');
  // The Kunla GitHub App signs every delivery with its own secret; the installation says the workspace.
  if (app && await verifySignature([app.webhook_secret], raw, sig)) return fromApp(base, req, raw, kind);
  let space: string | null = null;
  for (const s of secrets) if (await verifySignature([s.secret], raw, sig)) { space = s.space; break; }
  if (!space) return { space: null, result: { status: 401, body: { error: 'Bad signature.' } } };
  return { space, result: await apply({ ...base, space }, req, raw, kind, space) };
}

async function fromApp(base: core.Ctx, req: Request, raw: string, kind: string): Promise<{ result: Result; space: string | null }> {
  let p: any;
  try { p = JSON.parse(raw); } catch { return { space: null, result: { status: 400, body: { error: 'Payload is not JSON.' } } }; }
  const id = p?.installation?.id;
  const link = id ? await ghapp.getInstallation(base.db, id) : null;
  if (kind === 'ping') return { space: link?.space ?? null, result: { status: 200, body: { ok: true, pong: true } } };
  if (kind === 'installation' && p.action === 'deleted' && id) {
    await ghapp.forget(base.db, id);
    return { space: link?.space ?? null, result: { status: 200, body: { ok: true, uninstalled: p.installation?.account?.login ?? true } } };
  }
  if (kind === 'installation' || kind === 'installation_repositories') return { space: link?.space ?? null, result: { status: 202, body: { ignored: kind } } };
  if (!link) return { space: null, result: { status: 202, body: { error: `The Kunla app is installed on ${p?.installation?.account?.login ?? 'an account'} but not linked to a workspace. Click Connect with GitHub in Kunla.` } } };
  return { space: link.space, result: await apply({ ...base, space: link.space }, req, raw, kind, link.space) };
}

async function apply(base: core.Ctx, req: Request, raw: string, kind: string, space: string): Promise<Result> {
  if (kind === 'ping') return { status: 200, body: { ok: true, pong: true } };

  const delivery = req.headers.get('x-github-delivery');
  if (delivery) {
    const now = new Date();
    const r = await base.db.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, space_id, created_at) VALUES (?,?,?)').bind(delivery, space, now.toISOString()).run();
    if (!r.meta.changes) return { status: 200, body: { ok: true, duplicate: true } };
    await base.db.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?').bind(new Date(now.getTime() - DELIVERY_DAYS * 86400_000).toISOString()).run();
  }

  let payload: any;
  try {
    const ct = req.headers.get('content-type') ?? '';
    payload = JSON.parse(ct.includes('x-www-form-urlencoded') ? new URLSearchParams(raw).get('payload') ?? '' : raw);
  } catch { return { status: 400, body: { error: 'Payload is not JSON.' } }; }

  const c = systemCtx(base);
  if (kind === 'pull_request') return onPullRequest(c, payload);
  if (kind === 'push') return onPush(c, payload);
  // Approved PRs that were waiting for their checks merge when GitHub reports the suite finished.
  if (kind === 'check_suite') return { status: 200, body: { ok: true, merged: await onCheckSuite(c, payload) } };
  return { status: 202, body: { ignored: kind } };
}
