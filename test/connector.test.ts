// KD-29: one claude.ai connector for several workspaces. The person ticks the workspaces when approving; each call
// acts in exactly one (the default unless it names another); revoking one workspace leaves the others.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

let env: any, sl: string, com: string, side: string;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json<any>().catch(() => null) };
};
const rpc = (token: string, method: string, params: object = {}, path = '/mcp') => call('POST', path, token, { jsonrpc: '2.0', id: 1, method, params });
const tool = async (token: string, name: string, args: object = {}, path = '/mcp') => {
  const r = await rpc(token, 'tools/call', { name, arguments: args }, path);
  const text = r.body?.result?.content?.[0]?.text ?? '';
  return { error: !!r.body?.result?.isError, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

async function connect(grants: string[], opts: { resource?: string; as?: string } = {}) {
  const reg = await call('POST', '/oauth/register', undefined, { client_name: 'claude.ai', redirect_uris: ['https://claude.ai/cb'] });
  const verifier = 'v'.repeat(50);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const appr = await call('POST', '/oauth/approve', opts.as ?? sl, { client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/cb', code_challenge: challenge,
    code_challenge_method: 'S256', grants, ...(opts.resource ? { resource: opts.resource } : {}) });
  if (appr.status !== 200) return { status: appr.status, error: appr.body.error, token: '' };
  const code = new URL(appr.body.redirect).searchParams.get('code')!;
  const tok = await app.fetch(new Request('https://kunla.test/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/cb' }) }), env);
  return { status: 200, token: (await tok.json<any>()).access_token as string, workspaces: appr.body.workspaces };
}

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  sl = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
  com = (await call('POST', '/api/workspaces', sl, { name: 'Community', key: 'COM' })).body.token;
  side = (await call('POST', '/api/workspaces', sl, { name: 'Side', key: 'SIDE' })).body.token;
  await call('POST', '/api/projects', com, { key: 'KD', name: 'Community docs' });
});

describe('one connector for several workspaces', () => {
  it('reaches only the ticked workspaces, one per call, default first', async () => {
    const c = await connect([com]);
    expect(c.workspaces).toBe(2);
    const who = await tool(c.token, 'whoami');
    expect(who.data.workspace.key).toBe('WS');
    expect(who.data.workspaces.map((w: any) => [w.key, w.default])).toEqual([['WS', true], ['COM', false]]);

    // tools/list offers the workspace argument only to such a connection.
    const list = await rpc(c.token, 'tools/list');
    expect(list.body.result.tools.find((t: any) => t.name === 'log_work').inputSchema.properties.workspace.description).toMatch(/WS, COM/);

    // Same project key in both workspaces; each call lands in the one it names.
    const a = await tool(c.token, 'log_work', { project: 'KD', summary: 'Kunla work' });
    const b = await tool(c.token, 'log_work', { project: 'KD', summary: 'Community work', workspace: 'com' });
    expect(a.data.key).toBe('KD-1');
    expect(b.data.key).toBe('KD-1');
    expect((await call('GET', '/api/tasks/KD-1', sl)).body.title).toMatch(/Kunla work/);
    expect((await call('GET', '/api/tasks/KD-1', com)).body.title).toMatch(/Community work/);
    expect((await call('GET', '/api/tasks/KD-1', com)).body.created_by.name).toBe("L's claude.ai");
    expect((await tool(c.token, 'whoami', { workspace: 'COM' })).data.workspace.key).toBe('COM');

    // Not ticked: refused, nothing done.
    const no = await tool(c.token, 'log_work', { summary: 'Sneaky', workspace: 'SIDE' });
    expect(no.error).toBe(true);
    expect(no.text).toMatch(/does not reach workspace SIDE/);
    expect((await call('GET', '/api/tasks', side)).body.tasks ?? []).toHaveLength(0);

    // The workspace address works for a granted workspace too.
    expect((await tool(c.token, 'whoami', {}, '/mcp/COM')).data.workspace.key).toBe('COM');
    expect((await rpc(c.token, 'ping', {}, '/mcp/SIDE')).status).toBe(401);
  });

  it('removing the agent from one workspace leaves the others working', async () => {
    const c = await connect([com]);
    const agents = (await call('GET', '/api/members', com)).body.filter((m: any) => m.kind === 'ai');
    expect((await call('DELETE', `/api/members/${agents[0].id}`, com)).body.removed).toBe(true);
    expect((await tool(c.token, 'whoami', { workspace: 'COM' })).error).toBe(true);
    expect((await tool(c.token, 'whoami')).data.workspace.key).toBe('WS');
    expect((await tool(c.token, 'whoami')).data.workspaces).toBeUndefined(); // only one left
  });

  it('only takes people\'s own sign-ins, and /mcp/KEY makes that workspace the default', async () => {
    const bot = (await call('POST', '/api/members', com, { name: 'Bot', kind: 'ai' })).body.token;
    expect((await connect([bot])).status).toBe(401);
    expect((await connect(['kun_nope'])).status).toBe(401);
    expect((await connect([], { resource: 'https://kunla.test/mcp/COM' })).status).toBe(403);
    const c = await connect([com], { resource: 'https://kunla.test/mcp/COM' });
    expect((await tool(c.token, 'whoami', {}, '/mcp/COM')).data.workspaces[0]).toMatchObject({ key: 'COM', default: true });
    expect((await tool(c.token, 'whoami')).data.workspace.key).toBe('COM');
  });

  it('a one-workspace connector is unchanged', async () => {
    const c = await connect([]);
    expect(c.workspaces).toBe(1);
    const list = await rpc(c.token, 'tools/list');
    expect(list.body.result.tools.find((t: any) => t.name === 'log_work').inputSchema.properties.workspace).toBeUndefined();
    expect((await tool(c.token, 'whoami')).data.workspaces).toBeUndefined();
  });
});
