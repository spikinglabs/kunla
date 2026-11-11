// KD-70: a shared Kunla Cloud host (pilot teams as workspaces in one Kunla), workspace-level admins with a Kunla
// owner, and task keys that are short inside a workspace (MKT-42) and full across workspaces (ACME-MKT-42).
import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import app from '../src/index';
import { findKeys } from '../src/github';
import { makeD1 } from './d1-shim';

let env: any, owner: string;
const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json<any>() };
};
const signed = (method: string, path: string, body = '', secret = 'cloud-secret') => {
  const ts = Math.floor(Date.now() / 1000);
  return call(method, path, undefined, body || undefined, { 'x-kunla-timestamp': String(ts), 'x-kunla-signature-256': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` });
};
const setup = async (extra: Record<string, string> = {}) => {
  env = { DB: makeD1(), LEASE_MINUTES: '30', ...extra };
  owner = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Marketing' })).body.token;
};

describe('a shared Kunla Cloud host', () => {
  beforeEach(() => setup({ KUNLA_CLOUD_SECRET: 'cloud-secret', KUNLA_FREE_SEATS: '2', KUNLA_CLOUD_SHARED: 'true' }));
  const signUp = async (name: string, key: string, admin_name = 'Ada', admin_email?: string) =>
    signed('POST', '/api/cloud/workspaces', JSON.stringify({ name, key, admin_name, ...(admin_email ? { admin_email } : {}) }));

  it('creates a customer workspace from a signed call, with its first admin (not the Kunla owner)', async () => {
    const r = await signUp('Acme', 'ACME', 'Ada', 'ada@acme.test');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ workspace: { key: 'ACME', name: 'Acme' }, token: expect.stringMatching(/^kun_/) });
    const me = await call('GET', '/api/me', r.body.token);
    expect(me.body).toMatchObject({ name: 'Ada', roles: ['admin'], workspace: { key: 'ACME' }, projects: [] });
    expect((await signUp('Other', 'ACME')).status).toBe(409);
    // One person may run several workspaces: the same email is fine (sign-in links them, KD-29).
    expect((await signUp('Again', 'AG', 'Ada', 'ada@acme.test')).status).toBe(200);
    // Unsigned calls are refused; people cannot create or import workspaces on a shared host.
    expect((await call('POST', '/api/cloud/workspaces', owner, { name: 'X', admin_name: 'X' })).status).toBe(401);
    expect((await call('POST', '/api/workspaces', owner, { name: 'X' })).status).toBe(403);
    expect((await call('POST', '/api/workspaces', r.body.token, { name: 'X' })).status).toBe(403);
  });

  it('keeps a plan and a head count per workspace', async () => {
    const acme = (await signUp('Acme', 'ACME')).body.token;
    expect((await signed('GET', '/api/cloud/plan')).status).toBe(400);
    expect((await signed('GET', '/api/cloud/plan?workspace=NOPE')).status).toBe(400);
    expect((await signed('GET', '/api/cloud/plan?workspace=ACME')).body).toMatchObject({ plan: { name: 'free', seats: 2 }, people: 1, agents: 0 });

    // Free seats are per workspace: Acme fills its two seats whatever the first workspace does.
    expect((await call('POST', '/api/members', owner, { name: 'Sam', kind: 'human' })).status).toBe(200);
    expect((await call('POST', '/api/members', acme, { name: 'Bo', kind: 'human' })).status).toBe(200);
    expect((await call('POST', '/api/members', acme, { name: 'Cy', kind: 'human' })).status).toBe(402);
    expect((await call('POST', '/api/members', acme, { name: 'Bot', kind: 'ai' })).status).toBe(200);

    expect((await signed('PUT', '/api/cloud/plan?workspace=acme', JSON.stringify({ name: 'team', seats: null }))).body)
      .toMatchObject({ plan: { name: 'team', seats: null }, people: 2, agents: 1 });
    expect((await call('POST', '/api/members', acme, { name: 'Cy', kind: 'human' })).status).toBe(200);
    // The other workspace is still on its own free plan.
    expect((await call('POST', '/api/members', owner, { name: 'Tia', kind: 'human' })).status).toBe(402);

    // The sign-in page shows no plan to strangers; a signed-in person sees their workspace's.
    expect((await call('GET', '/api/edition')).body.plan).toBeNull();
    expect((await call('GET', '/api/edition', acme)).body.plan).toEqual({ name: 'team', seats: null });
    expect((await call('GET', '/api/edition', owner)).body.plan).toEqual({ name: 'free', seats: 2 });
  });

  it('is not offered by a Kunla that holds one team', async () => {
    await setup({ KUNLA_CLOUD_SECRET: 'cloud-secret' });
    expect((await signUp('Acme', 'ACME')).status).toBe(409);
    expect((await signed('GET', '/api/cloud/plan')).body.plan).toEqual({ name: 'free', seats: 5 });
  });
});

describe('workspace admins and the Kunla owner', () => {
  beforeEach(() => setup());

  it('lets only the owner create workspaces and share ownership; admins run their own workspace', async () => {
    const ws = await call('POST', '/api/workspaces', owner, { name: 'Community', key: 'COM' });
    expect(ws.status).toBe(200);
    const sam = await call('POST', '/api/members', owner, { name: 'Sam', kind: 'human', roles: ['admin'] });
    expect(sam.status).toBe(200);
    const samToken = sam.body.token;
    expect((await call('GET', '/api/me', samToken)).body.roles).toEqual(['admin']);
    // An admin adds people and admins in their workspace, but not owners, and never makes an agent an admin.
    expect((await call('POST', '/api/members', samToken, { name: 'Ann', kind: 'human', roles: ['admin'] })).status).toBe(200);
    expect((await call('POST', '/api/members', samToken, { name: 'Bob', kind: 'human', roles: ['owner'] })).status).toBe(403);
    expect((await call('POST', '/api/members', owner, { name: 'Bot', kind: 'ai', roles: ['admin'] })).status).toBe(403);
    // Whole-Kunla actions stay with the owner.
    expect((await call('POST', '/api/workspaces', samToken, { name: 'Side' })).status).toBe(403);
    expect((await call('POST', '/api/import', samToken, {})).status).toBe(403);
    // The owner can share ownership.
    expect((await call('POST', '/api/members', owner, { name: 'Co', kind: 'human', roles: ['admin', 'owner'] })).status).toBe(200);
  });
});

describe('task keys: short inside a workspace, full across', () => {
  beforeEach(() => setup());

  it('lets two workspaces use the same project key, and finds a task by its full key', async () => {
    const com = (await call('POST', '/api/workspaces', owner, { name: 'Community', key: 'COM' })).body.token;
    expect((await call('POST', '/api/projects', com, { key: 'MKT', name: 'Community marketing' })).status).toBe(200);
    expect((await call('POST', '/api/projects', com, { key: 'MKT', name: 'Again' })).status).toBe(409);
    const a = (await call('POST', '/api/tasks', owner, { project: 'MKT', title: 'Launch post' })).body;
    const b = (await call('POST', '/api/tasks', com, { project: 'MKT', title: 'Meetup' })).body;
    expect(a.key).toBe('MKT-1');
    expect(b.key).toBe('MKT-1');

    const mine = (await call('GET', '/api/tasks/MKT-1', com)).body;
    expect(mine).toMatchObject({ title: 'Meetup', full_key: 'COM-MKT-1' });
    expect((await call('GET', '/api/tasks/COM-MKT-1', com)).body.title).toBe('Meetup');
    // A full key from another workspace is not a way in.
    expect((await call('GET', '/api/tasks/WS-MKT-1', com)).status).toBe(404);
    expect((await call('GET', '/api/tasks/COM-MKT-1', owner)).status).toBe(404);

    // Waiting on a task by its full key works too.
    const w = await call('POST', '/api/tasks', com, { project: 'MKT', title: 'Recap', waiting_on: ['COM-MKT-1'] });
    expect(w.status).toBe(200);
    expect((await call('GET', `/api/tasks/${w.body.key}`, com)).body.waiting_on[0]).toMatchObject({ kind: 'task', task: { key: 'MKT-1' } });
  });

  it('reads full keys in commits and PRs, and ignores prefixes that are not workspace keys', () => {
    expect(findKeys('COM-MKT-12: fix the footer', 'Task: MKT-3')).toEqual(expect.arrayContaining(['COM-MKT-12', 'MKT-3']));
  });
});
