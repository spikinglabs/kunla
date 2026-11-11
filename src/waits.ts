// Waiting on, assumptions and how tasks relate (KD-84).
//
// Dependencies are treated as promises, not as a plan to keep up to date:
// - A task can wait on another task, or on a condition ("budget approved", a PR merging). A person's
//   answer is the blocked question that already exists. Each wait names who owes it, so a promise
//   that goes quiet shows up in the Briefing.
// - Waits clear themselves: when the task they wait on finishes, or when the linked PR merges. The
//   waiting task's holder (or an idle continuous agent) is woken.
// - Waiting is not a status. A Ready task that waits is skipped by next_task, and agents can't claim it;
//   people can still start it.
// - Instead of waiting, an agent can state an assumption and carry on. A person confirms or corrects it
//   from the decision inbox; a correction sends the task back with the answer.
// - The Briefing names the one bottleneck (what holds up the most work); the Relations view draws it all.
import { KunlaError, getTask, getMember, event, listMembers, type Ctx, type Task, type Member } from './core';
import { wakeMember } from './wake';
import * as continuous from './continuous';

const nowIso = (c: Ctx) => (c.now ? c.now() : new Date()).toISOString();
const nowMs = (c: Ctx) => (c.now ? c.now() : new Date()).getTime();
const FINISHED = `('done','declined')`;
export const QUIET_PROMISE_DAYS = 2;
const RECENT_MET_DAYS = 3;
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/** SQL: the task aliased `t` waits on something that hasn't happened yet. */
export const WAITING_SQL = (alias = 't') =>
  `EXISTS (SELECT 1 FROM waits w LEFT JOIN tasks wb ON wb.id = w.on_task_id WHERE w.task_id = ${alias}.id AND w.met_at IS NULL AND (w.on_task_id IS NULL OR wb.status NOT IN ${FINISHED}))`;
/** SQL: how many open waits the task aliased `t` has. */
export const WAIT_COUNT_SQL = (alias = 't') =>
  `(SELECT COUNT(*) FROM waits w LEFT JOIN tasks wb ON wb.id = w.on_task_id WHERE w.task_id = ${alias}.id AND w.met_at IS NULL AND (w.on_task_id IS NULL OR wb.status NOT IN ${FINISHED}))`;

export interface WaitInput { task?: string; condition?: string; link?: string; owner?: string }
type WaitRow = {
  id: string; task_id: string; on_task_id: string | null; condition: string | null; link: string | null; owner_id: string | null;
  created_by: string | null; created_at: string; met_at: string | null; met_by: string | null; met_note: string | null;
};

const clean = (s: unknown, max = 300) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const normLink = (u: string) => u.trim().replace(/[#?].*$/, '').replace(/\/+$/, '');

/** A readable name for a link condition: "PR #12 merged" for a pull request, the link itself otherwise. */
function linkCondition(url: string): string {
  const pr = /\/(?:pull|merge_requests|pulls)\/(\d+)/.exec(url);
  if (pr) {
    const repo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)/.exec(url)?.[1];
    return `${repo ? repo + '#' : 'PR #'}${pr[1]} merged`;
  }
  return url;
}

/**
 * Agents and people say what a task waits on in the simplest form they have: a task key ("KD-12"),
 * a link (a PR to be merged), or words ("budget approved"). Objects work too.
 */
export function parseWait(x: unknown): WaitInput {
  if (typeof x === 'string') {
    const s = x.trim();
    if (!s) throw new KunlaError(400, 'An empty waiting_on entry says nothing; name a task key, a link or a condition.');
    if (KEY_RE.test(s)) return { task: s.toUpperCase() };
    if (/^https?:\/\/\S+$/i.test(s)) return { condition: linkCondition(s), link: s };
    return { condition: s };
  }
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    const task = clean(o.task ?? o.key, 40);
    const link = clean(o.link ?? o.url, 500);
    const condition = clean(o.condition ?? o.what, 300) || (link ? linkCondition(link) : '');
    if (task) return { task: task.toUpperCase(), owner: clean(o.owner, 100) || undefined };
    if (!condition) throw new KunlaError(400, 'Each waiting_on entry needs a task key, a condition or a link.');
    if (link && !/^https?:\/\//i.test(link)) throw new KunlaError(400, 'A waiting_on link must start with http:// or https://.');
    return { condition, link: link || undefined, owner: clean(o.owner, 100) || undefined };
  }
  throw new KunlaError(400, 'waiting_on takes task keys, links or conditions, e.g. ["KD-12", "budget approved"].');
}

/** Does `from` (following its own waits and open sub-tasks) lead back to `to`? Then waiting would go in a circle. */
async function reaches(c: Ctx, from: string, to: string): Promise<boolean> {
  const r = await c.db.prepare(
    `WITH RECURSIVE up(id) AS (
       SELECT ?
       UNION
       SELECT w.on_task_id FROM waits w JOIN up ON w.task_id = up.id WHERE w.on_task_id IS NOT NULL AND w.met_at IS NULL
       UNION
       SELECT s.id FROM tasks s JOIN up ON s.parent_id = up.id WHERE s.status NOT IN ${FINISHED}
     ) SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`).bind(from, to).first<{ hit: number }>();
  return !!r;
}

/** Add what a task waits on. Duplicates are skipped; circles, finished tasks and a sub-task waiting on its parent are refused. */
export async function addWaits(c: Ctx, t: Task, items: unknown[]): Promise<string[]> {
  if (!Array.isArray(items)) items = [items];
  const added: string[] = [];
  for (const raw of items) {
    const w = parseWait(raw);
    const owner = w.owner ? (await getMember(c, w.owner)).id : null;
    if (w.task) {
      const b = await getTask(c, w.task);
      if (b.id === t.id) throw new KunlaError(400, `${t.key} can't wait on itself.`);
      if (['done', 'declined'].includes(b.status)) throw new KunlaError(400, `${b.key} is already ${b.status}, so there is nothing to wait for.`);
      if (b.id === t.parent_id) throw new KunlaError(400, `${t.key} is a sub-task of ${b.key}, and ${b.key} only finishes when its sub-tasks do, so ${t.key} can't wait on it.`);
      if (await reaches(c, b.id, t.id)) throw new KunlaError(409, `${b.key} already waits (directly or through other tasks) on ${t.key}, so ${t.key} waiting on ${b.key} would go in a circle. Split out the piece both need as its own task, or agree it first.`);
      const dup = await c.db.prepare('SELECT 1 FROM waits WHERE task_id = ? AND on_task_id = ? AND met_at IS NULL').bind(t.id, b.id).first();
      if (dup) continue;
      await c.db.prepare('INSERT INTO waits (id, space_id, task_id, on_task_id, owner_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), c.space, t.id, b.id, owner, c.me.id ?? null, nowIso(c)).run();
      added.push(b.key);
    } else {
      const link = w.link ? w.link.trim() : null;
      const dup = await c.db.prepare('SELECT 1 FROM waits WHERE task_id = ? AND met_at IS NULL AND (lower(condition) = lower(?) OR (link IS NOT NULL AND link = ?))')
        .bind(t.id, w.condition!, link ? normLink(link) : '').first();
      if (dup) continue;
      await c.db.prepare('INSERT INTO waits (id, space_id, task_id, condition, link, owner_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), c.space, t.id, w.condition!, link ? normLink(link) : null, owner, c.me.id ?? null, nowIso(c)).run();
      added.push(`"${w.condition}"`);
    }
  }
  if (added.length) await event(c, t.id, 'waiting', `Waiting on ${added.join(', ')}`, { on: added });
  return added;
}

/** Open waits of a task that match a reference: a wait id, a task key, a condition's words or its link. */
async function matching(c: Ctx, t: Task, refs: unknown[]): Promise<(WaitRow & { b_key: string | null })[]> {
  const rows = (await c.db.prepare(`SELECT w.*, b.key AS b_key FROM waits w LEFT JOIN tasks b ON b.id = w.on_task_id WHERE w.task_id = ? AND w.met_at IS NULL`)
    .bind(t.id).all<WaitRow & { b_key: string | null }>()).results;
  const out = new Map<string, WaitRow & { b_key: string | null }>();
  for (const r of Array.isArray(refs) ? refs : [refs]) {
    const s = String((r && typeof r === 'object' ? (r as any).id ?? (r as any).task ?? (r as any).condition ?? (r as any).link : r) ?? '').trim();
    if (!s) continue;
    const low = s.toLowerCase();
    const hits = rows.filter((w) => w.id === s || (w.b_key && w.b_key.toLowerCase() === low) || (w.condition && w.condition.toLowerCase() === low)
      || (w.link && w.link === normLink(s)));
    const loose = hits.length ? hits : rows.filter((w) => w.condition && w.condition.toLowerCase().includes(low));
    if (!loose.length) throw new KunlaError(404, `${t.key} isn't waiting on ${s}. It waits on: ${rows.map((w) => w.b_key ?? `"${w.condition}"`).join(', ') || 'nothing'}.`);
    for (const w of loose) out.set(w.id, w);
  }
  return [...out.values()];
}

/** Mark waits as met (the thing happened). Anyone in the workspace can: people and agents keep the record true. */
export async function meetWaits(c: Ctx, t: Task, refs: unknown[], note?: string | null) {
  const ws = await matching(c, t, refs);
  for (const w of ws) await c.db.prepare('UPDATE waits SET met_at = ?, met_by = ?, met_note = ? WHERE id = ?').bind(nowIso(c), c.me.id ?? null, note ?? null, w.id).run();
  const labels = ws.map((w) => w.b_key ?? `"${w.condition}"`);
  if (ws.length) await afterCleared(c, t.id, `${c.me.name} marked ${labels.join(', ')} as met${note ? ` (${note})` : ''}`, labels);
  return ws.length;
}

/** Take waits off (they were wrong, or no longer matter). */
export async function removeWaits(c: Ctx, t: Task, refs: unknown[]) {
  const ws = await matching(c, t, refs);
  for (const w of ws) await c.db.prepare('DELETE FROM waits WHERE id = ?').bind(w.id).run();
  if (ws.length) {
    const what = ws.map((w) => w.b_key ?? `"${w.condition}"`);
    await event(c, t.id, 'wait_removed', `No longer waiting on ${what.join(', ')}`, { on: what });
    if (!(await isWaiting(c, t.id))) await wakeWaiter(c, t.id, `${t.key} no longer waits on anything.`);
  }
  return ws.length;
}

/** Open waits per task in the workspace, for task lists: one small query, usually empty. */
export async function openWaitCounts(c: Ctx): Promise<Map<string, number>> {
  const rows = (await c.db.prepare(
    `SELECT w.task_id, COUNT(*) AS n FROM waits w LEFT JOIN tasks wb ON wb.id = w.on_task_id
     WHERE w.space_id = ? AND w.met_at IS NULL AND (w.on_task_id IS NULL OR wb.status NOT IN ${FINISHED}) GROUP BY w.task_id`).bind(c.space)
    .all<{ task_id: string; n: number }>()).results;
  return new Map(rows.map((r) => [r.task_id, r.n]));
}

export async function isWaiting(c: Ctx, taskId: string): Promise<boolean> {
  return !!(await c.db.prepare(`SELECT 1 AS w FROM tasks t WHERE t.id = ? AND ${WAITING_SQL('t')}`).bind(taskId).first());
}

/** After something a task waited on happened: say so, and if nothing is left, tell whoever picks it up. */
async function afterCleared(c: Ctx, taskId: string, happened: string, met: string[]) {
  const t = await getTask(c, taskId);
  const left = await openWaits(c, t.id);
  if (left.length) {
    await event(c, t.id, 'wait_met', `${happened}. Still waiting on ${left.map((w) => w.label).join(', ')}.`, { met }, c.me?.id ?? null);
    return;
  }
  const line = `${happened}, so ${t.key} can go ahead.`;
  await event(c, t.id, 'unblocked', line, { met }, c.me?.id ?? null);
  await wakeWaiter(c, t.id, line);
}

async function wakeWaiter(c: Ctx, taskId: string, line: string) {
  const t = await getTask(c, taskId);
  if (t.assignee_id && ['ready', 'in_progress', 'blocked'].includes(t.status)) await wakeMember(c, t.assignee_id, 'unblocked', t, line);
  else if (t.status === 'ready') await continuous.wakeIdle(c, t);
}

/** Called whenever a task becomes done or declined: every task waiting on it moves on. */
export async function onFinished(c: Ctx, taskId: string) {
  const ws = (await c.db.prepare(`SELECT w.id, w.task_id, b.key AS b_key, b.status AS b_status FROM waits w JOIN tasks b ON b.id = w.on_task_id
    WHERE w.on_task_id = ? AND w.met_at IS NULL`).bind(taskId).all<{ id: string; task_id: string; b_key: string; b_status: string }>()).results;
  if (!ws.length) return;
  for (const w of ws) await c.db.prepare('UPDATE waits SET met_at = ?, met_note = ? WHERE id = ?').bind(nowIso(c), w.b_status, w.id).run();
  const sys: Ctx = { ...c, me: { ...(c.me ?? {}), id: null } as unknown as Member };
  for (const w of ws) await afterCleared(sys, w.task_id, `${w.b_key} ${w.b_status === 'declined' ? 'was declined' : 'is done'}`, [w.b_key]);
}

/** A PR merged (GitHub webhook): every condition linked to it is met. */
export async function onPrMerged(c: Ctx, url: string) {
  const ws = (await c.db.prepare(`SELECT id, task_id, condition FROM waits WHERE space_id = ? AND link = ? AND met_at IS NULL`).bind(c.space, normLink(url))
    .all<{ id: string; task_id: string; condition: string }>()).results;
  for (const w of ws) {
    await c.db.prepare('UPDATE waits SET met_at = ?, met_note = ? WHERE id = ?').bind(nowIso(c), 'merged on GitHub', w.id).run();
    await afterCleared(c, w.task_id, `"${w.condition}" came true (merged on GitHub)`, [`"${w.condition}"`]);
  }
  return ws.length;
}

type Open = { id: string; kind: 'task' | 'condition'; label: string; task: { key: string; title: string; status: string; holder: { name: string; kind: string } | null } | null;
  condition: string | null; link: string | null; owner: { name: string; kind: string } | null; since: string; added_by: string | null };

/** What a task waits on right now, with who owes each one. */
export async function openWaits(c: Ctx, taskId: string, names?: Map<string, Member> | Promise<Map<string, Member>>): Promise<Open[]> {
  const rows = (await c.db.prepare(
    `SELECT w.*, b.key AS b_key, b.title AS b_title, b.status AS b_status, b.assignee_id AS b_assignee FROM waits w LEFT JOIN tasks b ON b.id = w.on_task_id
     WHERE w.task_id = ? AND w.met_at IS NULL AND (w.on_task_id IS NULL OR b.status NOT IN ${FINISHED}) ORDER BY w.created_at`)
    .bind(taskId).all<WaitRow & { b_key: string | null; b_title: string | null; b_status: string | null; b_assignee: string | null }>()).results;
  if (!rows.length) return [];
  const m = names ? await names : new Map((await listMembers(c)).map((x) => [x.id, x]));
  const who = (id: string | null) => (id && m.get(id) ? { name: m.get(id)!.name, kind: m.get(id)!.kind } : null);
  return rows.map((r) => {
    const holds = r.b_status && ['in_progress', 'blocked', 'review'].includes(r.b_status) || (r.b_status === 'ready' && r.b_assignee);
    return {
      id: r.id, kind: r.on_task_id ? 'task' as const : 'condition' as const,
      label: r.b_key ?? `"${r.condition}"`,
      task: r.b_key ? { key: r.b_key, title: r.b_title!, status: r.b_status!, holder: holds ? who(r.b_assignee) : null } : null,
      condition: r.condition, link: r.link,
      owner: r.on_task_id ? (holds ? who(r.b_assignee) : null) : who(r.owner_id),
      since: r.created_at, added_by: who(r.created_by)?.name ?? null,
    };
  });
}

/** For get_task: what it waits on, what it holds up, and its assumptions. */
export async function detail(c: Ctx, t: Task, namesP: Map<string, Member> | Promise<Map<string, Member>>) {
  const cutoff = new Date(nowMs(c) - RECENT_MET_DAYS * 86400_000).toISOString();
  const [open, met, blocks, assumptions, names] = await Promise.all([
    openWaits(c, t.id, namesP),
    c.db.prepare(`SELECT w.id, w.condition, w.met_at, w.met_note, w.met_by, b.key AS b_key FROM waits w LEFT JOIN tasks b ON b.id = w.on_task_id
                  WHERE w.task_id = ? AND (w.met_at > ? OR (w.met_at IS NULL AND b.status IN ${FINISHED})) ORDER BY w.created_at`).bind(t.id, cutoff)
      .all<{ id: string; condition: string | null; met_at: string | null; met_note: string | null; met_by: string | null; b_key: string | null }>(),
    c.db.prepare(`SELECT DISTINCT x.key, x.title, x.status FROM waits w JOIN tasks x ON x.id = w.task_id
                  WHERE w.on_task_id = ? AND w.met_at IS NULL AND x.status NOT IN ${FINISHED} ORDER BY x.key`).bind(t.id).all<{ key: string; title: string; status: string }>(),
    c.db.prepare(`SELECT * FROM assumptions WHERE task_id = ? ORDER BY created_at`).bind(t.id).all<any>(),
    namesP,
  ]);
  const who = (id: string | null) => (id && names.get(id) ? { name: names.get(id)!.name, kind: names.get(id)!.kind } : null);
  return {
    waiting: open.length > 0,
    waiting_on: open,
    recently_met: met.results.map((r) => ({ id: r.id, label: r.b_key ?? `"${r.condition}"`, met_at: r.met_at, note: r.met_note, by: who(r.met_by)?.name ?? null })),
    blocks: blocks.results,
    assumptions: assumptions.results.map((a: any) => ({ id: a.id, text: a.text, state: a.state, made_by: who(a.made_by), at: a.created_at,
      answer: a.answer, decided_by: who(a.decided_by), decided_at: a.decided_at })),
  };
}

/** Why an agent can't start a task yet, in one line it can act on. */
export async function waitingLine(c: Ctx, t: Task): Promise<string | null> {
  const ws = await openWaits(c, t.id);
  if (!ws.length) return null;
  const parts = ws.map((w) => w.task
    ? `${w.task.key} (${w.task.status.replace('_', ' ')}${w.task.holder ? `, ${w.task.holder.name}` : ', nobody on it'})`
    : `"${w.condition}"${w.owner ? ` (owed by ${w.owner.name})` : ''}`);
  return `${t.key} is waiting on ${parts.join(' and ')}.`;
}

// ---------- assumptions ----------

/** "Assuming X": record it on the task and carry on. People see it in the decision inbox. */
export async function addAssumptions(c: Ctx, t: Task, texts: unknown) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((x) => clean(x, 1000)).filter(Boolean);
  for (const text of list) {
    await c.db.prepare('INSERT INTO assumptions (id, space_id, task_id, text, made_by, created_at) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), c.space, t.id, text, c.me.id ?? null, nowIso(c)).run();
    await event(c, t.id, 'assumed', text);
  }
  return list.length;
}

export async function getAssumption(c: Ctx, id: string) {
  const a = await c.db.prepare('SELECT * FROM assumptions WHERE id = ? AND space_id = ?').bind(id, c.space).first<any>();
  if (!a) throw new KunlaError(404, 'No such assumption.');
  return a;
}

/**
 * A person settles an assumption. Confirm: nothing changes but the record. Correct: the answer goes in
 * the record and the work goes back to whoever did it, so they adjust it (a done task reopens).
 */
export async function settleAssumption(c: Ctx, id: string, input: { confirm?: boolean; correct?: string }) {
  if (c.me.kind !== 'human') throw new KunlaError(403, 'Only a person confirms or corrects an assumption. If your sponsor answered it in your chat, use answer on the task instead.');
  const a = await getAssumption(c, id);
  if (a.state !== 'open') throw new KunlaError(409, `This assumption was already ${a.state}.`);
  const correction = clean(input.correct, 2000);
  if (!input.confirm && !correction) throw new KunlaError(400, 'Confirm it, or say what is right instead.');
  const t = await getTask(c, a.task_id);
  const state = correction ? 'corrected' : 'confirmed';
  await c.db.prepare('UPDATE assumptions SET state = ?, answer = ?, decided_by = ?, decided_at = ? WHERE id = ?').bind(state, correction || null, c.me.id, nowIso(c), id).run();
  if (!correction) {
    await event(c, t.id, 'assumption_confirmed', a.text, { assumption_id: id });
    return { key: t.key, state };
  }
  const worker = a.made_by && a.made_by !== c.me.id ? a.made_by : t.assignee_id;
  const back = ['review', 'done'].includes(t.status) && worker;
  const fields: Partial<Task> = {};
  if (back) {
    const m = await getMember(c, worker!).catch(() => null);
    Object.assign(fields, { status: 'in_progress', assignee_id: worker, lease_expires_at: m?.kind === 'ai' ? new Date(nowMs(c) + 24 * 3_600_000).toISOString() : null });
  }
  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).concat('updated_at = ?').join(', ');
    await c.db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).bind(...Object.values(fields), nowIso(c), t.id).run();
  }
  const note = `Assumed: ${a.text}\nActually: ${correction}`;
  await event(c, t.id, 'assumption_corrected', note, { assumption_id: id, ...(back ? { from: t.status, to: 'in_progress' } : {}) });
  if (worker) await wakeMember(c, worker, 'assumption_corrected', t, note);
  return { key: t.key, state, status: back ? 'in_progress' : t.status };
}

/** Open assumptions for the decision inbox. */
export async function openAssumptions(c: Ctx) {
  return (await c.db.prepare(
    `SELECT t.*, a.id AS a_id, a.text AS a_text, a.created_at AS a_at, a.made_by AS a_by FROM assumptions a JOIN tasks t ON t.id = a.task_id
     WHERE a.space_id = ? AND a.state = 'open' AND t.status != 'parked' ORDER BY a.created_at`).bind(c.space).all<any>()).results;
}

// ---------- the whole picture: relations, bottleneck, quiet promises ----------

type Edge = { from: string; to: string; kind: 'wait' | 'sub'; met?: boolean; wait_id?: string };
type GTask = { id: string; key: string; title: string; status: string; assignee_id: string | null; parent_id: string | null; project_key: string; project_kind: string; updated_at: string; last_at: string | null };

/**
 * Every open relation in the workspace as a graph: tasks and conditions are nodes, an edge runs from
 * what must happen first to what waits on it (sub-tasks point at their parent, which finishes after them).
 */
export async function graph(c: Ctx, opts: { project?: string; subtasks?: boolean; focus?: string } = {}) {
  const cutoff = new Date(nowMs(c) - RECENT_MET_DAYS * 86400_000).toISOString();
  const [waitsR, members, assumR] = await Promise.all([
    c.db.prepare(
      `SELECT w.id, w.task_id, w.on_task_id, w.condition, w.link, w.owner_id, w.created_at, w.met_at FROM waits w JOIN tasks t ON t.id = w.task_id
       LEFT JOIN tasks b ON b.id = w.on_task_id
       WHERE w.space_id = ? AND ((w.met_at IS NULL AND t.status NOT IN ${FINISHED} AND (b.id IS NULL OR b.status NOT IN ${FINISHED})) OR w.met_at > ?)`)
      .bind(c.space, cutoff).all<WaitRow>(),
    listMembers(c),
    c.db.prepare(`SELECT task_id, COUNT(*) AS n FROM assumptions WHERE space_id = ? AND state = 'open' GROUP BY task_id`).bind(c.space).all<{ task_id: string; n: number }>(),
  ]);
  const waits = waitsR.results;
  const ids = new Set<string>();
  for (const w of waits) { ids.add(w.task_id); if (w.on_task_id) ids.add(w.on_task_id); }
  // Sub-tasks: the families of tasks already in the picture, or every open family when asked.
  const famR = await c.db.prepare(
    `SELECT s.id, s.parent_id FROM tasks s JOIN tasks p ON p.id = s.parent_id WHERE s.space_id = ? AND s.status NOT IN ${FINISHED} AND p.status NOT IN ${FINISHED}
     ${opts.subtasks ? '' : 'AND (s.id IN (SELECT value FROM json_each(?)) OR p.id IN (SELECT value FROM json_each(?)))'}`)
    .bind(c.space, ...(opts.subtasks ? [] : [JSON.stringify([...ids]), JSON.stringify([...ids])])).all<{ id: string; parent_id: string }>();
  for (const f of famR.results) { ids.add(f.id); ids.add(f.parent_id); }
  const tasksR = ids.size ? await c.db.prepare(
    `SELECT t.id, t.key, t.title, t.status, t.assignee_id, t.parent_id, t.updated_at, p.key AS project_key, p.kind AS project_kind,
       (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = t.id) AS last_at
     FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...ids])).all<GTask>() : { results: [] as GTask[] };
  const byId = new Map(tasksR.results.map((t) => [t.id, t]));
  const names = new Map(members.map((m) => [m.id, m]));
  const who = (id: string | null) => (id && names.get(id) ? { name: names.get(id)!.name, kind: names.get(id)!.kind } : null);
  const assum = new Map(assumR.results.map((r) => [r.task_id, r.n]));

  const edges: Edge[] = [];
  const conds = new Map<string, { id: string; condition: string; link: string | null; owner: ReturnType<typeof who>; since: string; met: boolean }>();
  for (const w of waits) {
    const to = byId.get(w.task_id)?.key; if (!to) continue;
    if (w.on_task_id) { const from = byId.get(w.on_task_id)?.key; if (from) edges.push({ from, to, kind: 'wait', met: !!w.met_at, wait_id: w.id }); }
    else { const cid = `c-${w.id.slice(0, 8)}`; conds.set(cid, { id: cid, condition: w.condition ?? '', link: w.link, owner: who(w.owner_id), since: w.created_at, met: !!w.met_at }); edges.push({ from: cid, to, kind: 'wait', met: !!w.met_at, wait_id: w.id }); }
  }
  for (const f of famR.results) { const s = byId.get(f.id)?.key, p = byId.get(f.parent_id)?.key; if (s && p) edges.push({ from: s, to: p, kind: 'sub' }); }

  // Held up: everything downstream of a node through open waits (sub-task links don't count: a parent
  // waiting for its own sub-tasks is the plan, not a bottleneck).
  const open = edges.filter((e) => e.kind === 'wait' && !e.met);
  const down = new Map<string, string[]>();
  for (const e of open) { if (!down.has(e.from)) down.set(e.from, []); down.get(e.from)!.push(e.to); }
  const heldUp = (n: string) => { const seen = new Set<string>(); const st = [...(down.get(n) ?? [])]; while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); st.push(...(down.get(x) ?? [])); } return seen; };
  const waitingN = new Map<string, number>();
  for (const e of open) waitingN.set(e.to, (waitingN.get(e.to) ?? 0) + 1);
  const t0 = nowMs(c);
  const quietMs = QUIET_PROMISE_DAYS * 86400_000;
  const quietTask = (t: GTask) => !['done', 'declined'].includes(t.status) && (t.status === 'parked'
    || t0 - new Date(t.last_at && t.last_at > t.updated_at ? t.last_at : t.updated_at).getTime() > quietMs);

  let nodes = [
    ...tasksR.results.map((t) => ({
      id: t.key, type: 'task' as const, key: t.key, title: t.title, status: t.status, project: t.project_kind === 'workspace' ? null : t.project_key,
      holder: who(t.assignee_id), parent: t.parent_id ? byId.get(t.parent_id)?.key ?? null : null,
      waiting: waitingN.get(t.key) ?? 0, holds_up: heldUp(t.key).size, assumptions: assum.get(t.id) ?? 0, quiet: !!(down.has(t.key) && quietTask(t)),
      updated_at: t.updated_at,
    })),
    ...[...conds.values()].map((x) => ({
      id: x.id, type: 'condition' as const, key: null, title: x.condition, status: x.met ? 'met' : 'waiting', project: null,
      holder: x.owner, parent: null, waiting: 0, holds_up: x.met ? 0 : heldUp(x.id).size, assumptions: 0,
      quiet: !x.met && t0 - new Date(x.since).getTime() > quietMs, link: x.link, updated_at: x.since,
    })),
  ];
  let es = edges;
  // One project (or one task's neighbourhood): keep the connected pieces that touch it.
  const keep = (pred: (n: typeof nodes[number]) => boolean) => {
    const adj = new Map<string, string[]>();
    for (const e of es) { (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to); (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from); }
    const seen = new Set<string>(); const st = nodes.filter(pred).map((n) => n.id);
    while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); st.push(...(adj.get(x) ?? [])); }
    nodes = nodes.filter((n) => seen.has(n.id)); es = es.filter((e) => seen.has(e.from) && seen.has(e.to));
  };
  if (opts.focus) keep((n) => n.key === opts.focus!.toUpperCase());
  else if (opts.project) keep((n) => n.project === opts.project!.toUpperCase() || (!n.project && !!n.key?.startsWith(opts.project!.toUpperCase() + '-')));
  return { nodes, edges: es, bottlenecks: bottlenecksOf(nodes) };
}

function bottlenecksOf(nodes: { id: string; key: string | null; title: string; status: string; holder: any; holds_up: number; quiet: boolean; type: string }[]) {
  return nodes.filter((n) => n.holds_up >= 2 && n.status !== 'met')
    .sort((a, b) => b.holds_up - a.holds_up || Number(b.quiet) - Number(a.quiet))
    .slice(0, 3)
    .map((n) => ({ id: n.id, type: n.type, key: n.key, title: n.title, status: n.status, holder: n.holder, holds_up: n.holds_up, quiet: n.quiet }));
}

/**
 * For the Briefing: the biggest bottlenecks, with the keys they hold up so the app can filter by project.
 * One query (open waits with both ends), worked out here, so the Briefing stays one round trip deep.
 */
export async function bottlenecks(c: Ctx) {
  const [rowsR, members] = await Promise.all([c.db.prepare(
    `SELECT w.id, w.condition, w.link, w.owner_id, w.created_at, t.key, b.key AS b_key, b.title AS b_title, b.status AS b_status, b.assignee_id AS b_assignee, b.updated_at AS b_updated
     FROM waits w JOIN tasks t ON t.id = w.task_id LEFT JOIN tasks b ON b.id = w.on_task_id
     WHERE w.space_id = ? AND w.met_at IS NULL AND t.status NOT IN ${FINISHED} AND (b.id IS NULL OR b.status NOT IN ${FINISHED})`).bind(c.space)
    .all<{ id: string; condition: string | null; link: string | null; owner_id: string | null; created_at: string; key: string; b_key: string | null; b_title: string | null; b_status: string | null; b_assignee: string | null; b_updated: string | null }>(),
    listMembers(c)]);
  const names = new Map(members.map((m) => [m.id, m]));
  const who = (id: string | null) => (id && names.get(id) ? { name: names.get(id)!.name, kind: names.get(id)!.kind } : null);
  const down = new Map<string, string[]>();
  const info = new Map<string, { id: string; type: 'task' | 'condition'; key: string | null; title: string; status: string; holder: ReturnType<typeof who>; quiet: boolean; link?: string | null; on?: string }>();
  const quietBefore = new Date(nowMs(c) - QUIET_PROMISE_DAYS * 86400_000).toISOString();
  for (const r of rowsR.results) {
    const from = r.b_key ?? `c-${r.id.slice(0, 8)}`;
    if (!down.has(from)) down.set(from, []);
    down.get(from)!.push(r.key);
    if (!info.has(from)) info.set(from, r.b_key
      ? { id: from, type: 'task', key: r.b_key, title: r.b_title!, status: r.b_status!, holder: who(r.b_assignee), quiet: r.b_status === 'parked' || (r.b_updated ?? '') < quietBefore }
      : { id: from, type: 'condition', key: null, title: r.condition ?? '', status: 'waiting', holder: who(r.owner_id), quiet: r.created_at < quietBefore, link: r.link, on: r.key });
  }
  const held = (n: string) => { const seen = new Set<string>(); const st = [...(down.get(n) ?? [])]; while (st.length) { const x = st.pop()!; if (seen.has(x)) continue; seen.add(x); st.push(...(down.get(x) ?? [])); } return [...seen]; };
  return [...info.values()].map((n) => ({ ...n, held: held(n.id) })).map((n) => ({ ...n, holds_up: n.held.length }))
    .filter((n) => n.holds_up >= 2).sort((a, b) => b.holds_up - a.holds_up || Number(b.quiet) - Number(a.quiet)).slice(0, 3);
}

/**
 * Promises that went quiet: a task others wait on that nobody has touched for two days (or that is
 * parked, or that nobody picked up), and conditions nobody has ticked for two days.
 */
export async function quietPromises(c: Ctx) {
  const t0 = nowMs(c);
  const before = new Date(t0 - QUIET_PROMISE_DAYS * 86400_000).toISOString();
  const [rowsR, members] = await Promise.all([c.db.prepare(
    `SELECT w.id, w.created_at, w.condition, w.owner_id, t.key, t.title, t.assignee_id AS t_assignee, t.status AS t_status,
       b.key AS b_key, b.title AS b_title, b.status AS b_status, b.assignee_id AS b_assignee, b.updated_at AS b_updated,
       (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = b.id) AS b_last
     FROM waits w JOIN tasks t ON t.id = w.task_id LEFT JOIN tasks b ON b.id = w.on_task_id
     WHERE w.space_id = ? AND w.met_at IS NULL AND w.created_at < ? AND t.status NOT IN ('done','declined','parked')
       AND (b.id IS NULL OR b.status NOT IN ${FINISHED}) ORDER BY w.created_at LIMIT 50`).bind(c.space, before).all<any>(), listMembers(c)]);
  const names = new Map(members.map((m) => [m.id, m]));
  const days = (ms: number) => { const d = Math.floor(ms / 86400_000); return `${d} day${d === 1 ? '' : 's'}`; };
  const out: { since: string; key: string; title: string; line: string; other?: { key: string; title: string }; member?: { id: string; name: string; kind: string } }[] = [];
  const seen = new Set<string>();
  for (const r of rowsR.results) {
    const waited = days(t0 - new Date(r.created_at).getTime());
    if (r.b_key) {
      if (seen.has(r.b_key)) continue;
      const last = r.b_last && r.b_last > r.b_updated ? r.b_last : r.b_updated;
      const holder = r.b_assignee ? names.get(r.b_assignee) : null;
      let why: string | null = null;
      if (r.b_status === 'parked') why = `${r.b_key} is parked`;
      else if (r.b_status === 'ready' && !holder && last < before) why = `nobody has picked ${r.b_key} up`;
      else if (last < before) why = `${holder ? holder.name + ' has' : 'nobody has'} not touched ${r.b_key} in ${days(t0 - new Date(last).getTime())}`;
      if (!why) continue;
      seen.add(r.b_key);
      out.push({ since: r.created_at, key: r.key, title: r.title, other: { key: r.b_key, title: r.b_title },
        member: holder ? { id: holder.id, name: holder.name, kind: holder.kind } : undefined,
        line: `${r.key} has waited ${waited} on ${r.b_key}, but ${why}.` });
    } else {
      const owner = r.owner_id ? names.get(r.owner_id) : null;
      out.push({ since: r.created_at, key: r.key, title: r.title, member: owner ? { id: owner.id, name: owner.name, kind: owner.kind } : undefined,
        line: `${r.key} has waited ${waited} for "${r.condition}"${owner ? `, owed by ${owner.name}` : ''}. Tick it on the task once it's true.` });
    }
  }
  return out;
}
