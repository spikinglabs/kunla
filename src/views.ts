// Read models for the web app and in-chat views: the briefing, the live pulse, the work map
// and rules with their reach. All derived from the event record; nobody writes a status update.
import { sweepLeases, listMembers, taskKind } from './core';
import * as continuous from './continuous';
import * as waits from './waits';
import type { Ctx, Member, Task } from './core';

const now = (c: Ctx) => (c.now ? c.now() : new Date());
type Ev = { task_id: string; key: string; title: string; type: string; note: string | null; actor_id: string | null; created_at: string; data: string };

// ---------- the briefing is the standup (KD-48) ----------
// People don't write status. The Briefing says what happened since you were last here (KD-49), what
// waits on you (the decision deck), and what waits on anyone else for too long (asks, KD-50).

const VISIT_GAP_MS = 60 * 60_000;   // away for more than an hour: the next visit starts a new briefing
const MAX_WINDOW_DAYS = 14;         // a briefing never reaches back further than this
const FIRST_VISIT_HOURS = 24;

/**
 * Where a person's briefing starts. Coming back after a break, it starts where they left off; while
 * they stay (refreshes, coming back within the hour) it holds still, so the page doesn't empty itself.
 */
export async function visitWindow(c: Ctx): Promise<{ since: string; window: 'last_visit' | 'first_visit'; saved: Promise<unknown> }> {
  const t = now(c).getTime();
  // The signed-in member row already carries both columns (memberForToken reads m.*), so no extra round trip.
  const known = c.me as Member & { seen_at?: string | null; visit_from?: string | null };
  const row = 'seen_at' in known ? { seen_at: known.seen_at ?? null, visit_from: known.visit_from ?? null }
    : await c.db.prepare('SELECT seen_at, visit_from FROM members WHERE id = ?').bind(c.me.id).first<{ seen_at: string | null; visit_from: string | null }>();
  let from: number; let window: 'last_visit' | 'first_visit' = 'last_visit';
  if (!row?.seen_at) { from = t - FIRST_VISIT_HOURS * 3600_000; window = 'first_visit'; }
  else if (t - new Date(row.seen_at).getTime() > VISIT_GAP_MS) from = new Date(row.seen_at).getTime();
  else if (row.visit_from) from = new Date(row.visit_from).getTime();
  else { from = t - FIRST_VISIT_HOURS * 3600_000; window = 'first_visit'; }
  from = Math.max(from, t - MAX_WINDOW_DAYS * 86400_000);
  const since = new Date(from).toISOString();
  // Not awaited here: the briefing waits for it alongside its own reads, saving a round trip.
  const saved = c.db.prepare('UPDATE members SET seen_at = ?, visit_from = ? WHERE id = ?').bind(new Date(t).toISOString(), since, c.me.id).run();
  return { since, window, saved };
}

/**
 * What happened since a point in time, per member, for the briefing headline. Without hours a person
 * gets "since you were last here"; with hours (or for an agent) it is a fixed look back.
 */
export async function briefing(c: Ctx, sinceHours?: number) {
  await sweepLeases(c);
  const w = sinceHours === undefined && c.me.kind === 'human' ? await visitWindow(c)
    : { since: new Date(now(c).getTime() - (sinceHours ?? FIRST_VISIT_HOURS) * 3600_000).toISOString(), window: 'hours' as const, saved: null };
  const since = w.since;
  // Independent reads go out together: on Cloudflare each await is a round trip to the database.
  const [rowsR, finishedR, rulesR, tidiedR, asked, bottlenecks] = await Promise.all([
    c.db.prepare(
      `SELECT m.id, m.name, m.kind, e.type, COUNT(DISTINCT e.task_id) AS n FROM events e JOIN members m ON m.id = e.actor_id
       WHERE e.space_id = ? AND e.created_at > ? AND e.type IN ('submitted','approved','work_logged','claimed','rule_added','changes_requested')
       GROUP BY m.id, e.type`).bind(c.space, since).all<{ id: string; name: string; kind: string; type: string; n: number }>(),
    c.db.prepare(
      `SELECT t.key, t.title, m.name AS worker FROM events e JOIN tasks t ON t.id = e.task_id LEFT JOIN members m ON m.id = t.assignee_id
       WHERE e.space_id = ? AND e.type = 'approved' AND e.created_at > ? ORDER BY e.id DESC LIMIT 8`).bind(c.space, since).all(),
    c.db.prepare(`SELECT COUNT(*) AS n FROM rules r JOIN projects p ON p.id = r.project_id WHERE p.space_id = ? AND r.created_at > ?`).bind(c.space, since).first<{ n: number }>(),
    c.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE space_id = ? AND type = 'tidied' AND created_at > ?`).bind(c.space, since).first<{ n: number }>(),
    asks(c),
    waits.bottlenecks(c),
    w.saved,
  ]);
  const by = new Map<string, { name: string; kind: string; counts: Record<string, number> }>();
  for (const r of rowsR.results) {
    if (!by.has(r.id)) by.set(r.id, { name: r.name, kind: r.kind, counts: {} });
    by.get(r.id)!.counts[r.type] = r.n;
  }
  const finished = finishedR.results;
  const rulesAdded = rulesR?.n ?? 0;
  const tidied = tidiedR?.n ?? 0;
  // The one thing holding up the most work (KD-84): what to unstick first.
  return { since, window: w.window, members: [...by.values()], finished, rules_added: rulesAdded, tidied, asks: asked, bottlenecks };
}

// ---------- asks: what waits on someone for too long (KD-50) ----------

const QUIET_DAYS = 2;            // a person's claim with no activity for this long
const REVIEW_WAIT_DAYS = 2;      // a review waiting on someone else
const QUESTION_WAIT_HOURS = 24;  // a blocked question waiting on someone else
const MAX_ASKS = 8;
const BUDGET_STOPS = ['tasks_budget', 'cost_budget', 'tokens_budget', 'review_limit', 'ended'];

export type AskKind = 'budget_stop' | 'question_waiting' | 'review_waiting' | 'quiet_promise' | 'quiet_claim' | 'overlap';
export interface Ask {
  kind: AskKind; line: string; since: string;
  task: { key: string; title: string } | null;
  other?: { key: string; title: string };          // overlap: the second task
  member?: { id: string; name: string; kind: string };
  action: 'open' | 'take_over' | 'limits' | 'compare';
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9äöüß ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
/** Titles that share most of their words. Takes word sets, made once per title: pairs grow with the square. */
function similar(x: Set<string>, y: Set<string>) {
  if (x.size < 2 || y.size < 2) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.6;
}
const days = (ms: number) => { const d = Math.floor(ms / 86400_000); return d >= 1 ? `${d} day${d > 1 ? 's' : ''}` : `${Math.max(1, Math.floor(ms / 3600_000))} hours`; };

/**
 * The standup's real content: things that wait on someone else for too long, which the decision deck
 * (only what waits on you) doesn't show. Each comes with what you can do about it.
 */
export async function asks(c: Ctx): Promise<Ask[]> {
  const t = now(c).getTime();
  const iso = (ms: number) => new Date(t - ms).toISOString();
  const me = c.me?.id ?? '';
  const [members, qsR, rsR, activeR, promises] = await Promise.all([
    listMembers(c),
    c.db.prepare(
    `SELECT key, title, blocked_on_id, assignee_id, updated_at FROM tasks WHERE space_id = ? AND status = 'blocked'
     AND blocked_on_id IS NOT NULL AND blocked_on_id != ? AND updated_at < ? ORDER BY updated_at LIMIT 20`)
    .bind(c.space, me, iso(QUESTION_WAIT_HOURS * 3600_000)).all<{ key: string; title: string; blocked_on_id: string; assignee_id: string | null; updated_at: string }>(),
    c.db.prepare(
    `SELECT key, title, reviewer_id, updated_at FROM tasks WHERE space_id = ? AND status = 'review'
     AND reviewer_id IS NOT NULL AND reviewer_id != ? AND updated_at < ? ORDER BY updated_at LIMIT 20`)
    .bind(c.space, me, iso(REVIEW_WAIT_DAYS * 86400_000)).all<{ key: string; title: string; reviewer_id: string; updated_at: string }>(),
    c.db.prepare(
    `SELECT t.key, t.title, t.status, t.assignee_id, t.parent_id, t.lease_expires_at, t.updated_at,
       (SELECT MAX(e.created_at) FROM events e WHERE e.task_id = t.id) AS last_at,
       EXISTS (SELECT 1 FROM tasks s WHERE s.parent_id = t.id AND s.status NOT IN ('done','declined')) AS has_open_subs
     FROM tasks t WHERE t.space_id = ? AND t.status IN ('in_progress','review','blocked') AND t.assignee_id IS NOT NULL
     ORDER BY t.updated_at DESC LIMIT 200`).bind(c.space).all<{ key: string; title: string; status: string; assignee_id: string; parent_id: string | null; lease_expires_at: string | null; updated_at: string; last_at: string | null; has_open_subs: number }>(),
    waits.quietPromises(c),
  ]);
  const byId = new Map(members.map((m) => [m.id, m]));
  const who = (id: string | null) => (id && byId.get(id)) ? { id, name: byId.get(id)!.name, kind: byId.get(id)!.kind } : undefined;
  const admin = (() => { try { return JSON.parse(c.me?.roles || '[]').includes('admin'); } catch { return false; } })();
  const out: Ask[] = [];

  // Agents stopped by a limit their sponsor set: only the sponsor (or an admin) can lift it.
  for (const m of members) {
    if (m.kind !== 'ai' || (m as any).removed_at) continue;
    if (!(admin || m.sponsor_id === me)) continue;
    const settings = continuous.parseSettings(m.continuous);
    const run = continuous.parseRunState(m.run_state);
    if (!settings?.on || run?.state !== 'stopped' || !run.reason || !BUDGET_STOPS.includes(run.reason)) continue;
    out.push({ kind: 'budget_stop', since: run.at, task: null, member: who(m.id), action: 'limits',
      line: `${m.name} stopped: ${run.message ?? run.reason.replace('_', ' ')}` });
  }

  // Questions blocked on someone other than you, for a day or more.
  const qs = qsR.results;
  for (const q of qs) out.push({ kind: 'question_waiting', since: q.updated_at, task: { key: q.key, title: q.title }, member: who(q.blocked_on_id), action: 'open',
    line: `${who(q.assignee_id)?.name ?? 'Someone'} has waited ${days(t - new Date(q.updated_at).getTime())} for ${who(q.blocked_on_id)?.name ?? 'an answer'} on ${q.key}.` });

  // Reviews waiting on someone else for two days or more.
  const rs = rsR.results;
  for (const r of rs) out.push({ kind: 'review_waiting', since: r.updated_at, task: { key: r.key, title: r.title }, member: who(r.reviewer_id), action: 'open',
    line: `${r.key} has waited ${days(t - new Date(r.updated_at).getTime())} for a review from ${who(r.reviewer_id)?.name ?? 'someone'}.` });

  // Promises that went quiet (KD-84): work others wait on that nobody is moving, conditions nobody ticked.
  for (const q of promises) out.push({ kind: 'quiet_promise', since: q.since, task: { key: q.key, title: q.title }, ...(q.other ? { other: q.other } : {}), member: q.member, action: 'open', line: q.line });

  // Claims that went quiet. An agent's claim lapses by itself (lease); a person's never does, so say it.
  const active = activeR.results;
  for (const a of active) {
    if (a.status !== 'in_progress' || a.lease_expires_at || a.has_open_subs) continue;
    const last = a.last_at && a.last_at > a.updated_at ? a.last_at : a.updated_at;
    if (t - new Date(last).getTime() < QUIET_DAYS * 86400_000) continue;
    const holder = who(a.assignee_id);
    const yours = a.assignee_id === me;
    out.push({ kind: 'quiet_claim', since: last, task: { key: a.key, title: a.title }, member: holder, action: yours || c.me?.kind !== 'human' ? 'open' : 'take_over',
      line: yours ? `You haven't touched ${a.key} in ${days(t - new Date(last).getTime())}. Log progress, or hand it on.`
        : `${holder?.name ?? 'Someone'} has held ${a.key} for ${days(t - new Date(last).getTime())} with no activity.` });
  }

  // Two members working on what looks like the same thing (titles that share most of their words).
  const seen = new Set<string>();
  const titleWords = active.map((a) => words(a.title));
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const x = active[i], y = active[j];
    if (x.assignee_id === y.assignee_id || x.parent_id === y.key || y.parent_id === x.key) continue;
    if (seen.has(x.key) || seen.has(y.key) || !similar(titleWords[i], titleWords[j])) continue;
    seen.add(x.key); seen.add(y.key);
    out.push({ kind: 'overlap', since: x.updated_at > y.updated_at ? x.updated_at : y.updated_at, task: { key: x.key, title: x.title }, other: { key: y.key, title: y.title }, action: 'compare',
      line: `${who(x.assignee_id)?.name ?? 'Someone'} (${x.key}) and ${who(y.assignee_id)?.name ?? 'someone'} (${y.key}) may be doing the same work.` });
  }

  const order: Record<AskKind, number> = { budget_stop: 0, question_waiting: 1, review_waiting: 2, quiet_promise: 3, quiet_claim: 4, overlap: 5 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.since.localeCompare(b.since)).slice(0, MAX_ASKS);
}

/** One line per member: what they are doing right now, and whether they are live. */
export async function pulse(c: Ctx) {
  await sweepLeases(c);
  const t = now(c).getTime();
  const [members, tasksR, lastR, reviewsR, qsR] = await Promise.all([
    listMembers(c),
    c.db.prepare(
      `SELECT * FROM tasks WHERE space_id = ? AND status IN ('in_progress','blocked','review') AND assignee_id IS NOT NULL ORDER BY updated_at DESC`).bind(c.space).all<Task>(),
    // One indexed lookup per member instead of a scan of the whole event log.
    c.db.prepare(
      `SELECT m.id AS actor_id, (SELECT MAX(e.created_at) FROM events e WHERE e.actor_id = m.id) AS at FROM members m WHERE m.space_id = ?`).bind(c.space).all<{ actor_id: string; at: string | null }>(),
    c.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE space_id = ? AND status = 'review'`).bind(c.space).first<{ n: number }>(),
    c.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE space_id = ? AND status = 'blocked'`).bind(c.space).first<{ n: number }>(),
  ]);
  const tasks = tasksR.results;
  const last = lastR.results.filter((l) => l.at) as { actor_id: string; at: string }[];
  const lastBy = new Map(last.map((l) => [l.actor_id, l.at]));
  const names = new Map(members.map((m) => [m.id, m.name]));
  const pendingReviews = reviewsR?.n ?? 0;
  const pendingQs = qsR?.n ?? 0;
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

// project and work are what the app can group lanes by besides the person (project key, kind of work).
type Seg = { key: string; title: string; start: string; end: string | null; kind: 'work' | 'wait' | 'decide'; label: string; live?: boolean; project?: string; work?: string };

/**
 * The work map: one lane per member over the last days. Solid segments are work, dashed are
 * work waiting on someone, short blocks on people's lanes are their decisions. Each segment also
 * carries its project and kind of work, so the app can regroup the same bars by those instead.
 */
export async function workMap(c: Ctx, days = 5) {
  await sweepLeases(c);
  const end = now(c);
  const start = new Date(end.getTime() - days * 86400_000);
  const [members, evsR, tasksR, projectsR, waitingR] = await Promise.all([
    listMembers(c),
    c.db.prepare(
      `SELECT e.task_id, t.key, t.title, e.type, e.note, e.actor_id, e.created_at, e.data FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.task_id IN (SELECT task_id FROM events WHERE space_id = ? AND created_at > ? UNION SELECT id FROM tasks WHERE space_id = ? AND status IN ('in_progress','blocked','review'))
       ORDER BY e.id`).bind(c.space, start.toISOString(), c.space).all<Ev>(),
    c.db.prepare(`SELECT * FROM tasks WHERE space_id = ? AND id IN (SELECT task_id FROM events WHERE space_id = ? AND created_at > ? UNION SELECT id FROM tasks WHERE space_id = ? AND status IN ('in_progress','blocked','review'))`)
      .bind(c.space, c.space, start.toISOString(), c.space).all<Task>(),
    c.db.prepare(`SELECT id, key, name, kind FROM projects WHERE space_id = ? ORDER BY kind DESC, focus DESC, rank, created_at`)
      .bind(c.space).all<{ id: string; key: string; name: string; kind: string }>(),
    // Tasks waiting on another task or a condition (KD-84), oldest wait first.
    c.db.prepare(`SELECT t.key, t.title, t.status, t.assignee_id, MIN(w.created_at) AS since, group_concat(coalesce(b.key, '"' || w.condition || '"'), ', ') AS what
      FROM waits w JOIN tasks t ON t.id = w.task_id LEFT JOIN tasks b ON b.id = w.on_task_id
      WHERE w.space_id = ? AND w.met_at IS NULL AND t.status NOT IN ('done','declined','parked') AND (b.id IS NULL OR b.status NOT IN ('done','declined'))
      GROUP BY t.id ORDER BY since LIMIT 50`).bind(c.space).all<{ key: string; title: string; status: string; assignee_id: string | null; since: string; what: string }>(),
  ]);
  const evs = evsR.results;
  const tasks = new Map(tasksR.results.map((t) => [t.id, t]));
  const lanes = new Map<string, Seg[]>(members.map((m) => [m.id, []]));
  const projects = projectsR.results;
  const projKey = new Map(projects.map((p) => [p.id, p.key]));
  const tagOf = new Map<string, { project?: string; work: string }>();
  const byKey = new Map(tasksR.results.map((t) => [t.key, t]));
  const tag = (key: string) => {
    if (!tagOf.has(key)) { const t = byKey.get(key); tagOf.set(key, { project: t ? projKey.get(t.project_id) : undefined, work: t ? taskKind(t) : 'other' }); }
    return tagOf.get(key)!;
  };
  const push = (mid: string | null | undefined, s: Seg) => { if (mid && lanes.has(mid)) lanes.get(mid)!.push(Object.assign(s, tag(s.key))); };
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
  }))).concat(waitingR.results.map((w) => ({
    key: w.key, title: w.title, who: (w.assignee_id && names.get(w.assignee_id)) || 'Anyone', label: `${w.key} waiting on ${w.what}`, since: w.since, on: w.what,
  }))).sort((a, b) => a.since.localeCompare(b.since));
  return {
    start: start.toISOString(), end: end.toISOString(),
    lanes: members.map((m: Member) => ({ id: m.id, name: m.name, kind: m.kind, platform: m.platform, segments: lanes.get(m.id)!.filter(clip) })),
    projects: projects.map((p) => ({ key: p.key, name: p.name, workspace: p.kind === 'workspace' })),
    waits,
  };
}

/** Rules with where they came from and how many tasks they have since been sent with. */
export async function rulesWithReach(c: Ctx, project?: string) {
  const sql = `SELECT r.id, r.text, r.active, r.created_at, p.key AS project, m.name AS created_by, t.key AS source_task,
      (SELECT COUNT(DISTINCT e.task_id) FROM events e JOIN tasks t2 ON t2.id = e.task_id
        WHERE (t2.project_id = r.project_id OR (p.kind = 'workspace' AND t2.space_id = p.space_id)) AND e.type = 'claimed' AND e.created_at > r.created_at) AS sent_with,
      p.kind = 'workspace' AS everywhere
    FROM rules r JOIN projects p ON p.id = r.project_id LEFT JOIN members m ON m.id = r.created_by
    LEFT JOIN reviews rv ON rv.id = r.review_id LEFT JOIN tasks t ON t.id = rv.task_id
    WHERE p.space_id = ? ${project ? 'AND p.key = ?' : ''} ORDER BY r.created_at DESC`;
  return (await c.db.prepare(sql).bind(c.space, ...(project ? [project.toUpperCase()] : [])).all()).results;
}

/** Counts per project in one query, for the Briefing; replaces one status call per project. */
export async function progress(c: Ctx) {
  await sweepLeases(c);
  const rows = (await c.db.prepare(
    `SELECT p.key, p.name, p.kind, p.focus, p.ends_at, t.status, COUNT(t.id) AS n FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
     WHERE p.space_id = ? GROUP BY p.id, t.status ORDER BY p.kind DESC, p.focus DESC, p.rank, p.created_at`).bind(c.space).all<any>()).results;
  const out = new Map<string, any>();
  for (const r of rows) {
    if (!out.has(r.key)) out.set(r.key, { key: r.key, name: r.name, workspace: r.kind === 'workspace', focus: !!r.focus, ends_at: r.ends_at, counts: {} });
    if (r.status) out.get(r.key).counts[r.status] = r.n;
  }
  return [...out.values()];
}

/**
 * A one-row check the web app polls instead of reloading every view: the newest event id and
 * member count. The app refetches only when this changes. Expired leases are swept here too.
 */
export async function changes(c: Ctx) {
  await sweepLeases(c);
  const r = await c.db.prepare(`SELECT (SELECT MAX(id) FROM events WHERE space_id = ?) AS e, (SELECT COUNT(*) FROM members WHERE removed_at IS NULL AND space_id = ?) AS m`).bind(c.space, c.space).first<{ e: number | null; m: number }>();
  return { version: `${r?.e ?? 0}.${r?.m ?? 0}` };
}
