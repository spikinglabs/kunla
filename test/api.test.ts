import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

let env: any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const mcp = async (token: string, method: string, params?: unknown, id = 1) =>
  (await call('POST', '/mcp', token, { jsonrpc: '2.0', id, method, params })).body;
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const text = r.result.content[0].text;
  return { isError: r.result.isError, data: r.result.isError ? text : JSON.parse(text), reminder: r.result.content[1]?.text };
};

let human: string, ai: string;

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  const s = await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'mkt', project_name: 'Q1 campaign' });
  expect(s.status).toBe(200);
  human = s.body.token;
  const a = await call('POST', '/api/members', human, { name: "L's Claude Code", kind: 'ai', platform: 'claude-code' });
  ai = a.body.token;
});

describe('setup and auth', () => {
  it('runs setup only once', async () => {
    const again = await call('POST', '/api/setup', undefined, { name: 'X', project_key: 'ABC', project_name: 'x' });
    expect(again.status).toBe(409);
  });
  it('requires the setup token when one is configured', async () => {
    env = { DB: makeD1(), SETUP_TOKEN: 'secret' };
    expect((await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'x' })).status).toBe(403);
    expect((await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'x', setup_token: 'secret' })).status).toBe(200);
  });
  it('rejects requests without a valid token and points MCP clients at OAuth', async () => {
    expect((await call('GET', '/api/me')).status).toBe(401);
    const r = await call('POST', '/mcp', 'kun_nope', { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('oauth-protected-resource');
  });
  it('identifies the AI and its sponsor', async () => {
    const me = await call('GET', '/api/me', ai);
    expect(me.body).toMatchObject({ name: "L's Claude Code", kind: 'ai', sponsor: 'L', projects: [{ key: 'MKT' }] });
  });
});

describe('MCP', () => {
  it('initializes and lists tools', async () => {
    const init = await mcp(ai, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.instructions).toContain('Cite the task key');
    const list = await mcp(ai, 'tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['next_task', 'claim_task', 'log_work', 'submit_for_review', 'review_task', 'project_status']));
    const note = await call('POST', '/mcp', ai, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
  });
});

describe('the record of work', () => {
  it('runs a task from brief to approval, with a rule that reaches the next task', async () => {
    const t = await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Draft pricing page', brief: 'Three tiers', criteria: ['Mentions free tier'] });
    expect(t.body.key).toBe('MKT-1');
    expect(t.body.status).toBe('ready');

    const next = await tool(ai, 'next_task');
    expect(next.data.reason).toBe('open');
    expect(next.data.task.references.commit_trailer).toBe('Task: MKT-1 https://kunla.test/t/MKT-1');

    const claimed = await tool(ai, 'claim_task', { key: 'MKT-1' });
    expect(claimed.data.status).toBe('in_progress');
    expect(claimed.data.lease_expires_at).toBeTruthy();

    // A second member can't take it.
    const other = await call('POST', '/api/members', human, { name: 'Codex', kind: 'ai', platform: 'codex' });
    const steal = await tool(other.body.token, 'claim_task', { key: 'MKT-1' });
    expect(steal.isError).toBe(true);
    expect(steal.data).toContain("already claimed by L's Claude Code");

    const noLink = await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done', deliverables: [] });
    expect(noLink.isError).toBe(true);
    const badLink = await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'x', deliverables: [{ url: 'javascript:alert(1)' }] });
    expect(badLink.isError).toBe(true);
    const sub = await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Drafted', deliverables: [{ url: 'https://github.com/x/y/pull/1' }] });
    expect(sub.data.status).toBe('review');

    // The AI can't approve its own work; the person sees it in the decision inbox.
    expect((await tool(ai, 'review_task', { key: 'MKT-1', verdict: 'approved' })).isError).toBe(true);
    const inbox = await call('GET', '/api/inbox', human);
    expect(inbox.body.items[0]).toMatchObject({ kind: 'review', task: { key: 'MKT-1', summary: 'Drafted' } });

    const rev = await call('POST', '/api/tasks/MKT-1/review', human, {
      verdict: 'changes_requested', what_was_wrong: 'Prices in USD only', rule: 'Always show prices in EUR and USD',
    });
    expect(rev.body.status).toBe('in_progress');
    const back = await tool(ai, 'next_task');
    expect(back.data.reason).toBe('continue');
    expect(back.data.task.rules.map((r: any) => r.text)).toContain('Always show prices in EUR and USD');

    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Fixed currencies', deliverables: [{ url: 'https://github.com/x/y/pull/1' }] });
    const ok = await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect(ok.body.status).toBe('done');

    // The rule reaches a brand new task too.
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Landing page' });
    expect((await tool(ai, 'get_task', { key: 'MKT-2' })).data.rules[0].text).toBe('Always show prices in EUR and USD');

    const team = await call('GET', '/api/members', human);
    const cc = team.body.find((m: any) => m.name === "L's Claude Code");
    expect(cc).toMatchObject({ done: 1, reviewed: 1, first_pass_rate: 0 });
  });

  it('log_work records chat work with a new key, or adds to an existing task', async () => {
    const r = await tool(ai, 'log_work', { summary: 'Wrote the October newsletter draft', deliverables: [{ url: 'https://docs.example/1' }] });
    expect(r.data).toMatchObject({ key: 'MKT-1', status: 'done', origin: 'logged' });
    const r2 = await tool(ai, 'log_work', { summary: 'Draft for review', status: 'review', deliverables: [{ url: 'https://docs.example/2' }] });
    expect(r2.data.status).toBe('review');
    const r3 = await tool(ai, 'log_work', { task: 'MKT-1', summary: 'Fixed a typo' });
    expect(r3.data.history[0]).toMatchObject({ type: 'work_logged', note: 'Fixed a typo' });
  });

  it('expired leases return the task to Ready with a note', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Report' });
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await env.DB.prepare(`UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z'`).run();
    const t = await call('GET', '/api/tasks/MKT-1', human);
    expect(t.body.status).toBe('ready');
    expect(t.body.assignee).toBeNull();
    expect(t.body.history[0].type).toBe('lease_expired');
  });

  it('blocked questions and AI proposals reach the decision inbox', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Report' });
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'update_task', { key: 'MKT-1', blocked_question: 'Which quarter?' });
    const p = await tool(ai, 'create_task', { project: 'MKT', title: 'Follow-up: chart colours' });
    expect(p.data.status).toBe('inbox');
    const inbox = await call('GET', '/api/inbox', human);
    expect(inbox.body.items.map((i: any) => i.kind)).toEqual(['question', 'proposal']);
    const a = await call('POST', '/api/tasks/MKT-1/answer', human, { answer: 'Q3' });
    expect(a.body.status).toBe('in_progress');
    const tr = await call('POST', '/api/tasks/MKT-2/triage', human, { accept: true });
    expect(tr.body.status).toBe('ready');
  });

  it('project status reports progress and the agent-recorded share', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'A' });
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'log_work', { task: 'MKT-1', summary: 'Halfway' });
    const s = await tool(ai, 'project_status', { project: 'MKT' });
    expect(s.data.counts.in_progress).toBe(1);
    expect(s.data.who_is_on_what[0].member.name).toBe("L's Claude Code");
    expect(s.data.agent_recorded_share).toBeGreaterThan(50);
  });

  it('every MCP tool is also a REST call', async () => {
    const r = await call('POST', '/api/tools/whoami', ai, {});
    expect(r.body.result.name).toBe("L's Claude Code");
  });
});

describe('OAuth for chat connectors', () => {
  it('registers a client, approves, and exchanges the code with PKCE', async () => {
    const meta = await call('GET', '/.well-known/oauth-authorization-server');
    expect(meta.body.registration_endpoint).toBe('https://kunla.test/oauth/register');
    const reg = await call('POST', '/oauth/register', undefined, { client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    expect(reg.status).toBe(201);
    const verifier = 'v'.repeat(50);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const appr = await call('POST', '/oauth/approve', human, {
      client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 's1', code_challenge: challenge, code_challenge_method: 'S256',
    });
    expect(appr.body.member).toBe("L's claude.ai");
    const code = new URL(appr.body.redirect).searchParams.get('code')!;
    const res = await app.fetch(new Request('https://kunla.test/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }),
    }), env);
    const tok = await res.json<any>();
    expect(tok.access_token).toMatch(/^kun_/);
    const me = await call('GET', '/api/me', tok.access_token);
    expect(me.body).toMatchObject({ name: "L's claude.ai", kind: 'ai', sponsor: 'L' });
    // Codes are single use.
    const again = await app.fetch(new Request('https://kunla.test/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }),
    }), env);
    expect(again.status).toBe(400);
  });
});
