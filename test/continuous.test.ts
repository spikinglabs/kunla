import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app, { scheduled } from '../src/index';
import { makeD1 } from './d1-shim';

let env: any;
let human: string, ai: string, aiId: string;
let pending: Promise<unknown>[] = [];
let calls: { url: string; body: any }[] = [];

const exec = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} } as any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, exec);
  const text = await res.text();
  await Promise.all(pending); pending = [];
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const tool = async (token: string, name: string, args: unknown = {}) => (await call('POST', `/api/tools/${name}`, token, args)).body.result;
const setContinuous = (body: unknown, token = human) => call('PUT', `/api/members/${aiId}/continuous`, token, body);
const newTask = (title: string, extra: object = {}) => call('POST', '/api/tasks', human, { project: 'MKT', title, ...extra });

beforeEach(async () => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  const a = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai', platform: 'claude-code' });
  ai = a.body.token; aiId = a.body.member.id;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('continuous mode settings', () => {
  it('is set by the sponsor, not by the agent, and shows on the Team page', async () => {
    expect((await setContinuous({ on: true }, ai)).status).toBe(403);
    const r = await setContinuous({ on: true, max_tasks_per_day: 5, max_cost_per_day: '12.5', max_in_review: 2, max_tokens_per_day: -3 });
    expect(r.status).toBe(200);
    expect(r.body.continuous).toMatchObject({ on: true, max_tasks_per_day: 5, max_cost_per_day: 12.5, max_in_review: 2, max_tokens_per_day: null });
    const row = (await call('GET', '/api/members', human)).body.find((m: any) => m.id === aiId);
    expect(row.continuous.settings.on).toBe(true);
    expect(row.continuous.usage).toEqual({ tasks_today: 0, cost_today: 0, tokens_today: 0, in_review: 0 });
    expect((await setContinuous({ on: true, until: '2001-01-01' })).status).toBe(400);
    const off = await setContinuous({ on: false });
    expect(off.body.continuous.on).toBe(false);
    expect(off.body.continuous.max_tasks_per_day).toBe(5); // limits are kept for next time
  });

  it('leaves next_task as it was when off', async () => {
    expect(await tool(ai, 'next_task')).toMatchObject({ message: expect.stringContaining('Nothing waiting') });
  });
});

describe('working through tasks', () => {
  beforeEach(async () => { await setContinuous({ on: true }); });

  it('tells the agent to keep going, moves past a blocked task, and stops only when everything waits on people', async () => {
    await newTask('One'); await newTask('Two');
    let n = await tool(ai, 'next_task');
    expect(n.task.key).toBe('MKT-1');
    expect(n.continuous.go).toBe(true);
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    // Blocked on the first one: not a reason to stop.
    await tool(ai, 'update_task', { key: 'MKT-1', blocked_question: 'Which colour?' });
    n = await tool(ai, 'next_task');
    expect(n.task.key).toBe('MKT-2');
    await tool(ai, 'claim_task', { key: 'MKT-2' });
    const sub = await tool(ai, 'submit_for_review', { key: 'MKT-2', summary: 'Done', deliverables: [{ url: 'https://x.test/pr/2' }], cost_usd: 0.4, tokens: 1200 });
    expect(sub.continuous.next).toContain('next_task');
    n = await tool(ai, 'next_task');
    expect(n.task).toBeNull();
    expect(n.continuous).toMatchObject({ go: false, stop_reason: 'waiting_on_people' });
    expect(n.continuous.usage).toMatchObject({ tasks_today: 2, cost_today: 0.4, tokens_today: 1200, in_review: 1 });
    const row = (await call('GET', '/api/members', human)).body.find((m: any) => m.id === aiId);
    expect(row.continuous.run).toMatchObject({ state: 'stopped', reason: 'waiting_on_people' });
  });

  it('says nothing_ready when the queue is empty', async () => {
    const n = await tool(ai, 'next_task');
    expect(n.continuous).toMatchObject({ go: false, stop_reason: 'nothing_ready' });
  });

  it('stops starting new work at the daily task budget, but finishes what it holds', async () => {
    await setContinuous({ on: true, max_tasks_per_day: 1 });
    await newTask('One'); await newTask('Two');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    let n = await tool(ai, 'next_task');
    expect(n.reason).toBe('continue');
    expect(n.continuous.next).toContain('then stop');
    const refused = await call('POST', '/api/tasks/MKT-2/claim', ai);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('1 of 1 tasks');
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done', deliverables: [{ url: 'https://x.test/pr/1' }] });
    n = await tool(ai, 'next_task');
    expect(n.continuous).toMatchObject({ go: false, stop_reason: 'tasks_budget' });
  });

  it('stops on the cost budget and on too many tasks waiting for review', async () => {
    await setContinuous({ on: true, max_cost_per_day: 1 });
    await newTask('One'); await newTask('Two'); await newTask('Three');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'log_work', { task: 'MKT-1', summary: 'Halfway', cost_usd: 1.2 });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done', deliverables: [{ url: 'https://x.test/pr/1' }] });
    expect((await tool(ai, 'next_task')).continuous.stop_reason).toBe('cost_budget');
    await setContinuous({ on: true, max_cost_per_day: null, max_in_review: 1 });
    expect((await tool(ai, 'next_task')).continuous.stop_reason).toBe('review_limit');
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect((await tool(ai, 'next_task')).task.key).toBe('MKT-2');
  });

  it('ends at the end time', async () => {
    await newTask('One');
    await setContinuous({ on: true, until: new Date(Date.now() + 60_000).toISOString() });
    await env.DB.prepare(`UPDATE members SET continuous = json_set(continuous, '$.until', ?) WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), aiId).run();
    expect((await tool(ai, 'next_task')).continuous.stop_reason).toBe('ended');
  });
});

describe('waking an idle continuous agent', () => {
  beforeEach(async () => {
    await call('PUT', `/api/members/${aiId}/wake`, human, { url: 'https://agent.test/wake' });
    await setContinuous({ on: true, max_tasks_per_day: 1 });
    calls = [];
  });

  it('wakes it once when new work is ready in its lane, not for other lanes', async () => {
    await call('POST', '/api/projects', human, { key: 'OPS', name: 'Ops' });
    await call('PATCH', `/api/members/${aiId}`, human, { scope: ['MKT'] });
    await tool(ai, 'next_task'); // stops: nothing ready
    await call('POST', '/api/tasks', human, { project: 'OPS', title: 'Not my lane' });
    expect(calls).toHaveLength(0);
    await newTask('Mine');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ event: 'work_ready', task: { key: 'MKT-1' } });
    expect(calls[0].body.next).toContain('next_task');
    await newTask('Also mine');
    expect(calls).toHaveLength(1); // already woken; it asks for work itself
  });

  it('does not wake an agent that is stopped on its budget, until a new day', async () => {
    await newTask('One');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done', deliverables: [{ url: 'https://x.test/pr/1' }] });
    expect((await tool(ai, 'next_task')).continuous.stop_reason).toBe('tasks_budget');
    calls = [];
    await newTask('Two');
    expect(calls).toHaveLength(0);
    // A new day: yesterday's claims no longer count.
    await env.DB.prepare(`UPDATE events SET created_at = '2000-01-01T00:00:00.000Z'`).run();
    const jobs: Promise<unknown>[] = [];
    await scheduled({}, env, { waitUntil: (p) => jobs.push(p) });
    await Promise.all(jobs);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ event: 'work_ready', note: expect.stringContaining('new day'), kunla_url: 'https://kunla.test' });
  });
});
