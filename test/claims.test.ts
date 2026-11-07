// KD-36: several agents and people sharing tasks. One holder at a time, handoff notes, take-overs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

let env: any;
let human: string, bob: string, a1: string, a2: string, a1Id: string, a2Id: string;
let pending: Promise<unknown>[] = [];
let wakes: any[] = [];
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
const task = async (key: string, token = human) => (await call('GET', `/api/tasks/${key}`, token)).body;
const tool = async (token: string, name: string, args: unknown) => {
  const r = (await call('POST', `/api/tools/${name}`, token, args));
  return r;
};

beforeEach(async () => {
  wakes = [];
  vi.stubGlobal('fetch', async (_url: string, init: any) => { wakes.push(JSON.parse(init.body)); return new Response('ok'); });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  bob = (await call('POST', '/api/members', human, { name: 'Bob', kind: 'human' })).body.token;
  const x = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai', platform: 'claude-code' });
  const y = await call('POST', '/api/members', human, { name: 'Writer', kind: 'ai', platform: 'claude' });
  a1 = x.body.token; a1Id = x.body.member.id; a2 = y.body.token; a2Id = y.body.member.id;
  for (const id of [a1Id, a2Id]) await call('PUT', `/api/members/${id}/wake`, human, { url: 'https://hook.test/' + id });
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Launch post' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('one holder at a time', () => {
  it('the second claimer is told to skip, and next_task skips the claimed task', async () => {
    expect((await call('POST', '/api/tasks/MKT-1/claim', a1)).status).toBe(200);
    const second = await call('POST', '/api/tasks/MKT-1/claim', a2);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('Skip it and call next_task');
    expect((await call('GET', '/api/next', a2)).body).toBeNull();
  });

  it("another agent can comment on a claimed task but can't move, reassign or rewrite it", async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    expect((await call('PATCH', '/api/tasks/MKT-1', a2, { note: 'FYI the brand guide changed' })).status).toBe(200);
    const moved = await call('PATCH', '/api/tasks/MKT-1', a2, { status: 'ready' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toContain('held by Coder');
    expect((await call('PATCH', '/api/tasks/MKT-1', a2, { assignee: 'Writer' })).status).toBe(409);
    expect((await call('PATCH', '/api/tasks/MKT-1', a2, { title: 'Mine now' })).status).toBe(409);
    expect((await task('MKT-1')).assignee.name).toBe('Coder');
  });

  it('a stale holder is fenced out once the task has a new holder', async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    await call('POST', '/api/tasks/MKT-1/takeover', human, { note: 'I need this today' });
    expect((await call('POST', '/api/tasks/MKT-1/heartbeat', a1)).status).toBe(409);
    expect((await call('PATCH', '/api/tasks/MKT-1', a1, { status: 'done' })).status).toBe(409);
    expect((await call('POST', '/api/tasks/MKT-1/submit', a1, { summary: 'done', deliverables: [{ url: 'https://x.test/pr/1' }] })).status).toBe(403);
  });

  it('get_task shows who holds it and their lease', async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    const t = await task('MKT-1', a1);
    expect(t.claim).toMatchObject({ holder: { name: 'Coder', kind: 'ai' }, you_hold: true, stale: false });
    expect(t.claim.lease_expires_at).toBeTruthy();
    expect(t.claim.rule).toContain('30-minute lease');
  });
});

describe('handoffs', () => {
  it('release with a note puts it back in Ready, and the next claimer reads the note', async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    expect((await call('POST', '/api/tasks/MKT-1/release', a1, {})).status).toBe(400);
    const r = await tool(a1, 'release_task', { key: 'MKT-1', note: 'Draft is in docs/launch.md; needs the pricing paragraph.' });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ status: 'ready', assignee: null, claim: null });
    const c = await tool(a2, 'claim_task', { key: 'MKT-1' });
    expect(c.body.result.handoff).toMatchObject({ type: 'released', from: 'Coder', note: expect.stringContaining('pricing paragraph') });
  });

  it('release to a named member assigns it and wakes them', async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    wakes = [];
    const r = await call('POST', '/api/tasks/MKT-1/release', a1, { note: 'Writing is your thing', to: 'Writer' });
    expect(r.body).toMatchObject({ status: 'ready', assignee_id: a2Id });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ event: 'assigned', agent: 'Writer', note: 'Writing is your thing' });
    expect((await call('POST', '/api/tasks/MKT-1/claim', a1)).status).toBe(409);
    expect((await call('POST', '/api/tasks/MKT-1/claim', a2)).status).toBe(200);
  });

  it("an agent can't release someone else's task", async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    expect((await call('POST', '/api/tasks/MKT-1/release', a2, { note: 'x' })).status).toBe(403);
  });
});

describe('people take over', () => {
  it("a person takes an agent's task, and the agent is woken and told to stop", async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    wakes = [];
    const r = await call('POST', '/api/tasks/MKT-1/takeover', human, { note: 'Legal wants me to write this one' });
    expect(r.body).toMatchObject({ status: 'in_progress', lease_expires_at: null });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ event: 'taken_over', agent: 'Coder' });
    expect(wakes[0].next).toContain('Stop working on it');
    const t = await task('MKT-1');
    expect(t.claim).toMatchObject({ holder: { name: 'L', kind: 'human' }, you_hold: true });
    expect(t.handoff).toMatchObject({ type: 'taken_over', from: 'Coder', to: 'L', note: 'Legal wants me to write this one' });
  });

  it('a person can give the task to another agent, which is woken to claim it', async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    wakes = [];
    const r = await call('POST', '/api/tasks/MKT-1/takeover', human, { to: 'Writer' });
    expect(r.body).toMatchObject({ status: 'ready', assignee_id: a2Id });
    expect(wakes.map((w) => [w.event, w.agent])).toEqual([['taken_over', 'Coder'], ['assigned', 'Writer']]);
  });

  it("agents can't take over", async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    expect((await call('POST', '/api/tasks/MKT-1/takeover', a2, {})).status).toBe(403);
  });

  it('moving a held task by editing it also tells the agent', async () => {
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    wakes = [];
    await call('PATCH', '/api/tasks/MKT-1', human, { status: 'ready', note: 'Pausing this' });
    expect(wakes.map((w) => w.event)).toEqual(['taken_over']);
  });

  it("a person's claim has no lease and is flagged stale after a few quiet days, never released", async () => {
    await call('POST', '/api/tasks/MKT-1/claim', bob);
    const t = await task('MKT-1');
    expect(t.claim).toMatchObject({ holder: { name: 'Bob' }, stale: false, lease_expires_at: null });
    // Four days later: still Bob's, now flagged.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 86_400_000);
    try {
      const later = await task('MKT-1');
      expect(later.status).toBe('in_progress');
      expect(later.claim.stale).toBe(true);
      expect(later.claim.rule).toContain("hasn't updated it");
    } finally { vi.useRealTimers(); }
  });
});
