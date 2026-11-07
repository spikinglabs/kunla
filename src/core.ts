// Kunla core: the record of work. Everything here is plain SQL over a D1-compatible
// database, so the same code runs on Cloudflare D1, a SQLite file, or (later) Postgres.

export type Kind = 'human' | 'ai';
export type Status = 'inbox' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'declined';
export const STATUSES: Status[] = ['inbox', 'ready', 'in_progress', 'blocked', 'review', 'done', 'declined'];
export const MAX_REVIEW_ROUNDS = 3;
const STALE_HOURS = 2;
const PROPOSAL_DAYS = 14; // proposals nobody triaged are tidied away after this

export interface Member {
  id: string; name: string; kind: Kind; platform: string | null;
  sponsor_id: string | null; roles: string; scope: string; created_at: string;
}
export interface Project {
  id: string; key: string; name: string; playbook: string;
  require_human_review: number; next_seq: number; created_at: string;
  kind: 'project' | 'workspace'; focus: number; rank: number; ends_at: string | null;
}
export interface Task {
  id: string; project_id: string; key: string; title: string; brief: string; criteria: string;
  status: Status; priority: number; origin: string; created_by: string | null;
  assignee_id: string | null; reviewer_id: string | null; lease_expires_at: string | null;
  blocked_question: string | null; blocked_on_id: string | null; review_rounds: number;
  parent_id: string | null; due_at: string | null; created_at: string; updated_at: string;
}

export class KunlaError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface Ctx {
  db: D1Database;
  me: Member;
  baseUrl: string;      // e.g. https://kunla.example.com
  leaseMinutes: number;
  now?: () => Date;
}

const id = () => crypto.randomUUID();
const nowIso = (c: Ctx) => (c.now ? c.now() : new Date()).toISOString();
const isAdmin = (m: Member) => JSON.parse(m.roles || '[]').includes('admin');
const parseList = (s: string | null | undefined): string[] => { try { return JSON.parse(s || '[]'); } catch { return []; } };

// ---------- members, tokens, projects ----------

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'kun_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function memberForToken(db: D1Database, token: string): Promise<Member | null> {
  const hash = await sha256(token);
  const row = await db.prepare(
    `SELECT m.*, t.id AS token_id, t.last_used_at AS token_used FROM tokens t JOIN members m ON m.id = t.member_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND m.removed_at IS NULL`).bind(hash).first<Member & { token_id: string; token_used: string | null }>();
  if (!row) return null;
  // "Last used" only needs hour precision; writing it on every request would cost a row write per call.
  const now = new Date();
  if (!row.token_used || now.getTime() - new Date(row.token_used).getTime() > 3600_000)
    await db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(now.toISOString(), row.token_id).run();
  const { token_id: _t, token_used: _u, ...member } = row;
  return member as Member;
}

export async function issueToken(db: D1Database, memberId: string, label: string): Promise<string> {
  const token = newToken();
  await db.prepare('INSERT INTO tokens (id, member_id, label, token_hash, created_at) VALUES (?,?,?,?,?)')
    .bind(id(), memberId, label, await sha256(token), new Date().toISOString()).run();
  return token;
}

export async function isSetUp(db: D1Database): Promise<boolean> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

/** First-run setup: the first human (admin), the first project, and their token. */
export async function setup(db: D1Database, input: { name: string; workspace_name?: string; workspace_key?: string; project_key?: string; project_name?: string }) {
  if (await isSetUp(db)) throw new KunlaError(409, 'Kunla is already set up.');
  const t = new Date().toISOString();
  const memberId = id();
  await db.prepare('INSERT INTO members (id, name, kind, roles, created_at) VALUES (?,?,?,?,?)')
    .bind(memberId, required(input.name, 'name'), 'human', '["admin"]', t).run();
  const ws = await getWorkspace(db);
  const wsKey = input.workspace_key?.trim() ? checkKey(input.workspace_key) : ws.key;
  await db.prepare('UPDATE projects SET name = ?, key = ? WHERE id = ?').bind(input.workspace_name?.trim() || ws.name, wsKey, ws.id).run();
  if (input.project_key?.trim() && input.project_name?.trim()) await insertProject(db, input.project_key, input.project_name, memberId);
  const token = await issueToken(db, memberId, 'web');
  return { member_id: memberId, token };
}

function required(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new KunlaError(400, `${name} is required.`);
  return v.trim();
}

function checkKey(key: string) {
  const k = required(key, 'key').toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(k)) throw new KunlaError(400, 'A key must be 2 to 10 letters or digits, starting with a letter (like MKT).');
  return k;
}

async function insertProject(db: D1Database, key: string, name: string, _by: string) {
  const k = checkKey(key);
  const exists = await db.prepare('SELECT 1 FROM projects WHERE key = ?').bind(k).first();
  if (exists) throw new KunlaError(409, `Project ${k} already exists.`);
  const pid = id();
  await db.prepare('INSERT INTO projects (id, key, name, created_at) VALUES (?,?,?,?)')
    .bind(pid, k, required(name, 'project name'), new Date().toISOString()).run();
  return pid;
}

export async function createProject(c: Ctx, input: { key: string; name: string; playbook?: string }) {
  if (c.me.kind !== 'human') throw new KunlaError(403, 'Only people can create projects.');
  const pid = await insertProject(c.db, input.key, input.name, c.me.id);
  if (input.playbook) await c.db.prepare('UPDATE projects SET playbook = ? WHERE id = ?').bind(input.playbook, pid).run();
  return getProject(c.db, input.key);
}

export async function updateProject(c: Ctx, key: string, input: {
  name?: string; playbook?: string; require_human_review?: boolean; focus?: boolean; rank?: number; ends_at?: string | null;
}) {
  if (c.me.kind !== 'human') throw new KunlaError(403, 'Only people can change project settings.');
  const p = await getProject(c.db, key);
  const ends = input.ends_at === undefined ? p.ends_at : input.ends_at ? new Date(input.ends_at).toISOString() : null;
  await c.db.prepare('UPDATE projects SET name = ?, playbook = ?, require_human_review = ?, focus = ?, rank = ?, ends_at = ? WHERE id = ?').bind(
    input.name ?? p.name, input.playbook ?? p.playbook,
    input.require_human_review === undefined ? p.require_human_review : input.require_human_review ? 1 : 0,
    input.focus === undefined ? p.focus : input.focus ? 1 : 0, input.rank ?? p.rank, ends, p.id).run();
  return getProject(c.db, p.id);
}

/** The workspace: the top of the hierarchy. Tasks with no project live here, and its playbook and rules apply everywhere. */
export async function getWorkspace(db: D1Database): Promise<Project> {
  const w = await db.prepare(`SELECT * FROM projects WHERE kind = 'workspace' LIMIT 1`).first<Project>();
  if (!w) throw new KunlaError(500, 'Workspace row missing; run the migrations.');
  return w;
}

export async function getProject(db: D1Database, keyOrId: string): Promise<Project> {
  const p = await db.prepare('SELECT * FROM projects WHERE key = ? OR id = ?').bind(keyOrId.toUpperCase(), keyOrId).first<Project>();
  if (!p) throw new KunlaError(404, `No project ${keyOrId}.`);
  return p;
}

/** Projects in steering order: focused first, then by rank. The workspace row is not a project. */
export async function listProjects(db: D1Database) {
  return (await db.prepare(`SELECT * FROM projects WHERE kind = 'project' ORDER BY focus DESC, rank, created_at`).all<Project>()).results;
}

/** Lanes: set which projects a member works on (empty = all). The member's sponsor or an admin can change it. */
export async function setScope(c: Ctx, memberIdOrName: string, scope: string[]) {
  const m = await getMember(c.db, memberIdOrName);
  if (c.me.kind !== 'human' || !(isAdmin(c.me) || m.sponsor_id === c.me.id || m.id === c.me.id)) throw new KunlaError(403, "Only the member's sponsor or an admin can change its lane.");
  const keys: string[] = [];
  for (const k of scope ?? []) keys.push((await getProject(c.db, k)).key);
  await c.db.prepare('UPDATE members SET scope = ? WHERE id = ?').bind(JSON.stringify(keys), m.id).run();
  return { id: m.id, name: m.name, scope: keys };
}

export async function listMembers(db: D1Database) {
  return (await db.prepare('SELECT * FROM members WHERE removed_at IS NULL ORDER BY kind DESC, created_at').all<Member>()).results;
}

export async function getMember(db: D1Database, idOrName: string): Promise<Member> {
  const m = await db.prepare('SELECT * FROM members WHERE id = ? OR lower(name) = lower(?) ORDER BY removed_at IS NOT NULL LIMIT 1').bind(idOrName, idOrName).first<Member>();
  if (!m) throw new KunlaError(404, `No member ${idOrName}.`);
  return m;
}

/**
 * A person adds a member: another person, or an AI connection they sponsor. Returns its token.
 * Connecting an agent again under the same name reuses that member and gives it a new token,
 * so a second click or a second laptop does not create a duplicate.
 */
export async function addMember(c: Ctx, input: { name: string; kind: Kind; platform?: string; roles?: string[] }) {
  if (c.me.kind !== 'human') throw new KunlaError(403, 'Only people can add members.');
  if (input.kind === 'human' && !isAdmin(c.me)) throw new KunlaError(403, 'Only admins can add people.');
  const name = required(input.name, 'name').trim();
  if (input.kind === 'ai') {
    const same = await c.db.prepare(`SELECT * FROM members WHERE kind = 'ai' AND sponsor_id = ? AND lower(name) = lower(?) AND removed_at IS NULL`)
      .bind(c.me.id, name).first<Member>();
    if (same) return { member: same, token: await issueToken(c.db, same.id, input.platform || 'ai'), reconnected: true };
  }
  await assertNameFree(c.db, name);
  const mid = id();
  await c.db.prepare('INSERT INTO members (id, name, kind, platform, sponsor_id, roles, created_at) VALUES (?,?,?,?,?,?,?)').bind(
    mid, name, input.kind === 'ai' ? 'ai' : 'human', input.platform ?? null,
    input.kind === 'ai' ? c.me.id : null, JSON.stringify(input.roles ?? []), nowIso(c)).run();
  const token = await issueToken(c.db, mid, input.platform || input.kind);
  return { member: await getMember(c.db, mid), token, reconnected: false };
}

async function assertNameFree(db: D1Database, name: string, except?: string) {
  const taken = await db.prepare('SELECT id FROM members WHERE lower(name) = lower(?) AND removed_at IS NULL AND id != ?').bind(name, except ?? '').first();
  if (taken) throw new KunlaError(409, `Someone is already called ${name}. Pick another name.`);
}

/** Who may manage a member: its sponsor or an admin, and people themselves. */
function assertCanManage(c: Ctx, m: Member) {
  if (c.me.kind !== 'human' || !(isAdmin(c.me) || m.sponsor_id === c.me.id || m.id === c.me.id))
    throw new KunlaError(403, `Only ${m.kind === 'ai' ? "the agent's sponsor" : 'they'} or an admin can change ${m.name}.`);
}

/** Rename a member and/or change its lane. */
export async function updateMember(c: Ctx, memberId: string, input: { name?: string; scope?: string[] }) {
  const m = await getMember(c.db, memberId);
  assertCanManage(c, m);
  if (input.name !== undefined && input.name.trim() !== m.name) {
    const name = required(input.name, 'name').trim().slice(0, 80);
    await assertNameFree(c.db, name, m.id);
    await c.db.prepare('UPDATE members SET name = ? WHERE id = ?').bind(name, m.id).run();
  }
  if (input.scope !== undefined) return setScope(c, m.id, input.scope);
  const after = await getMember(c.db, m.id);
  return { id: after.id, name: after.name, scope: parseList(after.scope) };
}

/** Revoke every token a member has and issue one new one. The old ones stop working at once. */
export async function rotateToken(c: Ctx, memberId: string) {
  const m = await getMember(c.db, memberId);
  assertCanManage(c, m);
  await c.db.prepare('UPDATE tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').bind(nowIso(c), m.id).run();
  return { member: m, token: await issueToken(c.db, m.id, m.platform || m.kind) };
}

/**
 * Remove a member: its tokens stop working and it leaves the team list, but everything it did
 * stays in the record under its name. Work it held goes back to Ready.
 */
export async function removeMember(c: Ctx, memberId: string) {
  const m = await getMember(c.db, memberId);
  assertCanManage(c, m);
  if (m.id === c.me.id) throw new KunlaError(400, 'You cannot remove yourself.');
  if (m.kind === 'human' && !isAdmin(c.me)) throw new KunlaError(403, 'Only admins can remove people.');
  const t = nowIso(c);
  await c.db.batch([
    c.db.prepare('UPDATE tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').bind(t, m.id),
    c.db.prepare(`UPDATE tasks SET status = 'ready', assignee_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE assignee_id = ? AND status = 'in_progress'`).bind(t, m.id),
    c.db.prepare('UPDATE members SET removed_at = ? WHERE id = ?').bind(t, m.id),
  ]);
  return { id: m.id, name: m.name, removed: true };
}

// ---------- tasks ----------

export async function getTask(db: D1Database, key: string): Promise<Task> {
  const t = await db.prepare('SELECT * FROM tasks WHERE key = ? OR id = ?').bind(String(key).toUpperCase(), key).first<Task>();
  if (!t) throw new KunlaError(404, `No task ${key}.`);
  return t;
}

export async function event(c: Ctx, taskId: string | null, type: string, note?: string | null, data: object = {}, actor: string | null = c.me.id) {
  await c.db.prepare('INSERT INTO events (task_id, actor_id, type, note, data, created_at) VALUES (?,?,?,?,?,?)')
    .bind(taskId, actor, type, note ?? null, JSON.stringify(data), nowIso(c)).run();
}

export async function touch(c: Ctx, taskId: string, fields: Partial<Task>) {
  const cols = Object.keys(fields);
  const sets = cols.map((k) => `${k} = ?`).concat('updated_at = ?').join(', ');
  await c.db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).bind(...cols.map((k) => (fields as any)[k]), nowIso(c), taskId).run();
}

/**
 * Leases expire lazily: an AI that went quiet loses its claim and the task returns to Ready
 * with a note. Runs at the start of reads, so no cron job is needed.
 */
export async function sweepLeases(c: Ctx) {
  const now = nowIso(c);
  const expired = (await c.db.prepare(
    `SELECT id, key, assignee_id FROM tasks WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
    .bind(now).all<{ id: string; key: string; assignee_id: string }>()).results;
  for (const t of expired) {
    const r = await c.db.prepare(
      `UPDATE tasks SET status = 'ready', assignee_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'in_progress' AND lease_expires_at < ?`).bind(now, t.id, now).run();
    if (r.meta.changes) await event(c, t.id, 'lease_expired', `No heartbeat for ${c.leaseMinutes} minutes, so ${t.key} went back to Ready.`, { previous_assignee: t.assignee_id }, null);
  }
  await tidy(c);
}

function leaseFor(c: Ctx, m: Member): string | null {
  if (m.kind !== 'ai') return null;
  return new Date((c.now ? c.now() : new Date()).getTime() + c.leaseMinutes * 60_000).toISOString();
}

export async function createTask(c: Ctx, input: {
  project?: string; title: string; brief?: string; criteria?: string[]; priority?: number;
  assignee?: string; reviewer?: string; status?: 'inbox' | 'ready'; parent?: string; due_at?: string;
}) {
  // Middle levels are optional: no project means a workspace-level task. A sub-task always
  // belongs to a task, takes its parent's project, and cannot have sub-tasks of its own.
  const parentTask = input.parent ? await getTask(c.db, input.parent) : null;
  if (parentTask?.parent_id) throw new KunlaError(400, `${parentTask.key} is already a sub-task; add this under its parent instead.`);
  const p = parentTask ? await getProject(c.db, parentTask.project_id)
    : input.project?.trim() ? await getProject(c.db, input.project) : await getWorkspace(c.db);
  if (parentTask && input.project?.trim() && (await getProject(c.db, input.project)).id !== p.id)
    throw new KunlaError(400, `A sub-task stays in its parent's project (${p.key}).`);
  // People write Ready tasks; AI-created tasks land in the Inbox as proposals unless they say Ready.
  const status: Status = input.status ?? (c.me.kind === 'human' ? 'ready' : 'inbox');
  const seq = await c.db.prepare('UPDATE projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq').bind(p.id).first<{ next_seq: number }>();
  const key = `${p.key}-${seq!.next_seq}`;
  const t = nowIso(c);
  const assignee = input.assignee ? (await getMember(c.db, input.assignee)).id : null;
  const reviewer = input.reviewer ? (await getMember(c.db, input.reviewer)).id : null;
  const parent = parentTask?.id ?? null;
  await c.db.prepare(
    `INSERT INTO tasks (id, project_id, key, title, brief, criteria, status, priority, created_by, assignee_id, reviewer_id, parent_id, due_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id(), p.id, key, required(input.title, 'title'), input.brief ?? '', JSON.stringify(input.criteria ?? []), status,
    input.priority ?? 2, c.me.id, assignee, reviewer, parent, input.due_at ?? null, t, t).run();
  const task = await getTask(c.db, key);
  await event(c, task.id, 'created', status === 'inbox' ? 'Proposed' : null, { status });
  return task;
}

/** Atomic claim: one conditional UPDATE, so only one member can hold a task. */
export async function claimTask(c: Ctx, key: string) {
  await sweepLeases(c);
  const t = await getTask(c.db, key);
  const now = nowIso(c);
  const r = await c.db.prepare(
    `UPDATE tasks SET status = 'in_progress', assignee_id = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND (
       (status = 'ready' AND (assignee_id IS NULL OR assignee_id = ?)) OR
       (status IN ('in_progress','blocked') AND assignee_id = ?)
     )`).bind(c.me.id, leaseFor(c, c.me), now, t.id, c.me.id, c.me.id).run();
  if (!r.meta.changes) {
    const holder = t.assignee_id ? (await getMember(c.db, t.assignee_id)).name : null;
    throw new KunlaError(409, t.status === 'in_progress' || t.status === 'blocked'
      ? `${t.key} is already claimed by ${holder}.`
      : t.status === 'ready' ? `${t.key} is assigned to ${holder}.` : `${t.key} is ${t.status}, not ready to claim.`);
  }
  if (t.assignee_id !== c.me.id || t.status !== 'in_progress') await event(c, t.id, 'claimed');
  return getTask(c.db, t.id);
}

export async function heartbeat(c: Ctx, key: string) {
  const t = await getTask(c.db, key);
  if (t.assignee_id !== c.me.id || t.status !== 'in_progress') throw new KunlaError(409, `You don't hold ${t.key}; claim it first.`);
  await touch(c, t.id, { lease_expires_at: leaseFor(c, c.me) });
  return { key: t.key, lease_expires_at: leaseFor(c, c.me) };
}

export async function updateTask(c: Ctx, key: string, input: {
  note?: string; status?: Status; blocked_question?: string; blocked_on?: string;
  title?: string; brief?: string; criteria?: string[]; priority?: number; assignee?: string | null; reviewer?: string | null;
}) {
  let t = await getTask(c.db, key);
  const fields: Partial<Task> = {};
  if (input.title) fields.title = input.title;
  if (input.brief !== undefined) fields.brief = input.brief;
  if (input.criteria) fields.criteria = JSON.stringify(input.criteria);
  if (input.priority !== undefined) fields.priority = input.priority;
  if (input.assignee !== undefined) fields.assignee_id = input.assignee ? (await getMember(c.db, input.assignee)).id : null;
  if (input.reviewer !== undefined) fields.reviewer_id = input.reviewer ? (await getMember(c.db, input.reviewer)).id : null;
  if (input.blocked_question) {
    fields.status = 'blocked';
    fields.blocked_question = input.blocked_question;
    fields.blocked_on_id = input.blocked_on ? (await getMember(c.db, input.blocked_on)).id : null;
  } else if (input.status) {
    if (!STATUSES.includes(input.status)) throw new KunlaError(400, `Unknown status ${input.status}.`);
    if (input.status === 'review') throw new KunlaError(400, 'Use submit_for_review to move a task to Review; it needs a deliverable.');
    if (input.status === 'done' && t.status === 'review') throw new KunlaError(400, 'Use review_task to approve a task in Review.');
    fields.status = input.status;
    if (t.status === 'blocked' && input.status !== 'blocked') { fields.blocked_question = null; fields.blocked_on_id = null; }
    if (input.status === 'ready') { fields.assignee_id = fields.assignee_id ?? null; fields.lease_expires_at = null; }
    if (input.status === 'in_progress' && !t.assignee_id) { fields.assignee_id = c.me.id; fields.lease_expires_at = leaseFor(c, c.me); }
  }
  // Any update by the holder also renews the lease.
  if (t.assignee_id === c.me.id && (fields.status ?? t.status) === 'in_progress') fields.lease_expires_at = leaseFor(c, c.me);
  if (Object.keys(fields).length) await touch(c, t.id, fields);
  const type = input.blocked_question ? 'blocked' : fields.status && fields.status !== t.status ? 'status' : 'note';
  if (input.note || type !== 'note' || Object.keys(fields).length)
    await event(c, t.id, type, input.note ?? input.blocked_question ?? null, { from: t.status, to: fields.status ?? t.status });
  if (fields.status === 'done' || fields.status === 'declined') await rollUp(c, t.parent_id);
  return getTask(c.db, t.id);
}

export async function addDeliverables(c: Ctx, taskId: string, links: { url: string; title?: string }[] = []) {
  for (const d of links) {
    if (!d?.url) continue;
    if (!/^https?:\/\//i.test(d.url)) throw new KunlaError(400, `Deliverable links must start with http:// or https:// (got ${String(d.url).slice(0, 60)}).`);
    await c.db.prepare('INSERT OR IGNORE INTO deliverables (id, task_id, url, title, added_by, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id(), taskId, d.url, d.title ?? null, c.me.id, nowIso(c)).run();
  }
}

/**
 * Work that started outside the queue (a chat, a quick fix) still lands in the record.
 * With a task key it adds to that task; without one it creates a task with a key.
 */
export async function logWork(c: Ctx, input: {
  summary: string; task?: string; project?: string; title?: string;
  deliverables?: { url: string; title?: string }[]; status?: 'in_progress' | 'review' | 'done';
}) {
  const summary = required(input.summary, 'summary');
  for (const d of input.deliverables ?? []) if (d?.url && !/^https?:\/\//i.test(d.url)) throw new KunlaError(400, 'Deliverable links must start with http:// or https://.');
  if (input.task) {
    const t = await getTask(c.db, input.task);
    await addDeliverables(c, t.id, input.deliverables);
    await event(c, t.id, 'work_logged', summary, { deliverables: input.deliverables ?? [] });
    if (t.assignee_id === c.me.id && t.status === 'in_progress') await touch(c, t.id, { lease_expires_at: leaseFor(c, c.me) });
    if (input.status === 'review') return submitForReview(c, t.key, { summary, deliverables: input.deliverables ?? [] });
    return getTask(c.db, t.id);
  }
  const status = input.status ?? 'done';
  const p = input.project?.trim() ? await getProject(c.db, input.project) : await getWorkspace(c.db);
  const seq = await c.db.prepare('UPDATE projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq').bind(p.id).first<{ next_seq: number }>();
  const key = `${p.key}-${seq!.next_seq}`;
  const t = nowIso(c);
  await c.db.prepare(
    `INSERT INTO tasks (id, project_id, key, title, brief, status, origin, created_by, assignee_id, lease_expires_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id(), p.id, key, input.title?.trim() || summary.slice(0, 80), summary,
    status === 'review' ? 'in_progress' : status, 'logged', c.me.id, c.me.id,
    status === 'in_progress' ? leaseFor(c, c.me) : null, t, t).run();
  const task = await getTask(c.db, key);
  await event(c, task.id, 'work_logged', summary, { deliverables: input.deliverables ?? [] });
  await addDeliverables(c, task.id, input.deliverables);
  if (status === 'review') return submitForReview(c, key, { summary, deliverables: input.deliverables ?? [] });
  return task;
}

export async function submitForReview(c: Ctx, key: string, input: { summary: string; deliverables: { url: string; title?: string }[]; reviewer?: string }) {
  const t = await getTask(c.db, key);
  if (!input.deliverables?.some((d) => d?.url)) throw new KunlaError(400, 'Attach at least one deliverable link (a PR, doc, file or message) so the reviewer can see the work.');
  if (!['in_progress', 'blocked', 'ready'].includes(t.status)) throw new KunlaError(409, `${t.key} is ${t.status}; only work in progress can go to Review.`);
  if (t.assignee_id && t.assignee_id !== c.me.id && c.me.kind === 'ai') throw new KunlaError(403, `${t.key} is held by someone else.`);
  await addDeliverables(c, t.id, input.deliverables);
  const reviewer = input.reviewer ? (await getMember(c.db, input.reviewer)).id : t.reviewer_id;
  await touch(c, t.id, { status: 'review', assignee_id: t.assignee_id ?? c.me.id, lease_expires_at: null, reviewer_id: reviewer, blocked_question: null, blocked_on_id: null });
  await event(c, t.id, 'submitted', required(input.summary, 'summary'), { deliverables: input.deliverables });
  return getTask(c.db, t.id);
}

export async function reviewTask(c: Ctx, key: string, input: {
  verdict: 'approved' | 'changes_requested'; comment?: string; what_was_wrong?: string; rule?: string;
}) {
  const t = await getTask(c.db, key);
  if (t.status !== 'review') throw new KunlaError(409, `${t.key} is ${t.status}, not in Review.`);
  if (t.assignee_id === c.me.id) throw new KunlaError(403, "You can't review your own work.");
  const p = await getProject(c.db, t.project_id);
  if (p.require_human_review && c.me.kind !== 'human') throw new KunlaError(403, `Project ${p.key} requires a person to review.`);
  if (!['approved', 'changes_requested'].includes(input.verdict)) throw new KunlaError(400, 'verdict must be approved or changes_requested.');
  if (input.verdict === 'changes_requested' && !input.comment && !input.what_was_wrong) throw new KunlaError(400, 'Say what needs to change.');
  const rid = id();
  await c.db.prepare('INSERT INTO reviews (id, task_id, reviewer_id, worker_id, verdict, comment, what_was_wrong, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(rid, t.id, c.me.id, t.assignee_id, input.verdict, input.comment ?? null, input.what_was_wrong ?? null, nowIso(c)).run();
  let ruleId: string | null = null;
  if (input.rule?.trim()) {
    ruleId = id();
    await c.db.prepare('INSERT INTO rules (id, project_id, text, review_id, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .bind(ruleId, p.id, input.rule.trim(), rid, c.me.id, nowIso(c)).run();
    await event(c, t.id, 'rule_added', input.rule.trim(), { rule_id: ruleId });
  }
  if (input.verdict === 'approved') {
    await touch(c, t.id, { status: 'done', reviewer_id: c.me.id });
    await rollUp(c, t.parent_id);
  } else {
    const assignee = t.assignee_id ? await getMember(c.db, t.assignee_id) : null;
    await touch(c, t.id, {
      status: 'in_progress', reviewer_id: c.me.id, review_rounds: t.review_rounds + 1,
      lease_expires_at: assignee ? leaseFor(c, assignee) : null,
    });
  }
  await event(c, t.id, input.verdict, [input.comment, input.what_was_wrong].filter(Boolean).join('\n') || null, { review_id: rid, rule_id: ruleId });
  if (input.verdict === 'changes_requested' && t.review_rounds + 1 >= MAX_REVIEW_ROUNDS)
    await event(c, t.id, 'flagged', `${t.review_rounds + 1} review rounds; a person should look at the brief.`, {}, null);
  return getTask(c.db, t.id);
}

/** When the last sub-task finishes, the parent finishes too, with a note saying why. */
export async function rollUp(c: Ctx, parentId: string | null) {
  if (!parentId) return;
  const parent = await getTask(c.db, parentId);
  if (!['ready', 'in_progress', 'blocked'].includes(parent.status)) return;
  const r = await c.db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('done','declined') THEN 1 ELSE 0 END) AS finished FROM tasks WHERE parent_id = ?`)
    .bind(parentId).first<{ n: number; finished: number }>();
  if (!r?.n || r.finished < r.n) return;
  await touch(c, parentId, { status: 'done', lease_expires_at: null, blocked_question: null, blocked_on_id: null });
  await event(c, parentId, 'rolled_up', `All ${r.n} sub-tasks are finished, so ${parent.key} is done.`, {}, null);
}

/** Open tasks whose titles look like this one, so nobody (person or agent) files the same work twice. */
export async function similarOpenTasks(db: D1Database, title: string, projectKey?: string) {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9äöüß ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const mine = words(title);
  if (!mine.size) return [];
  const rows = (await db.prepare(
    `SELECT t.key, t.title, t.status FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.status IN ('inbox','ready','in_progress','blocked','review') ${projectKey ? 'AND p.key = ?' : ''} LIMIT 500`)
    .bind(...(projectKey ? [projectKey.toUpperCase()] : [])).all<{ key: string; title: string; status: string }>()).results;
  return rows.map((r) => {
    const theirs = words(r.title);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return { ...r, score: shared / Math.max(1, Math.min(mine.size, theirs.size)) };
  }).filter((r) => r.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * Housekeeping that runs lazily on reads, like lease expiry: proposals nobody triaged for
 * two weeks are declined with a note, so the Inbox never turns into a graveyard.
 */
export async function tidy(c: Ctx) {
  const cutoff = new Date((c.now ? c.now() : new Date()).getTime() - PROPOSAL_DAYS * 86400_000).toISOString();
  const old = (await c.db.prepare(`SELECT id, key FROM tasks WHERE status = 'inbox' AND updated_at < ?`).bind(cutoff).all<{ id: string; key: string }>()).results;
  for (const t of old) {
    await touch(c, t.id, { status: 'declined' });
    await event(c, t.id, 'tidied', `Nobody picked this proposal up in ${PROPOSAL_DAYS} days, so Kunla closed it. Reopen it by moving it to Ready.`, {}, null);
  }
  return old.length;
}

/** Triage a proposal from the Inbox. */
export async function triage(c: Ctx, key: string, input: { accept: boolean; note?: string }) {
  const t = await getTask(c.db, key);
  if (t.status !== 'inbox') throw new KunlaError(409, `${t.key} is not in the Inbox.`);
  if (c.me.kind !== 'human') throw new KunlaError(403, 'Only people triage proposals.');
  await touch(c, t.id, { status: input.accept ? 'ready' : 'declined' });
  await event(c, t.id, input.accept ? 'accepted' : 'declined', input.note ?? null);
  return getTask(c.db, t.id);
}

/** Answer a blocked task's question; the task goes back to its worker. */
export async function answer(c: Ctx, key: string, text: string) {
  const t = await getTask(c.db, key);
  if (t.status !== 'blocked') throw new KunlaError(409, `${t.key} is not blocked.`);
  const holder = t.assignee_id ? await getMember(c.db, t.assignee_id) : null;
  await touch(c, t.id, {
    status: holder ? 'in_progress' : 'ready', blocked_question: null, blocked_on_id: null,
    lease_expires_at: holder ? leaseFor(c, holder) : null,
  });
  await event(c, t.id, 'answered', required(text, 'answer'), { question: t.blocked_question });
  return getTask(c.db, t.id);
}

// ---------- reads ----------

export function references(baseUrl: string, t: Pick<Task, 'key' | 'title'>, projectName: string) {
  const link = `${baseUrl}/t/${t.key}`;
  const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return {
    link,
    commit_trailer: `Task: ${t.key} ${link}`,
    branch: `${t.key.toLowerCase()}-${slug}`,
    pr_title: `${t.key}: ${t.title}`,
    doc_source_line: `Source: ${t.key} (${projectName}) ${link}`,
    message_line: `Re ${t.key}: ${link}`,
  };
}

export async function taskDetail(c: Ctx, key: string) {
  await sweepLeases(c);
  const t = await getTask(c.db, key);
  const p = await getProject(c.db, t.project_id);
  const [deliverables, events, rules, reviews, subtasks] = await Promise.all([
    c.db.prepare('SELECT url, title, created_at FROM deliverables WHERE task_id = ? ORDER BY created_at').bind(t.id).all(),
    c.db.prepare(`SELECT e.id, e.type, e.note, e.data, e.created_at, m.name AS actor, m.kind AS actor_kind
                  FROM events e LEFT JOIN members m ON m.id = e.actor_id WHERE e.task_id = ? ORDER BY e.id DESC LIMIT 50`).bind(t.id).all(),
    c.db.prepare(`SELECT r.id, r.text, r.created_at, p.key AS project FROM rules r JOIN projects p ON p.id = r.project_id
                  WHERE (r.project_id = ? OR p.kind = 'workspace') AND r.active = 1 ORDER BY p.kind DESC, r.created_at`).bind(p.id).all(),
    c.db.prepare(`SELECT r.verdict, r.comment, r.what_was_wrong, r.created_at, m.name AS reviewer FROM reviews r
                  JOIN members m ON m.id = r.reviewer_id WHERE r.task_id = ? ORDER BY r.created_at`).bind(t.id).all(),
    c.db.prepare(`SELECT t.key, t.title, t.status, m.name AS assignee FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id
                  WHERE t.parent_id = ? ORDER BY t.created_at`).bind(t.id).all(),
  ]);
  const parent = t.parent_id ? await c.db.prepare('SELECT key, title, status FROM tasks WHERE id = ?').bind(t.parent_id).first() : null;
  const ws = p.kind === 'workspace' ? p : await getWorkspace(c.db);
  const names = await memberNames(c.db);
  return {
    ...publicTask(t, names),
    project: p.kind === 'workspace' ? null : { key: p.key, name: p.name, require_human_review: !!p.require_human_review, focus: !!p.focus, ends_at: p.ends_at },
    workspace: { key: ws.key, name: ws.name },
    parent,
    playbook: [ws.playbook, p.kind === 'workspace' ? '' : p.playbook].filter((x) => x?.trim()).join('\n\n'),
    rules: rules.results,
    deliverables: deliverables.results,
    reviews: reviews.results,
    subtasks: subtasks.results,
    history: events.results.map((e: any) => ({ ...e, data: JSON.parse(e.data || '{}') })),
    references: references(c.baseUrl, t, p.name),
  };
}

async function memberNames(db: D1Database) {
  const map = new Map<string, Member>();
  for (const m of await listMembers(db)) map.set(m.id, m);
  return map;
}

function publicTask(t: Task & { project_key?: string | null; project_kind?: string; parent_key?: string | null; sub_total?: number; sub_done?: number }, names: Map<string, Member>) {
  const who = (mid: string | null) => (mid && names.get(mid) ? { id: mid, name: names.get(mid)!.name, kind: names.get(mid)!.kind } : null);
  return {
    key: t.key,
    ...(t.project_kind !== undefined ? { project: t.project_kind === 'workspace' ? null : t.project_key } : {}),
    ...(t.parent_key !== undefined ? { parent: t.parent_key } : {}),
    ...(t.sub_total ? { subtasks: { total: t.sub_total, done: t.sub_done ?? 0 } } : {}), title: t.title, brief: t.brief, criteria: parseList(t.criteria), status: t.status,
    priority: t.priority, origin: t.origin, assignee: who(t.assignee_id), reviewer: who(t.reviewer_id),
    created_by: who(t.created_by), lease_expires_at: t.lease_expires_at, blocked_question: t.blocked_question,
    blocked_on: who(t.blocked_on_id), review_rounds: t.review_rounds, due_at: t.due_at,
    created_at: t.created_at, updated_at: t.updated_at,
  };
}

export async function listTasks(c: Ctx, f: { project?: string; status?: string; assignee?: string; q?: string; limit?: number; updated_since?: string } = {}) {
  await sweepLeases(c);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.project) { where.push('p.key = ?'); args.push(f.project.toUpperCase()); }
  if (f.status) { const s = f.status.split(','); where.push(`t.status IN (${s.map(() => '?').join(',')})`); args.push(...s); }
  if (f.assignee) { where.push('t.assignee_id = ?'); args.push(f.assignee === 'me' ? c.me.id : (await getMember(c.db, f.assignee)).id); }
  if (f.q) { where.push('(t.title LIKE ? OR t.brief LIKE ? OR t.key = ?)'); args.push(`%${f.q}%`, `%${f.q}%`, f.q.toUpperCase()); }
  if (f.updated_since) { where.push('t.updated_at > ?'); args.push(f.updated_since); }
  const rows = (await c.db.prepare(
    `SELECT t.*, p.key AS project_key, p.kind AS project_kind, pt.key AS parent_key,
       (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS sub_total,
       (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.status IN ('done','declined')) AS sub_done
     FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN tasks pt ON pt.id = t.parent_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.priority, t.updated_at DESC LIMIT ?`).bind(...args, Math.min(f.limit ?? 200, 1000)).all<Task>()).results;
  const names = await memberNames(c.db);
  return rows.map((t) => publicTask(t, names));
}

/** The best next thing for me to do: my work in progress, then my assigned work, then reviews, then open work. */
export async function nextTask(c: Ctx, project?: string) {
  await sweepLeases(c);
  // Steering: an explicit project wins; otherwise open work is limited to the member's lane
  // and offered in focus order (focused projects, then rank, then workspace-level work).
  const lane = parseList(c.me.scope);
  const keys = project ? [project.toUpperCase()] : [];
  const proj = keys.length ? 'AND p.key = ?' : '';
  const laneSql = !keys.length && lane.length ? `AND (p.key IN (${lane.map(() => '?').join(',')}) OR p.kind = 'workspace')` : '';
  const laneArgs = !keys.length ? lane : [];
  const q = (sql: string, useLane: boolean, ...args: unknown[]) =>
    c.db.prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${sql} ${proj} ${useLane ? laneSql : ''}
                  ORDER BY p.focus DESC, CASE p.kind WHEN 'workspace' THEN 1 ELSE 0 END, p.rank, t.priority, coalesce(t.due_at, p.ends_at, '9999'), t.created_at LIMIT 1`)
      .bind(...args, ...keys, ...(useLane ? laneArgs : [])).first<Task>();
  const picks: [string, Task | null][] = [
    ['continue', await q(`t.status = 'in_progress' AND t.assignee_id = ?`, false, c.me.id)],
    ['assigned', await q(`t.status = 'ready' AND t.assignee_id = ?`, false, c.me.id)],
    ['review', await q(`t.status = 'review' AND t.reviewer_id = ? AND (t.assignee_id IS NULL OR t.assignee_id != ?)`, false, c.me.id, c.me.id)],
    ['open', await q(`t.status = 'ready' AND t.assignee_id IS NULL AND NOT EXISTS (SELECT 1 FROM tasks s WHERE s.parent_id = t.id AND s.status NOT IN ('done','declined'))`, true)],
  ];
  const hit = picks.find(([, t]) => t);
  const focus = (await listProjects(c.db)).filter((p) => p.focus).map((p) => `${p.key} ${p.name}`);
  if (!hit) return null;
  return { reason: hit[0], focus, lane: lane.length ? lane : 'all projects', task: await taskDetail(c, hit[1]!.key) };
}

/** The decision inbox: everything waiting on a person. The home screen. */
export async function inbox(c: Ctx) {
  await sweepLeases(c);
  const names = await memberNames(c.db);
  const mine = c.me.id;
  const reviews = (await c.db.prepare(
    `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.status = 'review'
     AND (t.reviewer_id = ? OR (t.reviewer_id IS NULL AND (t.assignee_id IS NULL OR t.assignee_id != ?)))
     ORDER BY t.priority, t.updated_at`).bind(mine, mine).all<Task>()).results;
  const questions = (await c.db.prepare(
    `SELECT * FROM tasks WHERE status = 'blocked' AND (blocked_on_id = ? OR blocked_on_id IS NULL) ORDER BY priority, updated_at`)
    .bind(mine).all<Task>()).results;
  const proposals = (await c.db.prepare(`SELECT * FROM tasks WHERE status = 'inbox' ORDER BY priority, created_at`).all<Task>()).results;
  const flagged = (await c.db.prepare(
    `SELECT * FROM tasks WHERE review_rounds >= ? AND status = 'in_progress' ORDER BY updated_at`).bind(MAX_REVIEW_ROUNDS).all<Task>()).results;
  const withSummary = async (t: Task) => {
    const sub = await c.db.prepare(`SELECT note FROM events WHERE task_id = ? AND type IN ('submitted','work_logged') ORDER BY id DESC LIMIT 1`).bind(t.id).first<{ note: string }>();
    const dels = (await c.db.prepare('SELECT url, title FROM deliverables WHERE task_id = ?').bind(t.id).all()).results;
    return { ...publicTask(t, names), summary: sub?.note ?? null, deliverables: dels };
  };
  const items = [
    ...(await Promise.all(reviews.map(withSummary))).map((t) => ({ kind: 'review' as const, task: t })),
    ...questions.map((t) => ({ kind: 'question' as const, task: publicTask(t, names) })),
    ...proposals.map((t) => ({ kind: 'proposal' as const, task: publicTask(t, names) })),
    ...flagged.map((t) => ({ kind: 'flagged' as const, task: publicTask(t, names) })),
  ];
  return { count: items.length, items };
}

/** Project progress for people and agents: counts, who is on what, blockers, recent activity. */
export async function projectStatus(c: Ctx, project?: string) {
  await sweepLeases(c);
  const p = project ? await getProject(c.db, project) : null;
  const pw = p ? 'AND t.project_id = ?' : '';
  const pa = p ? [p.id] : [];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of (await c.db.prepare(`SELECT status, COUNT(*) AS n FROM tasks t WHERE 1=1 ${pw} GROUP BY status`).bind(...pa).all<{ status: Status; n: number }>()).results)
    counts[r.status] = r.n;
  const names = await memberNames(c.db);
  const active = (await c.db.prepare(`SELECT t.* FROM tasks t WHERE t.status IN ('in_progress','blocked','review') ${pw} ORDER BY t.updated_at DESC`).bind(...pa).all<Task>()).results;
  const byMember = new Map<string, { member: { name: string; kind: Kind }; tasks: { key: string; title: string; status: Status }[] }>();
  for (const t of active) {
    if (!t.assignee_id || !names.get(t.assignee_id)) continue;
    const m = names.get(t.assignee_id)!;
    if (!byMember.has(m.id)) byMember.set(m.id, { member: { name: m.name, kind: m.kind }, tasks: [] });
    byMember.get(m.id)!.tasks.push({ key: t.key, title: t.title, status: t.status });
  }
  const weekAgo = new Date((c.now ? c.now() : new Date()).getTime() - 7 * 86400_000).toISOString();
  const recent = (await c.db.prepare(
    `SELECT e.type, e.note, e.created_at, t.key, t.title, m.name AS actor, m.kind AS actor_kind FROM events e
     JOIN tasks t ON t.id = e.task_id LEFT JOIN members m ON m.id = e.actor_id
     WHERE e.created_at > ? ${pw} ORDER BY e.id DESC LIMIT 30`).bind(weekAgo, ...pa).all()).results;
  const doneWeek = (await c.db.prepare(
    `SELECT COUNT(DISTINCT e.task_id) AS n FROM events e JOIN tasks t ON t.id = e.task_id
     WHERE e.type IN ('approved') AND e.created_at > ? ${pw}`).bind(weekAgo, ...pa).first<{ n: number }>())?.n ?? 0;
  // Share of recorded changes made by AIs or Kunla itself rather than people: the "nobody had to ask" metric.
  const auto = await c.db.prepare(
    `SELECT SUM(CASE WHEN m.kind = 'ai' OR e.actor_id IS NULL THEN 1 ELSE 0 END) AS a, COUNT(*) AS n FROM events e
     JOIN tasks t ON t.id = e.task_id LEFT JOIN members m ON m.id = e.actor_id
     WHERE e.created_at > ? AND e.type NOT IN ('approved','changes_requested','rule_added','answered','accepted','declined') ${pw}`)
    .bind(weekAgo, ...pa).first<{ a: number; n: number }>();
  return {
    project: p ? { key: p.key, name: p.name } : null,
    counts,
    approved_last_7_days: doneWeek,
    agent_recorded_share: auto?.n ? Math.round(((auto.a ?? 0) / auto.n) * 100) : null,
    blocked: active.filter((t) => t.status === 'blocked').map((t) => ({ key: t.key, title: t.title, question: t.blocked_question })),
    who_is_on_what: [...byMember.values()],
    recent,
    link: `${c.baseUrl}/app/#/status${p ? '/' + p.key : ''}`,
  };
}

/** One line of nudge for agents, carried inside tool replies so nobody has to chase. */
export async function reminders(c: Ctx): Promise<string[]> {
  const cutoff = new Date((c.now ? c.now() : new Date()).getTime() - STALE_HOURS * 3600_000).toISOString();
  const stale = (await c.db.prepare(
    `SELECT key FROM tasks WHERE assignee_id = ? AND status = 'in_progress' AND updated_at < ? LIMIT 3`).bind(c.me.id, cutoff).all<{ key: string }>()).results;
  const out = stale.map((s) => `${s.key} has no update for ${STALE_HOURS}+ hours; add a note with log_work or submit it.`);
  const changes = (await c.db.prepare(
    `SELECT t.key FROM tasks t WHERE t.assignee_id = ? AND t.status = 'in_progress' AND t.review_rounds > 0
     AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.type = 'changes_requested' AND e.created_at >= t.updated_at) LIMIT 3`)
    .bind(c.me.id).all<{ key: string }>()).results;
  for (const t of changes) out.push(`${t.key} came back with changes requested; get_task shows the review.`);
  return out;
}

export async function whoami(c: Ctx) {
  const projects = await listProjects(c.db);
  const sponsor = c.me.sponsor_id ? await getMember(c.db, c.me.sponsor_id) : null;
  return {
    id: c.me.id, name: c.me.name, kind: c.me.kind, platform: c.me.platform, roles: parseList(c.me.roles),
    sponsor: sponsor ? sponsor.name : null,
    workspace: await getWorkspace(c.db).then((w) => ({ key: w.key, name: w.name })),
    lane: parseList(c.me.scope),
    projects: projects.map((p) => ({ key: p.key, name: p.name, focus: !!p.focus, ends_at: p.ends_at })),
    board: c.baseUrl,
  };
}

/** Per-member track record, so autonomy can be earned from evidence. */
export async function trackRecord(db: D1Database) {
  const rows = (await db.prepare(
    `SELECT m.id, m.name, m.kind, m.platform, m.scope, s.name AS sponsor, m.sponsor_id,
       (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status = 'done') AS done,
       (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = m.id AND t.status IN ('in_progress','blocked','review')) AS active,
       (SELECT COUNT(DISTINCT r.task_id) FROM reviews r WHERE r.worker_id = m.id) AS reviewed,
       (SELECT COUNT(DISTINCT r.task_id) FROM reviews r WHERE r.worker_id = m.id AND r.verdict = 'approved'
          AND NOT EXISTS (SELECT 1 FROM reviews r2 WHERE r2.task_id = r.task_id AND r2.verdict = 'changes_requested')) AS first_pass,
       (SELECT MAX(e.created_at) FROM events e WHERE e.actor_id = m.id) AS last_active
     FROM members m LEFT JOIN members s ON s.id = m.sponsor_id WHERE m.removed_at IS NULL ORDER BY m.kind DESC, m.created_at`).all<any>()).results;
  return rows.map((r) => ({ ...r, scope: parseList(r.scope), first_pass_rate: r.reviewed ? Math.round((r.first_pass / r.reviewed) * 100) : null }));
}

export async function listRules(db: D1Database, project?: string) {
  const sql = `SELECT r.id, r.text, r.active, r.created_at, p.key AS project, m.name AS created_by FROM rules r
               JOIN projects p ON p.id = r.project_id LEFT JOIN members m ON m.id = r.created_by
               ${project ? 'WHERE p.key = ?' : ''} ORDER BY r.created_at DESC`;
  return (await (project ? db.prepare(sql).bind(project.toUpperCase()) : db.prepare(sql)).all()).results;
}

export async function setRuleActive(c: Ctx, ruleId: string, active: boolean) {
  if (c.me.kind !== 'human') throw new KunlaError(403, 'Only people can change rules.');
  await c.db.prepare('UPDATE rules SET active = ? WHERE id = ?').bind(active ? 1 : 0, ruleId).run();
}
