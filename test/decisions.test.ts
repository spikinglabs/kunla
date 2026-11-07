import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

let env: any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = (await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body;
  const text = r.result.content[0].text;
  return { isError: r.result.isError, data: r.result.isError ? text : JSON.parse(text) };
};
const CHAT = 'https://claude.ai/code/project/chan_x?thread=cmsg_y';

let human: string, ai: string, bob: string, bobAi: string;
const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai' })).body.token;
  bob = (await call('POST', '/api/members', human, { name: 'Bob', kind: 'human' })).body.token;
  bobAi = (await call('POST', '/api/members', bob, { name: "Bob's Claude", kind: 'ai' })).body.token;
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' }); // MKT-1
  await call('POST', '/api/tasks/MKT-1/claim', ai);
  await call('POST', '/api/tasks/MKT-1/submit', ai, { summary: 'Done', deliverables: [{ url: 'https://docs.example/pricing' }] });
});

describe('record_decision', () => {
  it("records the sponsor's chat approval as their review, with the chat and their words", async () => {
    const r = await tool(ai, 'record_decision', { key: 'MKT-1', verdict: 'approved', source_url: CHAT, quote: 'Merge' });
    expect(r.isError).toBeFalsy();
    const t = await task('MKT-1');
    expect(t.status).toBe('done');
    expect(t.reviews[0]).toMatchObject({ verdict: 'approved', reviewer: 'L', via: { agent: "L's Claude", source_url: CHAT, quote: 'Merge' } });
    expect(t.history[0]).toMatchObject({ type: 'approved', actor: 'L', actor_kind: 'human', data: { via: { quote: 'Merge' }, from: 'review', to: 'done' } });
    expect(t.sessions.map((s: any) => s.ref)).toContain(CHAT);
  });

  it('sends work back and answers questions the same way', async () => {
    await tool(ai, 'record_decision', { key: 'MKT-1', verdict: 'changes_requested', source_url: CHAT, quote: 'Not yet, add the yearly price', what_was_wrong: 'No yearly price' });
    let t = await task('MKT-1');
    expect(t.status).toBe('in_progress');
    expect(t.review_rounds).toBe(1);
    await call('PATCH', '/api/tasks/MKT-1', ai, { blocked_question: 'Monthly or yearly first?' });
    await tool(ai, 'record_decision', { key: 'MKT-1', verdict: 'answer', source_url: CHAT, quote: 'Yearly first', answer: 'Yearly first' });
    t = await task('MKT-1');
    expect(t.status).toBe('in_progress');
    expect(t.history[0]).toMatchObject({ type: 'answered', actor: 'L', note: 'Yearly first' });
  });

  it('marks open work done when the sponsor says so, which an agent alone cannot', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Connect the webhook' }); // MKT-2
    const self = await call('PATCH', '/api/tasks/MKT-2', ai, { status: 'done' });
    expect(self.status).toBe(403);
    expect(self.body.error).toContain('needs a person to approve');
    await tool(ai, 'record_decision', { key: 'MKT-2', verdict: 'approved', source_url: CHAT, quote: "Webhook added, it's done" });
    const t = await task('MKT-2');
    expect(t.status).toBe('done');
    expect(t.history[0]).toMatchObject({ type: 'status', actor: 'L', data: { to: 'done', via: { agent: "L's Claude" } } });
  });

  it('still lets agents finish work in projects that do not need a review', async () => {
    await call('PATCH', '/api/projects/MKT', human, { require_human_review: false });
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Typo fix' }); // MKT-2
    expect((await call('PATCH', '/api/tasks/MKT-2', ai, { status: 'done' })).status).toBe(200);
  });

  it('only speaks for its own sponsor, needs a chat link, and is for agents only', async () => {
    // Bob's agent records Bob's decision, never L's: the review is Bob's.
    await tool(bobAi, 'record_decision', { key: 'MKT-1', verdict: 'approved', source_url: CHAT, quote: 'ok' });
    expect((await task('MKT-1')).reviews[0].reviewer).toBe('Bob');
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Another' }); // MKT-2
    expect((await call('POST', '/api/tasks/MKT-2/decision', ai, { verdict: 'approved', source_url: 'not a link', quote: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/tasks/MKT-2/decision', human, { verdict: 'approved', source_url: CHAT, quote: 'x' })).status).toBe(403);
    // review_task can't be used to smuggle in a forged "via".
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Third' }); // MKT-3
    await call('POST', '/api/tasks/MKT-3/claim', ai);
    await call('POST', '/api/tasks/MKT-3/submit', ai, { summary: 'x', deliverables: [{ url: 'https://x.example' }] });
    await call('POST', '/api/tasks/MKT-3/review', human, { verdict: 'approved', via: { agent: 'fake', source_url: 'https://evil', quote: 'x' } });
    expect((await task('MKT-3')).reviews[0].via).toBeNull();
  });

  it('lets the person undo it while nothing has moved, and only them', async () => {
    await tool(ai, 'record_decision', { key: 'MKT-1', verdict: 'approved', source_url: CHAT, quote: 'Merge' });
    expect((await call('POST', '/api/tasks/MKT-1/decision/undo', bob)).status).toBe(403);
    const r = await call('POST', '/api/tasks/MKT-1/decision/undo', human);
    expect(r.status).toBe(200);
    const t = await task('MKT-1');
    expect(t.status).toBe('review');
    expect(t.reviews).toEqual([]);
    expect(t.history[0]).toMatchObject({ type: 'decision_undone', actor: 'L' });
    expect((await call('POST', '/api/tasks/MKT-1/decision/undo', human)).status).toBe(409);
  });

  it('restores the question when an answer is undone', async () => {
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'changes_requested', comment: 'more' });
    await call('PATCH', '/api/tasks/MKT-1', ai, { blocked_question: 'Which currency?' });
    await tool(ai, 'record_decision', { key: 'MKT-1', verdict: 'answer', source_url: CHAT, quote: 'EUR', answer: 'EUR' });
    await call('POST', '/api/tasks/MKT-1/decision/undo', human);
    const t = await task('MKT-1');
    expect(t.status).toBe('blocked');
    expect(t.blocked_question).toBe('Which currency?');
  });
});
