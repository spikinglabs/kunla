import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { sign } from '../src/github';
import { prFromLinks } from '../src/merge';
import { linkApp, APP_SECRET } from './gh-app';

let env: any;
let human: string, ai: string, aiId: string;
let pending: Promise<unknown>[] = [];
type Gh = { pr: any; runs: any[]; mergeStatus?: number };
let gh: Gh;
let calls: { method: string; url: string; body: any }[] = [];

const exec = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} } as any;
const flush = async () => { while (pending.length) { const p = pending; pending = []; await Promise.all(p); } };
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, exec);
  const text = await res.text();
  await flush();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  calls = [];
  gh = { pr: { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'abc' }, title: 'MKT-1: Pricing' }, runs: [{ status: 'completed', conclusion: 'success' }] };
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (url.includes('agent.test')) return new Response('ok');
    if (url.endsWith('/repos/acme/app/installation')) return json({ id: 42 });
    if (url.endsWith('/app/installations/42/access_tokens')) return json({ token: 'ghs_install' }, 201);
    if (url.endsWith('/pulls/7')) return json(gh.pr);
    if (url.includes('/check-runs')) return json({ check_runs: gh.runs });
    if (url.endsWith('/pulls/7/merge')) return gh.mergeStatus ? json({ message: 'Base branch was modified' }, gh.mergeStatus) : json({ sha: 'merged1', merged: true });
    return json({}, 404);
  });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  const a = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai' });
  ai = a.body.token; aiId = a.body.member.id;
  await call('PUT', `/api/members/${aiId}/wake`, human, { url: 'https://agent.test/wake' });
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' });
  await call('POST', '/api/tasks/MKT-1/claim', ai);
  await call('POST', '/api/tasks/MKT-1/submit', ai, { summary: 'Done', deliverables: [{ url: 'https://github.com/acme/app/pull/7' }] });
  calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

const approve = () => call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
const setToken = () => linkApp(env.DB);
const wakeBody = () => calls.find((c) => c.url.includes('agent.test'))?.body;

describe('approve = merge', () => {
  it('finds the PR among the deliverables', () => {
    expect(prFromLinks([{ url: 'https://docs.x' }, { url: 'https://github.com/a/b/pull/12/files' }])).toMatchObject({ owner: 'a', repo: 'b', number: 12, url: 'https://github.com/a/b/pull/12' });
    expect(prFromLinks([{ url: 'https://github.com/a/b/issues/3' }])).toBeNull();
  });

  it('without a token, tells the woken agent to merge', async () => {
    await approve();
    expect(calls.some((c) => c.url.includes('api.github.com'))).toBe(false);
    expect(wakeBody()).toMatchObject({ event: 'approved', merge: { pr: 'https://github.com/acme/app/pull/7', by_kunla: false } });
    expect(wakeBody().next).toContain('Merge https://github.com/acme/app/pull/7 (squash)');
  });

  it('with a token and green checks, squash-merges the PR and notes it', async () => {
    await setToken();
    expect((await call('GET', '/api/integrations/github', human)).body.merge_ready).toBe(true);
    const card = await call('GET', '/api/tasks/MKT-1/pr', human);
    expect(card.body).toMatchObject({ merge_by: 'kunla', checks: 'green', state: 'open', conflict: false });
    calls = [];
    await approve();
    const m = calls.find((c) => c.method === 'PUT');
    expect(m).toMatchObject({ url: 'https://api.github.com/repos/acme/app/pulls/7/merge', body: { merge_method: 'squash', sha: 'abc' } });
    expect(m!.body.commit_message).toContain('Task: MKT-1');
    const t = await task('MKT-1');
    expect(t.status).toBe('done');
    expect(t.history.map((e: any) => e.type)).toContain('merged');
    expect(wakeBody().merge.by_kunla).toBe(true);
  });

  it('sends the task back to the agent when checks are red', async () => {
    await setToken();
    gh.runs = [{ status: 'completed', conclusion: 'failure' }];
    await approve();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const t = await task('MKT-1');
    expect(t.status).toBe('in_progress');
    expect(t.history.find((e: any) => e.type === 'merge_blocked').note).toContain('checks are failing');
    const wakes = calls.filter((c) => c.url.includes('agent.test')).map((c) => c.body.event);
    expect(wakes).toContain('changes_requested');
  });

  it('sends it back on a conflict', async () => {
    await setToken();
    gh.pr = { ...gh.pr, mergeable: false, mergeable_state: 'dirty' };
    await approve();
    expect((await task('MKT-1')).history.find((e: any) => e.type === 'merge_blocked').note).toContain('conflicts');
  });

  it('waits for running checks and merges when GitHub reports the suite finished', async () => {
    await setToken();
    gh.runs = [{ status: 'in_progress', conclusion: null }];
    await approve();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect((await task('MKT-1')).history.map((e: any) => e.type)).toContain('merge_waiting');
    gh.runs = [{ status: 'completed', conclusion: 'success' }];
    const payload = JSON.stringify({ action: 'completed', check_suite: { conclusion: 'success', pull_requests: [{ number: 7 }] }, repository: { full_name: 'acme/app' }, installation: { id: 42 } });
    const res = await app.fetch(new Request('https://kunla.test/hooks/github', { method: 'POST', body: payload,
      headers: { 'content-type': 'application/json', 'x-github-event': 'check_suite', 'x-github-delivery': 'cs1', 'x-hub-signature-256': await sign(APP_SECRET, payload) } }), env, exec);
    await flush();
    expect((await res.json<any>()).merged).toEqual(['MKT-1:merged']);
    const m = calls.find((c) => c.method === 'PUT');
    expect(m!.body.commit_message).toContain('Approved in Kunla by L');
  });

  it("never picks another task's PR, and doesn't offer to merge one that is already merged", async () => {
    await setToken();
    await call('POST', '/api/log', ai, { task: 'MKT-1', summary: 'Mentioned elsewhere', deliverables: [{ url: 'https://github.com/acme/app/pull/9', title: 'PR #9: MKT-2: Something else' }] });
    expect((await call('GET', '/api/tasks/MKT-1/pr', human)).body.pr.number).toBe(7);
    gh.pr = { ...gh.pr, state: 'closed', merged: true };
    expect((await call('GET', '/api/tasks/MKT-1/pr', human)).body.state).toBe('merged');
    calls = [];
    await approve();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect((await task('MKT-1')).status).toBe('done');
  });

  it('merges only for the workspace the app is installed in', async () => {
    await setToken();
    const ws = (await call('POST', '/api/workspaces', human, { name: 'Community' })).body;
    expect((await call('GET', '/api/integrations/github', ws.token)).body.merge_ready).toBe(false);
    expect((await call('GET', '/api/integrations/github', human)).body.merge_ready).toBe(true);
  });
});
