// Continuous mode: an agent keeps taking the next ready task and working through them one by one,
// stopping only when nothing it may work on is left (everything waits on a person) or when it reaches
// a limit its sponsor set. Kunla does not run agents; it tells a continuous agent to carry on or why to
// stop, refuses new claims past a limit, and wakes an idle continuous agent when new work turns up.
import type { Ctx, Member, Task } from './core';
import { parseCallback } from './wake';

export interface ContinuousSettings {
  on: boolean;
  max_tasks_per_day: number | null;   // new tasks it may start per UTC day
  max_cost_per_day: number | null;    // USD per UTC day, from cost_usd the agent reports
  max_tokens_per_day: number | null;  // tokens per UTC day, from tokens the agent reports
  max_in_review: number | null;       // finished tasks waiting on a person before it stops starting more
  until: string | null;               // continuous mode ends by itself at this time
  base_url?: string;                  // Kunla's address when it was turned on, for wake-ups sent by the daily cron
}

export type StopReason = 'nothing_ready' | 'waiting_on_people' | 'tasks_budget' | 'cost_budget' | 'tokens_budget' | 'review_limit' | 'ended';
/** Reasons that clear by themselves when new work turns up, so Kunla wakes the agent then. */
export const WAKEABLE: StopReason[] = ['nothing_ready', 'waiting_on_people', 'review_limit'];
/** Reasons that clear when a new day starts. */
export const DAILY: StopReason[] = ['tasks_budget', 'cost_budget', 'tokens_budget'];

export interface RunState { state: 'running' | 'stopped' | 'woken'; reason: StopReason | null; message: string | null; at: string }

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseSettings(raw: string | null | undefined): ContinuousSettings | null {
  if (!raw) return null;
  try { const s = JSON.parse(raw); return s && typeof s === 'object' ? normalize(s) : null; } catch { return null; }
}

export function normalize(input: any): ContinuousSettings {
  const until = input?.until ? new Date(input.until) : null;
  return {
    on: !!input?.on,
    max_tasks_per_day: num(input?.max_tasks_per_day),
    max_cost_per_day: num(input?.max_cost_per_day),
    max_tokens_per_day: num(input?.max_tokens_per_day),
    max_in_review: num(input?.max_in_review),
    until: until && !isNaN(until.getTime()) ? until.toISOString() : null,
    ...(typeof input?.base_url === 'string' && /^https?:\/\//.test(input.base_url) ? { base_url: input.base_url } : {}),
  };
}

export function parseRunState(raw: string | null | undefined): RunState | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const now = (c: Ctx) => (c.now ? c.now() : new Date());
export const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

export interface Usage { tasks_today: number; cost_today: number; tokens_today: number; in_review: number }

/** What the agent used today (UTC): new tasks started, reported cost and tokens, and work waiting on review. */
export async function usage(c: Ctx, memberId: string): Promise<Usage> {
  const since = dayStart(now(c));
  const started = await c.db.prepare(
    `SELECT COUNT(DISTINCT task_id) AS n FROM events WHERE actor_id = ? AND space_id = ? AND type = 'claimed' AND created_at >= ?`)
    .bind(memberId, c.space, since).first<{ n: number }>();
  const spent = await c.db.prepare(
    `SELECT SUM(CAST(json_extract(data, '$.cost_usd') AS REAL)) AS cost, SUM(CAST(json_extract(data, '$.tokens') AS INTEGER)) AS tokens
     FROM events WHERE actor_id = ? AND space_id = ? AND created_at >= ? AND type IN ('work_logged','submitted','note','status','blocked')`)
    .bind(memberId, c.space, since).first<{ cost: number | null; tokens: number | null }>();
  const review = await c.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND space_id = ? AND status = 'review'`)
    .bind(memberId, c.space).first<{ n: number }>();
  return {
    tasks_today: started?.n ?? 0,
    cost_today: Math.round((spent?.cost ?? 0) * 100) / 100,
    tokens_today: spent?.tokens ?? 0,
    in_review: review?.n ?? 0,
  };
}

const MESSAGES: Record<StopReason, (s: ContinuousSettings, u: Usage) => string> = {
  nothing_ready: () => 'Nothing is ready in your lane. Stop here; Kunla wakes you when new work is ready.',
  waiting_on_people: () => 'Everything you could work on is waiting on a person (a question or sub-tasks). Stop here; Kunla wakes you when someone answers or new work is ready.',
  tasks_budget: (s, u) => `You started ${u.tasks_today} of ${s.max_tasks_per_day} tasks allowed today. Finish what you hold, then stop until tomorrow (UTC).`,
  cost_budget: (s, u) => `You reported $${u.cost_today} of the $${s.max_cost_per_day} allowed today. Finish what you hold, then stop until tomorrow (UTC).`,
  tokens_budget: (s, u) => `You reported ${u.tokens_today} of ${s.max_tokens_per_day} tokens allowed today. Finish what you hold, then stop until tomorrow (UTC).`,
  review_limit: (s, u) => `${u.in_review} of your tasks wait on review (limit ${s.max_in_review}). Stop starting new work; Kunla wakes you when a person reviews one.`,
  ended: (s) => `Continuous mode ended at ${s.until}. Stop after the task you hold.`,
};

export const stopMessage = (r: StopReason, s: ContinuousSettings, u: Usage) => MESSAGES[r](s, u);

/** The stop message for this agent: one that can't be woken is told so, instead of being promised a wake-up. */
export function stopMessageFor(r: StopReason, s: ContinuousSettings, u: Usage, who: { platform?: string | null; hasWake?: boolean }) {
  const m = stopMessage(r, s, u);
  if (who.hasWake || !WAKEABLE.includes(r)) return m;
  return m.replace(/ ?Kunla wakes you[^.]*\./, '').replace(/; $/, '.').replace(/;$/, '.') + ' ' + (who.platform === 'claude-ai'
    ? 'Tell your sponsor; they can ask you again once there is new work.'
    : 'Kunla cannot start you again (no wake-up URL), so tell the person running you; they can start a new run later.');
}

/** The limit that stops the agent from starting new work, if any. */
export function limitHit(s: ContinuousSettings, u: Usage, at: Date): StopReason | null {
  if (s.until && new Date(s.until).getTime() <= at.getTime()) return 'ended';
  if (s.max_tasks_per_day !== null && u.tasks_today >= s.max_tasks_per_day) return 'tasks_budget';
  if (s.max_cost_per_day !== null && u.cost_today >= s.max_cost_per_day) return 'cost_budget';
  if (s.max_tokens_per_day !== null && u.tokens_today >= s.max_tokens_per_day) return 'tokens_budget';
  if (s.max_in_review !== null && u.in_review >= s.max_in_review) return 'review_limit';
  return null;
}

/** Continuous status for an agent, or null when continuous mode is off (or it is a person). */
export async function status(c: Ctx, m: Pick<Member, 'id' | 'kind'> & { continuous?: string | null }) {
  const s = m.kind === 'ai' ? parseSettings(m.continuous) : null;
  if (!s?.on) return null;
  const u = await usage(c, m.id);
  const stop = limitHit(s, u, now(c));
  return { settings: s, usage: u, stop, message: stop ? stopMessage(stop, s, u) : null };
}

export async function setRunState(c: Ctx, memberId: string, state: RunState['state'], reason: StopReason | null, message: string | null) {
  const rs: RunState = { state, reason, message, at: now(c).toISOString() };
  await c.db.prepare('UPDATE members SET run_state = ? WHERE id = ?').bind(JSON.stringify(rs), memberId).run();
  return rs;
}

/** The instruction a continuous agent gets with each task: keep going after this one. */
export const KEEP_GOING = 'Continuous mode is on: when this task is submitted (or you are blocked on it with a question), call next_task again and take the next one. Stop only when next_task says stop.';

type Candidate = Pick<Member, 'id' | 'name' | 'kind' | 'scope'> & { callback: string | null; continuous: string | null; run_state: string | null; space_id: string };

/**
 * New work turned up (a task became Ready, a review freed a slot, a new day started): wake one idle
 * continuous agent whose lane covers it and whose limits allow it. One at a time, so agents don't race
 * for the same task; it is marked woken so it isn't called again until it asks for work.
 */
export async function wakeIdle(c: Ctx, task: Pick<Task, 'id' | 'key' | 'title' | 'status' | 'project_id' | 'assignee_id'> | null, opts: { reasons?: StopReason[]; note?: string } = {}) {
  if (!c.notify) return null;
  if (task && (task.status !== 'ready' || task.assignee_id)) return null;
  const reasons = opts.reasons ?? WAKEABLE;
  const rows = (await c.db.prepare(
    `SELECT id, name, kind, scope, callback, continuous, run_state, space_id FROM members
     WHERE space_id = ? AND kind = 'ai' AND removed_at IS NULL AND continuous IS NOT NULL AND callback IS NOT NULL ORDER BY created_at`)
    .bind(c.space).all<Candidate>()).results;
  const proj = task ? await c.db.prepare('SELECT key, kind FROM projects WHERE id = ?').bind(task.project_id).first<{ key: string; kind: string }>() : null;
  for (const m of rows) {
    if (m.id === c.me?.id) continue;
    const rs = parseRunState(m.run_state);
    if (!rs || rs.state !== 'stopped' || !rs.reason || !reasons.includes(rs.reason)) continue;
    let lane: string[] = [];
    try { lane = JSON.parse(m.scope || '[]'); } catch { /* no lane: all projects */ }
    if (proj && proj.kind !== 'workspace' && lane.length && !lane.includes(proj.key)) continue;
    const st = await status(c, m);
    if (!st || st.stop) continue;
    const callback = parseCallback(m.callback);
    if (!callback) continue;
    await setRunState(c, m.id, 'woken', null, null);
    c.notify({ member: { id: m.id, name: m.name }, callback, event: 'work_ready', note: opts.note ?? null, by: c.me?.name ?? 'Kunla', baseUrl: c.baseUrl || st.settings.base_url || '',
      task: task ? { id: task.id, key: task.key, title: task.title, status: task.status } : null });
    return m.id;
  }
  return null;
}

/** Start of a new day (the Worker's cron): wake agents that stopped on a daily budget, in every workspace. */
export async function newDay(c: Omit<Ctx, 'space' | 'me'>) {
  const spaces = (await c.db.prepare(`SELECT DISTINCT space_id FROM members WHERE kind = 'ai' AND continuous IS NOT NULL AND callback IS NOT NULL AND removed_at IS NULL`)
    .all<{ space_id: string }>()).results;
  let woken = 0;
  for (const { space_id } of spaces) {
    const ctx = { ...c, space: space_id, me: null as unknown as Member } as Ctx;
    // Wake every agent whose budget reset, not just one: each has its own day of work.
    while (await wakeIdle(ctx, null, { reasons: DAILY, note: 'A new day started, so your daily budget is free again.' })) woken++;
  }
  return woken;
}

// ---------- telling the agent ----------
// An agent should never have to discover continuous mode on its own. whoami, the MCP instructions it
// reads on connect, and a line under every tool reply say that it is on, what is left of today's budget
// and what to do next, so a sponsor only has to switch it on.

/** Starting limits when a person turns continuous mode on from an offer: a day's work, small enough to review. */
export const DEFAULTS = { max_tasks_per_day: 10, max_in_review: 5 } as const;

type Status = NonNullable<Awaited<ReturnType<typeof status>>>;
interface Who { platform?: string | null; hasWake?: boolean; sponsor?: string | null }

/** How the agent gets started again after it stops, by platform. Plain words, read by the agent. */
export function wakeStory(platform: string | null | undefined, hasWake: boolean): string {
  if (hasWake) return 'Kunla calls your wake-up URL when new work is ready or a person decides something, so a new run starts by itself.';
  if (platform === 'claude-ai') return 'A chat only runs when your sponsor writes to it, so Kunla cannot start you. When they ask you to work, keep going through tasks in this conversation until next_task says stop.';
  return 'You have no wake-up URL, so Kunla cannot start you again after you stop. Keep going for as long as this session runs; your sponsor can add a wake-up URL in Kunla (Team, Manage) so new runs start by themselves.';
}

const left = (max: number | null, used: number) => (max === null ? null : Math.max(0, Math.round((max - used) * 100) / 100));

/** What the agent learns about continuous mode from whoami. */
export function forAgent(st: Status | null, who: Who) {
  if (!st) return { on: false, note: `Continuous mode is off: take tasks when you are asked. ${who.sponsor ?? 'Your sponsor'} can turn it on in Kunla; every reply will then tell you.` };
  const { settings: s, usage: u } = st;
  return {
    on: true,
    go: !st.stop,
    what_to_do: st.stop ? `Finish what you hold, then stop: ${st.message}`
      : 'Work through tasks one by one: next_task, claim_task, do it, submit_for_review (or update_task with blocked_question), then next_task again. A question on one task is not a reason to stop. Stop only when next_task returns continuous.go false.',
    today: { tasks_started: u.tasks_today, cost_usd: u.cost_today, tokens: u.tokens_today, waiting_for_review: u.in_review },
    left_today: {
      tasks: left(s.max_tasks_per_day, u.tasks_today), cost_usd: left(s.max_cost_per_day, u.cost_today),
      tokens: left(s.max_tokens_per_day, u.tokens_today), review_slots: left(s.max_in_review, u.in_review),
    },
    ends_at: s.until,
    report_spend: 'Pass cost_usd and/or tokens with log_work or submit_for_review when you know them; they count toward the limits.',
    wake_up: wakeStory(who.platform, !!who.hasWake),
  };
}

/** One line under every tool reply, so a continuous agent never loses track of the mode it is in. */
export function replyLine(st: Status): string {
  const { settings: s, usage: u } = st;
  const parts = [`${u.tasks_today}${s.max_tasks_per_day !== null ? ` of ${s.max_tasks_per_day}` : ''} tasks started today`];
  if (s.max_in_review !== null) parts.push(`${u.in_review} of ${s.max_in_review} waiting for review`);
  if (s.max_cost_per_day !== null) parts.push(`$${u.cost_today} of $${s.max_cost_per_day}`);
  if (s.max_tokens_per_day !== null) parts.push(`${u.tokens_today} of ${s.max_tokens_per_day} tokens`);
  const next = st.stop ? `Finish what you hold, then stop: ${st.message}` : 'When this task is submitted or blocked, call next_task and take the next one.';
  return `Continuous mode is on (${parts.join(', ')}). ${next}`;
}

/** Added to the MCP instructions an agent reads when it connects, when its sponsor turned continuous mode on. */
export function instructionsFor(st: Status, who: Who): string {
  return `\n\nYou are in continuous mode: ${who.sponsor ?? 'your sponsor'} turned it on for you. Start with next_task and keep taking the next task (rule 9) until it says stop. ${replyLine(st)} ${wakeStory(who.platform, !!who.hasWake)}`;
}
