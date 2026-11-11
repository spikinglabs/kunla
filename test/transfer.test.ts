// KD-74: export a workspace and move it to another Kunla.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

const call = async (env: any, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const tool = (env: any, token: string, name: string, args: unknown) => call(env, 'POST', `/api/tools/${name}`, token, args);

let from: any, human: string, ai: string;

beforeEach(async () => {
  from = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call(from, 'POST', '/api/setup', undefined, { name: 'L', workspace_key: 'SL', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
  ai = (await call(from, 'POST', '/api/members', human, { name: "L's Claude", kind: 'ai', platform: 'claude-code' })).body.token;
  await tool(from, human, 'create_task', { project: 'KD', title: 'Parent work', status: 'ready' });
  await tool(from, human, 'create_task', { project: 'KD', title: 'Child work', status: 'ready', parent: 'KD-1' });
  await tool(from, ai, 'claim_task', { key: 'KD-2' });
  await tool(from, ai, 'submit_for_review', { key: 'KD-2', summary: 'Done', deliverables: [{ url: 'https://example.com/pr/1' }], notes: 'All of it' });
  await tool(from, human, 'review_task', { key: 'KD-2', verdict: 'changes_requested', what_was_wrong: 'Too short', rule: 'Write more than one line', comment: 'Say more' });
  await tool(from, human, 'log_work', { summary: 'A chat that reached a decision' });
});

describe('workspace export', () => {
  it('is for admins only', async () => {
    expect((await call(from, 'GET', '/api/export', ai)).status).toBe(403);
    const r = await call(from, 'GET', '/api/export', human);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/kunla-sl-\d{4}-\d\d-\d\d\.json/);
    expect(r.body).toMatchObject({ format: 'kunla-workspace', format_version: 1, workspace: { key: 'SL' } });
    expect(r.body.tables.tasks.map((t: any) => t.key).sort()).toEqual(['KD-1', 'KD-2', 'SL-1']);
    expect(r.body.tables.tokens).toHaveLength(2);
    expect(r.body.tables.rules).toHaveLength(1);
  });

  it('leaves other workspaces out', async () => {
    const other = (await call(from, 'POST', '/api/workspaces', human, { name: 'Community', key: 'COM' })).body.token;
    await tool(from, other, 'log_work', { summary: 'Community work' });
    const r = await call(from, 'GET', '/api/export', human);
    expect(r.body.tables.tasks.some((t: any) => t.key.startsWith('COM'))).toBe(false);
    expect(r.body.tables.members).toHaveLength(2);
  });
});

describe('workspace import', () => {
  it('moves everything to a fresh Kunla, where the same tokens and keys keep working', async () => {
    const data = (await call(from, 'GET', '/api/export', human)).body;
    const to = { DB: makeD1(), LEASE_MINUTES: '30', SETUP_TOKEN: 'secret' };
    expect((await call(to, 'POST', '/api/import', undefined, data)).status).toBe(403);
    const r = await call(to, 'POST', '/api/import', undefined, data, { 'x-kunla-setup-token': 'secret' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ imported: true, workspace: { key: 'SL' }, counts: { tasks: 3, members: 2 } });

    // Same tokens, same keys, same history and rules.
    const me = await call(to, 'GET', '/api/me', ai);
    expect(me.body).toMatchObject({ name: "L's Claude", sponsor: 'L' });
    const t = (await call(to, 'GET', '/api/tasks/KD-2', human)).body;
    expect(t.parent.key).toBe('KD-1');
    expect(t.deliverables.map((d: any) => d.url)).toContain('https://example.com/pr/1');
    expect(t.history.length).toBe((await call(from, 'GET', '/api/tasks/KD-2', human)).body.history.length);
    expect(t.rules?.length ?? (await call(to, 'GET', '/api/rules', human)).body.length).toBeGreaterThan(0);
    // Numbering carries on where it was.
    const next = await tool(to, human, 'create_task', { project: 'KD', title: 'After the move', status: 'ready' });
    expect(next.body.result.key).toBe('KD-3');
    // Only one workspace on the new Kunla, and setup is done.
    expect((await call(to, 'GET', '/api/setup')).body.set_up).toBe(true);
    expect(await to.DB.prepare(`SELECT COUNT(*) AS n FROM projects WHERE kind = 'workspace'`).first('n')).toBe(1);
  });

  it('adds a workspace to a Kunla in use, for admins, and refuses clashes without changing anything', async () => {
    const data = (await call(from, 'GET', '/api/export', human)).body;
    const to = { DB: makeD1(), LEASE_MINUTES: '30' };
    const admin = (await call(to, 'POST', '/api/setup', undefined, { name: 'M', workspace_key: 'ACME', project_key: 'OPS', project_name: 'Ops' })).body.token;
    const agent = (await call(to, 'POST', '/api/members', admin, { name: 'Bot', kind: 'ai' })).body.token;
    expect((await call(to, 'POST', '/api/import', undefined, data)).status).toBe(401);
    expect((await call(to, 'POST', '/api/import', agent, data)).status).toBe(403);
    expect((await call(to, 'POST', '/api/import', admin, data)).status).toBe(200);
    // Each workspace still sees only its own work.
    expect((await call(to, 'GET', '/api/tasks', admin)).body.tasks?.some?.((t: any) => t.key.startsWith('KD')) ?? false).toBe(false);
    const kd1 = await call(to, 'GET', '/api/tasks/KD-1', ai);
    expect(kd1.status, JSON.stringify(kd1.body)).toBe(200);

    const again = await call(to, 'POST', '/api/import', admin, data);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already has project key (SL|KD)/);
  });

  it('rejects files that are not exports', async () => {
    const to = { DB: makeD1(), LEASE_MINUTES: '30' };
    expect((await call(to, 'POST', '/api/import', undefined, { hello: 1 })).status).toBe(400);
    expect(await to.DB.prepare('SELECT COUNT(*) AS n FROM members').first('n')).toBe(0);
  });
});
