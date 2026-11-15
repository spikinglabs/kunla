import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { sign } from '../src/github';
import { linkApp, APP_SECRET } from './gh-app';

// KD-88: put a task into a project, move it to another, or back to the workspace level.
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

let human: string, ai: string, ws: string;
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', workspace_key: 'SL', project_key: 'mkt', project_name: 'Q1 campaign' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai', platform: 'claude-ai' })).body.token;
  await call('POST', '/api/projects', human, { key: 'PBI', name: 'powerbi-cli' });
  ws = (await call('GET', '/api/me', human)).body.workspace.key;
});

describe('moving a task between projects', () => {
  it('puts a workspace-level task into a project with its sub-tasks, and the old keys keep working', async () => {
    const t = (await call('POST', '/api/tasks', human, { title: 'New project: powerbi-cli' })).body;
    expect(t.key).toBe(`${ws}-1`);
    const s1 = (await call('POST', '/api/tasks', human, { parent: t.key, title: 'Lake tools' })).body;
    const s2 = (await call('POST', '/api/tasks', human, { parent: t.key, title: 'Test on a real tenant' })).body;

    const r = await call('PATCH', `/api/tasks/${t.key}`, human, { project: 'pbi' });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('PBI-1');
    const d = (await call('GET', '/api/tasks/PBI-1', human)).body;
    expect(d.project).toMatchObject({ key: 'PBI', name: 'powerbi-cli' });
    expect(d.old_keys).toEqual([t.key]);
    expect(d.subtasks.map((x: any) => x.key)).toEqual(['PBI-2', 'PBI-3']);
    expect(d.history[0]).toMatchObject({ type: 'moved', data: { from_key: t.key, to_key: 'PBI-1', to_project: 'PBI' } });

    // Old keys, short or full, still open the task: in the app, over MCP and in search.
    expect((await call('GET', `/api/tasks/${t.key}`, human)).body.key).toBe('PBI-1');
    expect((await call('GET', `/api/tasks/${s1.key}`, human)).body.key).toBe('PBI-2');
    expect((await call('GET', `/api/tasks/${ws}-${s2.key}`, human)).body.key).toBe('PBI-3');
    expect((await tool(ai, 'get_task', { key: t.key })).data.key).toBe('PBI-1');
    expect((await call('GET', `/api/tasks?q=${t.key}`, human)).body.map((x: any) => x.key)).toContain('PBI-1');
    // New work in the workspace never reuses a key that moved away.
    expect((await call('POST', '/api/tasks', human, { title: 'Something else' })).body.key).toBe(`${ws}-4`);
  });

  it('moves between projects and back to the workspace level, keeping every key it had', async () => {
    const t = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' })).body;
    const a = (await call('PATCH', `/api/tasks/${t.key}`, human, { project: 'PBI' })).body;
    expect(a.key).toBe('PBI-1');
    const b = (await call('PATCH', '/api/tasks/MKT-1', human, { project: '' })).body;
    expect(b.key).toBe(`${ws}-1`);
    const d = (await call('GET', `/api/tasks/${b.key}`, human)).body;
    expect(d.project).toBeNull();
    expect(d.old_keys).toEqual(['MKT-1', 'PBI-1']);
    // Moving to where it already is changes nothing; the workspace key means "no project".
    expect((await call('PATCH', `/api/tasks/${b.key}`, human, { project: ws })).body.key).toBe(b.key);
  });

  it('keeps sub-tasks with their parent and stays inside the workspace', async () => {
    const t = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Launch' })).body;
    const s = (await call('POST', '/api/tasks', human, { parent: t.key, title: 'Email' })).body;
    const sub = await call('PATCH', `/api/tasks/${s.key}`, human, { project: 'PBI' });
    expect(sub.status).toBe(400);
    expect(sub.body.error).toContain(`Move ${t.key} instead`);
    expect((await call('PATCH', `/api/tasks/${t.key}`, human, { project: 'NOPE' })).status).toBe(404);
    // A project in another workspace is out of reach.
    await call('POST', '/api/workspaces', human, { name: 'Community', key: 'COM' });
    expect((await call('PATCH', `/api/tasks/${t.key}`, human, { project: 'COM' })).status).toBe(404);
    expect((await call('GET', `/api/tasks/${t.key}`, human)).body.key).toBe(t.key);
  });

  it('lets agents move tasks over MCP, but not a task someone else holds', async () => {
    const mine = (await tool(ai, 'create_task', { title: 'Write the README', status: 'ready' })).data;
    const moved = await tool(ai, 'update_task', { key: mine.key, project: 'PBI' });
    expect(moved.data.key).toBe('PBI-1');
    const held = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Mine' })).body;
    await call('POST', `/api/tasks/${held.key}/claim`, human);
    const no = await tool(ai, 'update_task', { key: held.key, project: 'PBI' });
    expect(no.isError).toBe(true);
    expect(no.data).toContain('project');
  });

  it('still links commits and PRs that cite the old key', async () => {
    await linkApp(env.DB);
    const t = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' })).body;
    await call('PATCH', `/api/tasks/${t.key}`, human, { project: 'PBI' });
    let n = 0;
    const hook = async (event: string, payload: object) => {
      const body = JSON.stringify({ ...payload, installation: { id: 42 } });
      const res = await app.fetch(new Request('https://kunla.test/hooks/github', { method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': `m-${++n}`, 'x-hub-signature-256': await sign(APP_SECRET, body) } }), env);
      return res.json<any>();
    };
    const push = await hook('push', { ref: 'refs/heads/mkt-1', commits: [{ id: 'abcdef1234', message: 'Tiers\n\nTask: MKT-1', url: 'https://github.com/acme/app/commit/abcdef1', distinct: true, author: { username: 'octo' } }] });
    expect(push.linked).toEqual(['PBI-1']);
    await hook('pull_request', { action: 'opened', pull_request: { number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'MKT-1: Pricing page', body: '', draft: false, merged: false, head: { ref: 'mkt-1' }, user: { login: 'octo' } } });
    const d = (await call('GET', '/api/tasks/PBI-1', human)).body;
    expect(d.history.filter((e: any) => e.type === 'github').map((e: any) => e.note)).toContain('Commit abcdef1 on mkt-1 by @octo: Tiers');
    // The PR titled with the old key is still this task's work.
    expect(d.deliverables.map((x: any) => x.url)).toContain('https://github.com/acme/app/pull/7');
  });
});
