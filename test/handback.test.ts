// KD-54: work a person hands back to an agent (an answer, or changes requested) waits for that agent
// for a day instead of lapsing to Ready after the 30-minute lease.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

let env: any;
let human: string, ai: string;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const tool = async (token: string, name: string, args: unknown) => (await call('POST', `/api/tools/${name}`, token, args)).body?.result;
const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;
const later = (hours: number) => vi.setSystemTime(Date.now() + hours * 3_600_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai', platform: 'claude-ai' })).body.token;
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Launch post' });
  await tool(ai, 'claim_task', { key: 'MKT-1' });
});
afterEach(() => { vi.useRealTimers(); });

describe('handing work back to an agent', () => {
  it('keeps an answered task with the agent for hours, and next_task offers it first', async () => {
    await tool(ai, 'update_task', { key: 'MKT-1', blocked_question: 'Which audience?' });
    expect((await call('POST', '/api/tasks/MKT-1/answer', human, { answer: 'Developers' })).status).toBe(200);
    later(4);
    const next = await tool(ai, 'next_task', {});
    expect(next.reason).toBe('continue');
    expect(next.task.key).toBe('MKT-1');
    expect((await task('MKT-1')).status).toBe('in_progress');
  });

  it('goes back to Ready after a day if the agent never returns', async () => {
    await tool(ai, 'update_task', { key: 'MKT-1', blocked_question: 'Which audience?' });
    await call('POST', '/api/tasks/MKT-1/answer', human, { answer: 'Developers' });
    later(25);
    await call('GET', '/api/tasks', human);
    await tool(ai, 'whoami', {});
    const t = await task('MKT-1');
    expect(t.status).toBe('ready');
    expect(t.assignee).toBeNull();
  });

  it('keeps work sent back with changes for the agent too', async () => {
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Draft', notes: 'v1' });
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'changes_requested', comment: 'Shorter' });
    later(3);
    const next = await tool(ai, 'next_task', {});
    expect(next.task.key).toBe('MKT-1');
    expect(next.reason).toBe('continue');
  });

  it('a heartbeat goes back to the normal lease', async () => {
    await tool(ai, 'update_task', { key: 'MKT-1', blocked_question: 'Which audience?' });
    await call('POST', '/api/tasks/MKT-1/answer', human, { answer: 'Developers' });
    await tool(ai, 'heartbeat', { key: 'MKT-1' });
    later(1);
    await tool(ai, 'whoami', {});
    expect((await task('MKT-1')).status).toBe('ready');
  });
});
