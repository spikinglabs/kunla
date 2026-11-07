// Read models for the web app and in-chat views: the briefing, the live pulse, the work map
// and rules with their reach. All derived from the event record; nobody writes a status update.
import { sweepLeases, listMembers } from './core';
import type { Ctx, Member, Task } from './core';

const now = (c: Ctx) => (c.now ? c.now() : new Date());
type Ev = { task_id: string; key: string; title: string; type: string; note: string | null; actor_id: string | null; created_at: string; data: string };

/** What happened since a point in time, per member, for the briefing headline. */
export async function briefing(c: Ctx, sinceHours = 24) {
  await sweepLeases(c);
  const since = new Date(now(c).getTime() - sinceHours * 3600_000).toISOString();
  const rows = (await c.db.prepare(
    `SELECT m.id, m.name, m.kind, e.type, COUNT(DISTINCT e.task_id) AS n FROM events e JOIN members m ON m.id = e.actor_id
     WHERE e.created_at > ? AND e.type IN ('submitted','approved','work_logged','claimed','rule_added','changes_requested')
     GROUP BY m.id, e.type`).bind(since).all<{ id: string; name: string; kind: string; type: string; n: number }>()).results;
  const by = new Map<string, { name: string; kind: string; counts: Record<string, number> }>();
  for (const r of rows) {
    if (!by.has(r.id)) by.set(r.id, { name: r.name, kind: r.kind, counts: {} });
    by.get(r.id)!.counts[r.type] = r.n;
  }
  const finished = (await c.db.prepare(
    `SELECT t.key, t.title, m.name AS worker FROM events e JOIN tasks t ON t.id = e.task_id LEFT JOIN members m ON m.id = t.assignee_id
     WHERE e.type = 'approved' AND e.created_at > ? ORDER BY e.id DESC LIMIT 5`).bind(since).all()).results;
  const rulesAdded = (await c.db.prepare(`SELECT COUNT(*) AS n FROM rules WHERE created_at > ?`).bind(since).first<{ n: number }>())?.n ?? 0;
  return { since, members: [...by.values()], finished, rules_added: rulesAdded };
}

/** One line per member: what they are doing right now, and whether they are live. */
export async function pulse(c: Ctx) {
  await sweepLeases(c);
  const t = now(c).getTime();
  const members = await listMembers(c.db);
  const tasks = (await c.db.prepare(
    `SELECT * FROM tasks WHERE status IN ('in_progress','blocked','review') AND assignee_id IS NOT NULL ORDER BY updated_at DESC`).all<Task>()).results;
  const last = (await c.db.prepare(
    `SELECT e.actor_id, MAX(e.created_at) AS at FROM events e WHERE e.actor_id IS NOT NULL GROUP BY e.actor_id`).all<{ actor_id: string; at: string }>()).results;
  const lastBy = new Map(last.map((l) => [l.actor_id, l.at]));
  const names = new Map(members.map((m) => [m.id, m.name]));
  const pendingReviews = (await c.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'review'`).first<{ n: number }>())?.n ?? 0;
  const pendingQs = (await c.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'blocked'`).first<{ n: number }>())?.n ?? 0;
  return members.map((m) => {
    const mine = tasks.filter((x) => x.assignee_id === m.id);
    const working = mine.find((x) => x.status === 'in_progress');
    const lastAt = lastBy.get(m.id) ?? null;
    const recent = lastAt ? t - new Date(lastAt).getTime() < c.leaseMinutes * 60_000 : false;
    let state: 'working' | 'waiting' | 'blocked' | 'idle' = 'idle';
    let line = lastAt ? 'Last active' : 'Not active yet';
    let task: { key: string; title: string } | null = null;
    let since: string | null = lastAt;
    if (working) {
      state = 'working'; task = { key: working.key, title: working.title }; since = working.updated_at;
      line = `Working on ${working.key} ${working.title}`;
    } else if (mine.find((x) => x.status === 'blocked')) {
      const b = mine.find((x) => x.status === 'blocked')!;
      state = 'blocked'; task = { key: b.key, title: b.title }; since = b.updated_at;
      line = `Blocked on ${b.blocked_on_id ? names.get(b.blocked_on_id) : 'a person'} · ${b.key}`;
    } else if (mine.find((x) => x.status === 'review')) {
      const r = mine.find((x) => x.status === 'review')!;
      state = 'waiting'; task = { key: r.key, title: r.title }; since = r.updated_at;
      line = `Waiting on ${r.reviewer_id ? names.get(r.reviewer_id) : 'a review'} · ${r.key}`;
    } else if (m.kind === 'human' && m.id === c.me.id && pendingReviews + pendingQs > 0) {
      state = 'waiting'; line = `${pendingReviews + pendingQs} decision${pendingReviews + pendingQs > 1 ? 's' : ''} waiting`;
    }
    return { id: m.id, name: m.name, kind: m.kind, platform: m.platform, sponsor: m.sponsor_id ? names.get(m.sponsor_id) ?? null : null, state, live: state === 'working' && recent, line, task, since, other_tasks: mine.length - (task ? 1 : 0) };
  });
}

type Seg = { key: string; title: string; start: string; end: string | null; kind: 'work' | 'wait' | 'decide'; label: string; live?: boolean };

/**
 * The work map: one lane per member over the last days. Solid segments are work, dashed are
 * work waiting on someone, short blocks on people's lanes are their decisions.
 */
export async function workMap(c: Ctx, days = 5) {
  await sweepLeases(c);
  const end = now(c);
  const start = new Date(end.getTime() - days * 86400_000);
  const members = await listMembers(c.db);
  const evs = (await c.db.prepare(
    `SELECT e.task_id, t.key, t.title, e.type, e.note, e.actor_id, e.created_at, e.data FROM events e JOIN tasks t ON t.id = e.task_id
     WHERE e.task_id IN (SELECT DISTINCT task_id FROM events WHERE created_at > ?) OR t.status IN ('in_progress','blocked','review')
     ORDER BY e.id`).bind(start.toISOString()).all<Ev>()).results;
  const tasks = new Map((await c.db.prepare(`SELECT * FROM tasks WHERE id IN (SELECT DISTINCT task_id FROM events WHERE created_at > ?) OR status IN ('in_progress','blocked','review')`)
    .bind(start.toISOString()).all<Task>()).results.map((t) => [t.id, t]));
  const lanes = new Map<string, Seg[]>(members.map((m) => [m.id, []]));
  const push = (mid: string | null | undefined, s: Seg) => { if (mid && lanes.has(mid)) lanes.get(mid)!.push(s); };
  const byTask = new Map<string, Ev[]>();
  for (const e of evs) { if (!byTask.has(e.task_id)) byTask.set(e.task_id, []); byTask.get(e.task_id)!.push(e); }
  const names = new Map(members.map((m) => [m.id, m.name]));

  for (const [taskId, list] of byTask) {
    const task = tasks.get(taskId);
    let worker: string | null = null;
    let open: { seg: Seg; mid: string } | null = null;
    const close = (at: string) => { if (open) { open.seg.end = at; open = null; } };
    const startSeg = (mid: string | null, at: string, kind: 'work' | 'wait', label: string, e: Ev) => {
      close(at);
      if (!mid) return;
      const seg: Seg = { key: e.key, title: e.title, start: at, end: null, kind, label };
      push(mid, seg); open = { seg, mid };
    };
    for (const e of list) {
      const at = e.created_at;
      switch (e.type) {
        case 'claimed': worker = e.actor_id; startSeg(worker, at, 'work', `${e.key} ${e.title}`, e); break;
        case 'work_logged':
          if (!open && e.actor_id) { worker = worker ?? e.actor_id; const s: Seg = { key: e.key, title: e.title, start: new Date(new Date(at).getTime() - 20 * 60_000).toISOString(), end: at, kind: 'work', label: `${e.key} ${e.title}` }; push(e.actor_id, s); }
          break;
        case 'submitted': worker = worker ?? e.actor_id; startSeg(worker, at, 'wait', `${e.key} waiting on ${task?.reviewer_id ? names.get(task.reviewer_id) : 'a review'}`, e); break;
        case 'blocked': startSeg(worker ?? e.actor_id, at, 'wait', `${e.key} blocked on ${task?.blocked_on_id ? names.get(task.blocked_on_id) : 'a person'}`, e); break;
        case 'approved': close(at); push(e.actor_id, { key: e.key, title: e.title, start: new Date(new Date(at).getTime() - 10 * 60_000).toISOString(), end: at, kind: 'decide', label: `Approved ${e.key}` }); break;
        case 'changes_requested':
          close(at); push(e.actor_id, { key: e.key, title: e.title, start: new Date(new Date(at).getTime() - 10 * 60_000).toISOString(), end: at, kind: 'decide', label: `Reviewed ${e.key}` });
          startSeg(worker, at, 'work', `${e.key} ${e.title} (changes)`, e); break;
        case 'answered':
          close(at); push(e.actor_id, { key: e.key, title: e.title, start: new Date(new Date(at).getTime() - 5 * 60_000).toISOString(), end: at, kind: 'decide', label: `Answered ${e.key}` });
          startSeg(worker, at, 'work', `${e.key} ${e.title}`, e); break;
        case 'lease_expired': case 'declined': close(at); worker = null; break;
        case 'status': { const to = (() => { try { return JSON.parse(e.data).to; } catch { return null; } })(); if (to === 'done' || to === 'ready') close(at); break; }
      }
    }
    if (open) {
      const o = open as { seg: Seg; mid: string };
      if (o.seg.kind === 'work') o.seg.live = task?.status === 'in_progress' && end.getTime() - new Date(task.updated_at).getTime() < c.leaseMinutes * 60_000;
    }
  }
  const clip = (s: Seg) => (s.end ?? end.toISOString()) >= start.toISOString();
  const waits = [...lanes.entries()].flatMap(([mid, segs]) => segs.filter((s) => s.kind === 'wait' && !s.end).map((s) => ({
    key: s.key, title: s.title, who: names.get(mid), label: s.label, since: s.start,
  }))).sort((a, b) => a.since.localeCompare(b.since));
  return {
    start: start.toISOString(), end: end.toISOString(),
    lanes: members.map((m: Member) => ({ id: m.id, name: m.name, kind: m.kind, platform: m.platform, segments: lanes.get(m.id)!.filter(clip) })),
    waits,
  };
}

/** Rules with where they came from and how many tasks they have since been sent with. */
export async function rulesWithReach(db: D1Database, project?: string) {
  const sql = `SELECT r.id, r.text, r.active, r.created_at, p.key AS project, m.name AS created_by, t.key AS source_task,
      (SELECT COUNT(DISTINCT e.task_id) FROM events e JOIN tasks t2 ON t2.id = e.task_id
        WHERE t2.project_id = r.project_id AND e.type = 'claimed' AND e.created_at > r.created_at) AS sent_with
    FROM rules r JOIN projects p ON p.id = r.project_id LEFT JOIN members m ON m.id = r.created_by
    LEFT JOIN reviews rv ON rv.id = r.review_id LEFT JOIN tasks t ON t.id = rv.task_id
    ${project ? 'WHERE p.key = ?' : ''} ORDER BY r.created_at DESC`;
  return (await (project ? db.prepare(sql).bind(project.toUpperCase()) : db.prepare(sql)).all()).results;
}
