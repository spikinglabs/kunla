import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { sign } from '../src/github';

let env: any;
let human: string, ai: string, aiId: string;
let pending: Promise<unknown>[] = [];
let calls: { url: string; headers: Record<string, string>; body: any; raw: string }[] = [];
let reply: () => Response = () => new Response('ok');

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
const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;

beforeEach(async () => {
  calls = []; reply = () => new Response('ok');
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    return reply();
  });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  const a = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai', platform: 'claude-code' });
  ai = a.body.token; aiId = a.body.member.id;
});
afterEach(() => { vi.unstubAllGlobals(); });

const setWake = (body: unknown) => call('PUT', `/api/members/${aiId}/wake`, human, body);
const aiCall = (method: string, path: string, body?: unknown) => call(method, path, ai, body);

describe('wake-up URL settings', () => {
  it('is set by the sponsor, shown without secrets, and only https', async () => {
    expect((await setWake({ url: 'http://x.test/hook' })).status).toBe(400);
    expect((await aiCall('PUT', `/api/members/${aiId}/wake`, { url: 'https://x.test/hook' })).status).toBe(403);
    const r = await setWake({ url: 'https://x.test/hook', auth: 'abc' });
    expect(r.body.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(r.body.callback).toEqual({ url: 'https://x.test/hook', format: 'kunla', has_auth: true });
    const team = await call('GET', '/api/members', human);
    const row = team.body.find((m: any) => m.id === aiId);
    expect(row.wake).toEqual({ url: 'https://x.test/hook', format: 'kunla', has_auth: true });
    expect(JSON.stringify(team.body)).not.toContain(r.body.secret);
    expect(JSON.stringify(team.body)).not.toContain('Bearer abc');
    expect((await call('DELETE', `/api/members/${aiId}/wake`, human)).body.callback).toBeNull();
  });
  it('detects GitHub repository_dispatch URLs and sends a test call', async () => {
    const r = await setWake({ url: 'https://api.github.com/repos/acme/app/dispatches', auth: 'ghp_x' });
    expect(r.body.callback.format).toBe('github_dispatch');
    const t = await call('POST', `/api/members/${aiId}/wake/test`, human);
    expect(t.body).toMatchObject({ ok: true, status: 200 });
    expect(calls[0].body).toMatchObject({ event_type: 'kunla-ping', client_payload: { event: 'ping', agent: 'Coder' } });
    expect(calls[0].headers.authorization).toBe('Bearer ghp_x');
  });
});

describe('waking the agent on decisions', () => {
  let secret: string;
  beforeEach(async () => {
    secret = (await setWake({ url: 'https://agent.test/wake' })).body.secret;
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' }); // MKT-1
    await aiCall('POST', '/api/tasks/MKT-1/claim');
    await aiCall('POST', '/api/tasks/MKT-1/submit', { summary: 'Done', deliverables: [{ url: 'https://x.test/pr/1' }] });
    calls = [];
  });

  it('wakes it, signed, when a person approves, and notes it on the task', async () => {
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved', comment: 'Nice' });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://agent.test/wake');
    expect(c.headers['x-kunla-event']).toBe('approved');
    expect(c.headers['x-kunla-signature-256']).toBe(await sign(secret, c.raw));
    expect(c.body).toMatchObject({ event: 'approved', agent: 'Coder', by: 'L', note: 'Nice', task: { key: 'MKT-1', status: 'done', link: 'https://kunla.test/t/MKT-1' } });
    expect(c.body.next).toContain('next_task');
    expect((await task('MKT-1')).history[0]).toMatchObject({ type: 'woke', actor: null });
  });

  it('wakes it when work is sent back, with what to fix', async () => {
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'changes_requested', what_was_wrong: 'No free tier', rule: 'Always show the free tier' });
    expect(calls[0].body).toMatchObject({ event: 'changes_requested', task: { status: 'in_progress' } });
    expect(calls[0].body.note).toContain('No free tier');
    expect(calls[0].body.note).toContain('New rule: Always show the free tier');
  });

  it('wakes it when its question is answered', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Launch email' }); // MKT-2
    await aiCall('POST', '/api/tasks/MKT-2/claim');
    await aiCall('PATCH', '/api/tasks/MKT-2', { blocked_question: 'Which date?' });
    calls = [];
    await call('POST', '/api/tasks/MKT-2/answer', human, { answer: 'Monday' });
    expect(calls[0].body).toMatchObject({ event: 'answered', note: 'Monday', task: { key: 'MKT-2', status: 'in_progress' } });
  });

  it('wakes it when a task is handed to it', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Blog post', assignee: 'Coder' });
    expect(calls[0].body).toMatchObject({ event: 'assigned', task: { key: 'MKT-2' } });
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Unassigned' });
    await call('PATCH', '/api/tasks/MKT-3', human, { assignee: 'Coder' });
    expect(calls[1].body).toMatchObject({ event: 'assigned', task: { key: 'MKT-3' } });
    expect(calls).toHaveLength(2);
  });

  it('retries once, then records the failure on the task', async () => {
    reply = () => new Response('down', { status: 503 });
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect(calls).toHaveLength(2);
    const h = (await task('MKT-1')).history[0];
    expect(h.type).toBe('wake_failed');
    expect(h.note).toContain('HTTP 503');
  });

  it('does not retry a wrong URL or token', async () => {
    reply = () => new Response('nope', { status: 401 });
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect(calls).toHaveLength(1);
  });

  it('stays quiet for agents without a wake-up URL', async () => {
    await call('DELETE', `/api/members/${aiId}/wake`, human);
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect(calls).toHaveLength(0);
    expect((await task('MKT-1')).history[0].type).toBe('approved');
  });
});
