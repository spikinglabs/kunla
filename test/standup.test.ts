// KD-48: the Briefing is the standup. Since your last visit (KD-49), asks (KD-50), the agent's
// "since your last session" block (KD-51) and the weekly digest (KD-52).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app, { scheduled } from '../src/index';
import { makeD1 } from './d1-shim';

let env: any;
let human: string, bob: string, ai: string, aiId: string, bobId: string, wsKey: string;
let pending: Promise<unknown>[] = [];
let posts: { url: string; body: any }[] = [];
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
const newTask = (title: string, extra: object = {}) => call('POST', '/api/tasks', human, { project: 'MKT', title, ...extra });
let clock = Date.now();
const later = (ms: number) => { clock += ms; vi.setSystemTime(clock); };
const H = 3600_000, D = 24 * H;

beforeEach(async () => {
  posts = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.UTC(2026, 10, 9, 9, 0, 0); // a Monday
  vi.setSystemTime(clock);
  vi.stubGlobal('fetch', async (url: string, init: any) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); });
  env = { DB: makeD1(), LEASE_MINUTES: '30', PUBLIC_URL: 'https://kunla.test' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  const b = await call('POST', '/api/members', human, { name: 'Bob', kind: 'human' });
  bob = b.body.token; bobId = b.body.member.id;
  const a = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai', platform: 'claude-code' });
  ai = a.body.token; aiId = a.body.member.id;
  wsKey = (await call('GET', '/api/me', human)).body.workspace.key;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('since your last visit (KD-49)', () => {
  it('starts with the last day, holds still while you stay, and picks up where you left off after a break', async () => {
    const first = (await call('GET', '/api/briefing', human)).body;
    expect(first.window).toBe('first_visit');
    expect(Date.parse(first.since)).toBe(clock - D);
    const leftAt = clock;
    later(20 * 60_000); // a refresh twenty minutes on: same window
    expect((await call('GET', '/api/briefing', human)).body.since).toBe(first.since);
    later(3 * D); // back three days later: since the last visit
    const back = (await call('GET', '/api/briefing', human)).body;
    expect(back.window).toBe('last_visit');
    expect(Date.parse(back.since)).toBe(leftAt + 20 * 60_000);
  });

  it('shows work finished while you were away, and an explicit hours window still works', async () => {
    await call('GET', '/api/briefing', human);
    later(2 * H);
    await newTask('Write launch post');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done', deliverables: [{ url: 'https://docs.test/post' }] });
    await call('POST', '/api/tasks/MKT-1/review', bob, { verdict: 'approved' });
    later(2 * H);
    const b = (await call('GET', '/api/briefing', human)).body;
    expect(b.finished.map((f: any) => f.key)).toEqual(['MKT-1']);
    const fixed = (await call('GET', '/api/briefing?hours=1', human)).body;
    expect(fixed.window).toBe('hours');
    expect(fixed.finished).toEqual([]);
  });
});

describe('asks (KD-50)', () => {
  it("flags a person's quiet claim, a review and a question waiting on someone else", async () => {
    await newTask('Quarterly numbers');
    await call('POST', '/api/tasks/MKT-1/claim', bob);
    await newTask('Pricing page copy', { reviewer: 'Bob' });
    await tool(ai, 'claim_task', { key: 'MKT-2' });
    await tool(ai, 'submit_for_review', { key: 'MKT-2', summary: 'Draft', deliverables: [{ url: 'https://docs.test/p' }] });
    await newTask('Partner list');
    await tool(ai, 'claim_task', { key: 'MKT-3' });
    await tool(ai, 'update_task', { key: 'MKT-3', blocked_question: 'Which region first?', blocked_on: 'Bob' });
    expect((await call('GET', '/api/briefing', human)).body.asks).toEqual([]); // nothing has waited long yet
    later(3 * D);
    const asks = (await call('GET', '/api/briefing', human)).body.asks;
    expect(asks.map((a: any) => [a.kind, a.task?.key, a.action])).toEqual([
      ['question_waiting', 'MKT-3', 'open'],
      ['review_waiting', 'MKT-2', 'open'],
      ['quiet_claim', 'MKT-1', 'take_over'],
    ]);
    expect(asks[2].line).toContain('Bob has held MKT-1');
    // Bob sees his own quiet claim as a nudge, and the review and question waiting on him are in his deck instead.
    const bobs = (await call('GET', '/api/briefing', bob)).body.asks;
    expect(bobs.map((a: any) => a.kind)).toEqual(['quiet_claim']);
    expect(bobs[0].line).toContain("You haven't touched MKT-1");
  });

  it('flags two members working on the same thing', async () => {
    await newTask('Write the DACH launch blog post');
    await newTask('DACH launch blog post draft');
    await call('POST', '/api/tasks/MKT-1/claim', bob);
    await tool(ai, 'claim_task', { key: 'MKT-2' });
    const asks = (await call('GET', '/api/briefing', human)).body.asks;
    expect(asks).toEqual([expect.objectContaining({ kind: 'overlap', action: 'compare', task: expect.objectContaining({ key: 'MKT-1' }), other: expect.objectContaining({ key: 'MKT-2' }) })]);
  });

  it("shows an agent stopped by its budget to its sponsor, not to everyone", async () => {
    await call('PUT', `/api/members/${aiId}/continuous`, human, { on: true, max_tasks_per_day: 1 });
    await newTask('One'); await newTask('Two');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'ok', deliverables: [{ url: 'https://docs.test/1' }] });
    expect((await tool(ai, 'next_task')).continuous.stop_reason).toBe('tasks_budget');
    const mine = (await call('GET', '/api/briefing', human)).body.asks;
    expect(mine).toEqual([expect.objectContaining({ kind: 'budget_stop', action: 'limits', member: expect.objectContaining({ name: 'Coder' }) })]);
    expect((await call('GET', '/api/briefing', bob)).body.asks).toEqual([]);
  });
});

describe("the agent's since your last session (KD-51)", () => {
  it('tells the agent once what people did with its work while it was away', async () => {
    const first = (await tool(ai, 'whoami')).since_last_session;
    expect(first).toMatchObject({ first_session: true, count: 0 });
    await newTask('Launch post'); await newTask('FAQ'); await newTask('Ad copy');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Draft', deliverables: [{ url: 'https://docs.test/1' }] });
    await tool(ai, 'claim_task', { key: 'MKT-2' });
    await tool(ai, 'update_task', { key: 'MKT-2', blocked_question: 'Formal or casual?' });
    await tool(ai, 'whoami'); // caught up
    later(10 * 60_000);
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'changes_requested', comment: 'Shorter intro' });
    await call('POST', '/api/tasks/MKT-2/answer', human, { answer: 'Casual' });
    await call('POST', '/api/tasks/assign', human, { keys: ['MKT-3'], to: 'Coder' });
    await call('PATCH', '/api/projects/MKT', human, { focus: true });
    later(60_000);
    const s = (await tool(ai, 'next_task')).since_last_session;
    expect(s.first_session).toBe(false);
    expect(s.items.map((i: any) => i.what)).toEqual(['focus_on', 'assigned', 'answered', 'changes_requested']);
    expect(s.items.find((i: any) => i.what === 'answered').line).toBe('L answered your question on MKT-2: "Casual"');
    expect(s.items.find((i: any) => i.what === 'changes_requested').line).toContain('sent MKT-1 back: "Shorter intro"');
    // Said once: the next call has nothing new.
    expect((await tool(ai, 'whoami')).since_last_session).toMatchObject({ count: 0, items: [] });
  });

  it("leaves out its own changes and other members' work, and people don't get the block", async () => {
    await tool(ai, 'whoami');
    later(60_000);
    await newTask('Not mine');
    await call('POST', '/api/tasks/MKT-1/claim', bob);
    await call('POST', '/api/tasks/MKT-1/submit', bob, { summary: 'done', deliverables: [{ url: 'https://docs.test/x' }] });
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect((await tool(ai, 'whoami')).since_last_session.items).toEqual([]);
    expect((await call('GET', '/api/me', human)).body.since_last_session).toBeUndefined();
  });

  it('still says what changed when next_task has nothing to give', async () => {
    await newTask('Proposal by agent', {});
    await tool(ai, 'whoami');
    later(60_000);
    const p = await tool(ai, 'create_task', { project: 'MKT', title: 'Refresh the onboarding emails' });
    await call('POST', `/api/tasks/${p.key}/triage`, human, { accept: false, note: 'Not this quarter' });
    await call('POST', '/api/tasks/MKT-1/park', human, {});
    const n = await tool(ai, 'next_task');
    expect(n.task).toBeNull();
    expect(n.message).toContain('Nothing waiting');
    expect(n.since_last_session.items.map((i: any) => i.what)).toEqual(['declined']);
  });
});

describe('weekly digest (KD-52)', () => {
  it('is off by default, keeps the webhook address out of the app, and sends on its day', async () => {
    expect((await call('GET', `/api/projects/${wsKey}`, human)).body.digest).toMatchObject({ on: false, has_url: false });
    expect((await call('PATCH', `/api/projects/${wsKey}`, human, { digest: { on: true, url: 'http://insecure.test' } })).status).toBe(400);
    expect((await call('PATCH', '/api/projects/MKT', human, { digest: { on: true } })).status).toBe(400);
    const saved = (await call('PATCH', `/api/projects/${wsKey}`, human, { digest: { on: true, day: 1, url: 'https://hooks.slack.test/T1/abc', format: 'slack' } })).body;
    expect(saved.digest).toEqual({ on: true, day: 1, format: 'slack', has_url: true, url_host: 'hooks.slack.test' });
    expect(JSON.stringify((await call('GET', `/api/projects/${wsKey}`, human)).body)).not.toContain('T1/abc');
    // Saving other settings without a url keeps the saved address.
    await call('PATCH', `/api/projects/${wsKey}`, human, { digest: { on: true, day: 1, format: 'slack' } });
    expect((await call('GET', `/api/projects/${wsKey}`, human)).body.digest.has_url).toBe(true);

    await newTask('Launch post');
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done', deliverables: [{ url: 'https://docs.test/post' }] });
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });

    const preview = (await call('GET', '/api/digest', bob)).body;
    expect(preview.finished_count).toBe(1);
    expect(preview.text).toContain('MKT-1 Launch post (Coder)');
    expect(preview.text).toContain('Coder (AI): worked on 1 task');

    // Not Monday: nothing sent. Monday: one post to the webhook.
    vi.setSystemTime(Date.UTC(2026, 10, 10, 0, 2)); // Tuesday
    await scheduled({}, env, exec); await Promise.all(pending); pending = [];
    expect(posts.filter((p) => p.url.includes('hooks.slack.test'))).toEqual([]);
    vi.setSystemTime(Date.UTC(2026, 10, 16, 0, 2)); // Monday
    await scheduled({}, env, exec); await Promise.all(pending); pending = [];
    const sent = posts.filter((p) => p.url.includes('hooks.slack.test'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain('Kunla weekly digest');
  });

  it('only an admin sends it now, and only with an address', async () => {
    expect((await call('POST', '/api/digest/send', human)).status).toBe(400);
    await call('PATCH', `/api/projects/${wsKey}`, human, { digest: { on: false, url: 'https://discord.test/hook', format: 'discord' } });
    expect((await call('POST', '/api/digest/send', bob)).status).toBe(403);
    const r = (await call('POST', '/api/digest/send', human)).body;
    expect(r.ok).toBe(true);
    expect(posts.at(-1)).toMatchObject({ url: 'https://discord.test/hook', body: { content: expect.stringContaining('weekly digest') } });
  });
});
