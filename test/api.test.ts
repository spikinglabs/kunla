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
    expect(r.data).toMatchObject({ key: 'WS-1', status: 'done', origin: 'logged', project: null });
    const r2 = await tool(ai, 'log_work', { summary: 'Draft for review', project: 'MKT', status: 'review', deliverables: [{ url: 'https://docs.example/2' }] });
    expect(r2.data).toMatchObject({ key: 'MKT-1', status: 'review' });
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

  it('a person can send a Ready task back to Proposed (KD-57)', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Not ready after all' });
    const r = await call('PATCH', '/api/tasks/MKT-1', human, { status: 'inbox' });
    expect(r.body.status).toBe('inbox');
    const inbox = await call('GET', '/api/inbox', human);
    expect(inbox.body.items.map((i: any) => i.kind)).toEqual(['proposal']);
    const next = await tool(ai, 'next_task', {});
    expect(next.data?.task?.key).not.toBe('MKT-1');
    const tr = await call('POST', '/api/tasks/MKT-1/triage', human, { accept: true });
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

describe('hierarchy and steering', () => {
  it('allows workspace-level tasks and keeps sub-tasks one level under a task', async () => {
    const ws = await call('POST', '/api/tasks', human, { title: 'Renew the domain' });
    expect(ws.body.key).toBe('WS-1');
    const parent = await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Launch page' });
    const sub = await tool(ai, 'create_task', { parent: 'MKT-1', title: 'Hero copy', status: 'ready' });
    expect(sub.data.key).toBe('MKT-2');
    const deeper = await tool(ai, 'create_task', { parent: 'MKT-2', title: 'Too deep' });
    expect(deeper.isError).toBe(true);
    expect((await call('POST', '/api/tasks', human, { parent: 'MKT-1', project: 'WS', title: 'Wrong project' })).status).toBe(400);
    // The parent is not offered while it has open sub-tasks; the sub-task is.
    expect((await tool(ai, 'next_task', { project: 'MKT' })).data.task.key).toBe('MKT-2');
    // When the last sub-task is approved, the parent finishes on its own.
    await tool(ai, 'claim_task', { key: 'MKT-2' });
    await tool(ai, 'submit_for_review', { key: 'MKT-2', summary: 'Done', deliverables: [{ url: 'https://docs.example/hero' }] });
    await call('POST', '/api/tasks/MKT-2/review', human, { verdict: 'approved' });
    const p = await call('GET', '/api/tasks/MKT-1', human);
    expect(p.body.status).toBe('done');
    expect(p.body.history[0]).toMatchObject({ type: 'rolled_up', actor: null });
    expect(p.body.subtasks).toHaveLength(1);
    const list = await call('GET', '/api/tasks?project=MKT', human);
    expect(list.body.find((t: any) => t.key === 'MKT-1')).toMatchObject({ project: 'MKT', subtasks: { total: 1, done: 1 } });
    expect(list.body.find((t: any) => t.key === 'MKT-2')).toMatchObject({ parent: 'MKT-1' });
    expect(parent.status).toBe(200);
  });

  it('offers focused projects first and keeps agents in their lane', async () => {
    await call('POST', '/api/projects', human, { key: 'DATA', name: 'Sales data' });
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Newsletter' });
    await call('POST', '/api/tasks', human, { project: 'DATA', title: 'Pipeline summary' });
    expect((await tool(ai, 'next_task')).data.task.key).toBe('MKT-1');
    await call('PATCH', '/api/projects/DATA', human, { focus: true, ends_at: '2026-12-01' });
    const n = await tool(ai, 'next_task');
    expect(n.data.task.key).toBe('DATA-1');
    expect(n.data.focus).toEqual(['DATA Sales data']);
    const members = await call('GET', '/api/members', human);
    const id = members.body.find((m: any) => m.kind === 'ai').id;
    expect((await call('PATCH', `/api/members/${id}`, human, { scope: ['MKT'] })).body.scope).toEqual(['MKT']);
    expect((await tool(ai, 'next_task')).data.task.key).toBe('MKT-1');
    expect((await call('PATCH', `/api/members/${id}`, ai, { scope: [] })).status).toBe(403);
  });

  it('stops agents filing the same work twice and tidies stale proposals', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Q1 newsletter draft for DACH' });
    const dup = await tool(ai, 'create_task', { project: 'MKT', title: 'Draft the Q1 newsletter for DACH' });
    expect(dup.data).toMatchObject({ created: false, possible_duplicates: [{ key: 'MKT-1' }] });
    const forced = await tool(ai, 'create_task', { project: 'MKT', title: 'Draft the Q1 newsletter for DACH', force: true });
    expect(forced.data).toMatchObject({ key: 'MKT-2', status: 'inbox' });
    await env.DB.prepare(`UPDATE tasks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE key = 'MKT-2'`).run();
    const inbox = await call('GET', '/api/inbox', human);
    expect(inbox.body.items.some((i: any) => i.task.key === 'MKT-2')).toBe(false);
    const t2 = (await call('GET', '/api/tasks/MKT-2', human)).body;
    expect(t2.status).toBe('declined');
    expect(t2.history[0]).toMatchObject({ type: 'tidied', actor: null });
  });
});

describe('later (parked tasks)', () => {
  it('parks a review out of the inbox and away from agents, and brings it back', async () => {
    const t = await tool(ai, 'log_work', { summary: 'Draft ready', status: 'review', deliverables: [{ url: 'https://x.test/d' }] });
    const key = t.data.key;
    expect((await call('GET', '/api/inbox', human)).body.items.some((i: any) => i.task.key === key)).toBe(true);
    const p = await call('POST', `/api/tasks/${key}/park`, human, {});
    expect(p.body).toMatchObject({ status: 'parked', returns_to: 'review', snoozed_until: null });
    expect((await call('GET', '/api/inbox', human)).body.items.some((i: any) => i.task.key === key)).toBe(false);
    expect((await call('POST', `/api/tasks/${key}/claim`, ai)).body.error).toContain('parked');
    expect((await call('GET', `/api/tasks/${key}`, ai)).body.status).toBe('parked');
    const u = await call('POST', `/api/tasks/${key}/unpark`, human);
    expect(u.body.status).toBe('review');
    expect((await call('GET', '/api/inbox', human)).body.items.some((i: any) => i.task.key === key)).toBe(true);
  });
  it('snoozed tasks come back by themselves, and in-progress work returns as Ready', async () => {
    const t = await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Partner list' });
    await call('POST', `/api/tasks/${t.body.key}/claim`, ai);
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect((await call('POST', `/api/tasks/${t.body.key}/park`, human, { until: soon })).body.returns_to).toBe('ready');
    expect((await call('POST', `/api/tasks/${t.body.key}/park`, human, { until: '2000-01-01' })).status).toBe(400);
    expect((await tool(ai, 'next_task')).data.task?.key).not.toBe(t.body.key);
    await env.DB.prepare(`UPDATE tasks SET snoozed_until = ? WHERE key = ?`).bind(new Date(Date.now() - 1000).toISOString(), t.body.key).run();
    const back = await call('GET', `/api/tasks/${t.body.key}`, human);
    expect(back.body.status).toBe('ready');
    expect(back.body.history.some((e: any) => e.type === 'unparked')).toBe(true);
  });
  it('agents can park via update_task when a person asks', async () => {
    const t = await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Someday idea' });
    const r = await tool(ai, 'update_task', { key: t.body.key, status: 'parked', note: 'L said later' });
    expect(r.data.status).toBe('parked');
  });
});

describe('parents and sub-tasks', () => {
  it('records approval of a parent but finishes it only when its last sub-task does', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Webhooks' });                 // MKT-1
    await call('POST', '/api/tasks', human, { parent: 'MKT-1', title: 'Endpoint' });                // MKT-2
    await call('POST', '/api/tasks', human, { parent: 'MKT-1', title: 'Connect the repo' });        // MKT-3
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Built it', deliverables: [{ url: 'https://github.com/a/b/pull/1' }] });
    const r = await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect(r.body).toMatchObject({ status: 'in_progress', lease_expires_at: null });
    const t = await call('GET', '/api/tasks/MKT-1', human);
    expect(t.body.history[0]).toMatchObject({ type: 'approved' });
    expect(t.body.history[0].note).toContain('finishes when MKT-2, MKT-3 are done');
    // The agent is not sent back to a parent that only waits on sub-tasks.
    const next = await tool(ai, 'next_task');
    expect(next.data.task?.key).not.toBe('MKT-1');
    // Moving it to Done by hand says what is still open.
    const done = await call('PATCH', '/api/tasks/MKT-1', human, { status: 'done' });
    expect(done.status).toBe(409);
    expect(done.body.error).toContain('MKT-2, MKT-3');
    await call('PATCH', '/api/tasks/MKT-2', human, { status: 'done' });
    await call('PATCH', '/api/tasks/MKT-3', human, { status: 'declined' });
    expect((await call('GET', '/api/tasks/MKT-1', human)).body.status).toBe('done');
  });
});

describe('session links', () => {
  it('remembers the chats and sessions that worked on a task, once each', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' });
    const chat = 'https://claude.ai/code/session_01abc';
    await tool(ai, 'claim_task', { key: 'MKT-1', session: chat });
    await tool(ai, 'log_work', { task: 'MKT-1', summary: 'Drafted', session: chat });
    await tool(ai, 'update_task', { key: 'MKT-1', note: 'local run', session: 'claude --resume 1234' });
    const t = await call('GET', '/api/tasks/MKT-1', human);
    expect(t.body.sessions).toEqual([
      expect.objectContaining({ ref: chat, url: chat, member: "L's Claude Code", member_kind: 'ai' }),
      expect.objectContaining({ ref: 'claude --resume 1234', url: null }),
    ]);
    const logged = await tool(ai, 'log_work', { summary: 'Chat-only analysis', session: 'https://claude.ai/chat/xyz' });
    expect(logged.data.sessions[0].url).toBe('https://claude.ai/chat/xyz');
  });
});

describe('managing connections', () => {
  it('reuses an agent connected twice under the same name', async () => {
    const again = await call('POST', '/api/members', human, { name: "l's claude code", kind: 'ai', platform: 'claude-code' });
    expect(again.body.reconnected).toBe(true);
    expect((await call('GET', '/api/members', human)).body.filter((m: any) => m.kind === 'ai')).toHaveLength(1);
    expect((await call('GET', '/api/me', ai)).status).toBe(200); // the first token keeps working
    expect((await call('GET', '/api/me', again.body.token)).body.name).toBe("L's Claude Code");
  });
  it('renames, rotates the token, and removes an agent while keeping its record', async () => {
    const id = (await call('GET', '/api/me', ai)).body.id;
    const r = await call('PATCH', `/api/members/${id}`, human, { name: 'Laptop Claude Code' });
    expect(r.body.name).toBe('Laptop Claude Code');
    const t = await tool(ai, 'log_work', { summary: 'Drafted the brief' });
    const rot = await call('POST', `/api/members/${id}/token`, human);
    expect((await call('GET', '/api/me', ai)).status).toBe(401);
    expect((await call('GET', '/api/me', rot.body.token)).status).toBe(200);
    const other = await call('POST', '/api/members', human, { name: 'Codex', kind: 'ai', platform: 'codex' });
    expect((await call('DELETE', `/api/members/${id}`, other.body.token)).status).toBe(403);
    expect((await call('DELETE', `/api/members/${id}`, human)).body.removed).toBe(true);
    expect((await call('GET', '/api/me', rot.body.token)).status).toBe(401);
    expect((await call('GET', '/api/members', human)).body.map((m: any) => m.name)).not.toContain('Laptop Claude Code');
    const task = await call('GET', `/api/tasks/${t.data.key}`, human);
    expect(task.status).toBe(200);
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

describe('several workspaces in one Kunla', () => {
  const newSpace = async (name: string, key?: string) => {
    const r = await call('POST', '/api/workspaces', human, { name, ...(key ? { key } : {}) });
    expect(r.status).toBe(200);
    return r.body as { workspace: { id: string; key: string; name: string }; token: string };
  };

  it('creates a workspace from just a name, with its creator as admin', async () => {
    const ws = await newSpace('Community');
    expect(ws.workspace).toMatchObject({ key: 'COM', name: 'Community' });
    expect(ws.token).toMatch(/^kun_/);
    const me = await call('GET', '/api/me', ws.token);
    expect(me.body).toMatchObject({ name: 'L', kind: 'human', roles: ['admin'], workspace: { key: 'COM', name: 'Community' }, projects: [] });
    // Keys never repeat on one Kunla, so a second "Community" gets another one.
    expect((await newSpace('Community')).workspace.key).toBe('COM2');
    expect((await newSpace('My startup')).workspace.key).toBe('MS');
    expect((await call('POST', '/api/workspaces', human, { name: 'X', key: 'MKT' })).status).toBe(409);
  });

  it('only people who are admins can create workspaces', async () => {
    expect((await call('POST', '/api/workspaces', ai, { name: 'Sneaky' })).status).toBe(403);
    const bob = await call('POST', '/api/members', human, { name: 'Bob', kind: 'human' });
    expect((await call('POST', '/api/workspaces', bob.body.token, { name: 'Bob space' })).status).toBe(403);
  });

  it('keeps everything in one workspace invisible and untouchable from another', async () => {
    // The first workspace has a project, a task, an agent, a rule and a proposal.
    const t1 = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page', assignee: "L's Claude Code" })).body;
    await tool(ai, 'create_task', { title: 'Idea from the agent' });
    const ws = await newSpace('Community', 'COM');
    const other = ws.token;

    // Nothing from the first workspace shows up in the second.
    expect((await call('GET', '/api/tasks', other)).body).toEqual([]);
    expect((await call('GET', '/api/projects', other)).body).toEqual([]);
    expect((await call('GET', '/api/members', other)).body.map((m: any) => m.name)).toEqual(['L']);
    expect((await call('GET', '/api/inbox', other)).body.count).toBe(0);
    expect((await call('GET', '/api/pulse', other)).body.map((m: any) => m.name)).toEqual(['L']);
    expect((await call('GET', '/api/map', other)).body.lanes.map((m: any) => m.name)).toEqual(['L']);
    expect((await call('GET', '/api/briefing', other)).body.members).toEqual([]);
    expect((await call('GET', '/api/progress', other)).body.map((p: any) => p.key)).toEqual(['COM']);
    expect((await call('GET', '/api/rules', other)).body).toEqual([]);
    expect((await call('GET', '/api/status', other)).body.counts.ready).toBe(0);
    expect((await call('GET', `/api/similar?title=${encodeURIComponent('Pricing page')}`, other)).body).toEqual([]);

    // Keys, names and ids from the first workspace don't resolve in the second.
    expect((await call('GET', `/api/tasks/${t1.key}`, other)).status).toBe(404);
    expect((await call('PATCH', `/api/tasks/${t1.key}`, other, { title: 'hijacked' })).status).toBe(404);
    expect((await call('POST', `/api/tasks/${t1.key}/claim`, other)).status).toBe(404);
    expect((await call('GET', '/api/projects/MKT', other)).status).toBe(404);
    expect((await call('POST', '/api/tasks', other, { project: 'MKT', title: 'x' })).status).toBe(404);
    expect((await call('POST', '/api/tasks', other, { title: 'x', assignee: "L's Claude Code" })).status).toBe(404);
    const aiId = (await call('GET', '/api/members', human)).body.find((m: any) => m.kind === 'ai').id;
    expect((await call('POST', `/api/members/${aiId}/token`, other)).status).toBe(404);
    expect((await call('DELETE', `/api/members/${aiId}`, other)).status).toBe(404);
    await tool(ai, 'claim_task', { key: t1.key });
    await tool(ai, 'submit_for_review', { key: t1.key, summary: 'Done', deliverables: [{ url: 'https://example.com/pr/1' }] });
    await call('POST', `/api/tasks/${t1.key}/review`, human, { verdict: 'approved', rule: 'Always show prices with VAT' });
    const rule = (await call('GET', '/api/rules', human)).body[0];
    expect(rule.text).toBe('Always show prices with VAT');
    expect((await call('PATCH', `/api/rules/${rule.id}`, other, { active: false })).status).toBe(404);

    // Work in the second workspace gets its own keys and stays there.
    const t2 = (await call('POST', '/api/tasks', other, { title: 'Meetup venue' })).body;
    expect(t2.key).toBe('COM-1');
    expect((await call('GET', `/api/tasks/${t2.key}`, human)).status).toBe(404);
    expect((await call('GET', '/api/tasks', human)).body.map((t: any) => t.key)).not.toContain('COM-1');
    const before = (await call('GET', '/api/changes', human)).body.version;
    await call('POST', `/api/tasks/${t2.key}/comment`, other, { text: 'Booked' });
    expect((await call('GET', '/api/changes', human)).body.version).toBe(before);

    // The same agent name can exist in both, as two separate members with their own tokens.
    const a2 = await call('POST', '/api/members', other, { name: "L's Claude Code", kind: 'ai', platform: 'claude-code' });
    expect(a2.status).toBe(200);
    const next = await tool(a2.body.token, 'next_task');
    expect(next.data?.task?.key ?? null).toBe('COM-1');
    expect((await tool(ai, 'get_task', { key: 'COM-1' })).isError).toBe(true);

    // Existing tokens keep working in the first workspace.
    expect((await call('GET', '/api/me', ai)).body.workspace.key).not.toBe('COM');
  });
});

describe('upgrading a Kunla made before there were several workspaces', () => {
  it('keeps old tokens, agents and tasks working in the first workspace', async () => {
    // A database as it was before migration 0009, set up and used by the previous release.
    const db: any = makeD1(':memory:', { before: '0009' });
    env = { DB: db, LEASE_MINUTES: '30' };
    const t = new Date().toISOString();
    const { sha256 } = await import('../src/core');
    await db.prepare(`UPDATE projects SET key = 'SL', name = 'SL' WHERE kind = 'workspace'`).run();
    await db.prepare(`INSERT INTO members (id, name, kind, roles, created_at) VALUES ('h1','L','human','["admin"]',?)`).bind(t).run();
    await db.prepare(`INSERT INTO members (id, name, kind, platform, sponsor_id, roles, created_at) VALUES ('a1','L''s claude.ai','ai','claude-ai','h1','[]',?)`).bind(t).run();
    await db.prepare(`INSERT INTO tokens (id, member_id, label, token_hash, created_at) VALUES ('k1','h1','web',?,?)`).bind(await sha256('kun_old_human'), t).run();
    await db.prepare(`INSERT INTO tokens (id, member_id, label, token_hash, created_at) VALUES ('k2','a1','oauth:x',?,?)`).bind(await sha256('kun_old_connector'), t).run();
    await db.prepare(`INSERT INTO projects (id, key, name, created_at) VALUES ('p1','KD','Kunla Dev',?)`).bind(t).run();
    await db.prepare(`INSERT INTO tasks (id, project_id, key, title, status, created_by, created_at, updated_at) VALUES ('t1','p1','KD-1','Webhooks','ready','h1',?,?)`).bind(t, t).run();
    await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('github_webhook_secret','s3cret',?)`).bind(t).run();

    db.migrate();

    const me = await call('GET', '/api/me', 'kun_old_connector');
    expect(me.body).toMatchObject({ name: "L's claude.ai", sponsor: 'L', workspace: { key: 'SL' }, projects: [{ key: 'KD' }] });
    expect((await tool('kun_old_connector', 'get_task', { key: 'KD-1' })).data.key).toBe('KD-1');
    expect((await call('GET', '/api/tasks', 'kun_old_human')).body.map((x: any) => x.key)).toEqual(['KD-1']);
    // Hand-made webhook secrets are forgotten: GitHub connects through the Kunla app now.
    expect(await db.prepare(`SELECT 1 FROM settings WHERE key = 'github_webhook_secret'`).first()).toBeNull();
    // A new workspace made after the upgrade is separate from the old data.
    const ws = await call('POST', '/api/workspaces', 'kun_old_human', { name: 'Community' });
    expect((await call('GET', '/api/tasks', ws.body.token)).body).toEqual([]);
  });
});

describe('one MCP address per workspace', () => {
  it('serves /mcp/KEY for one workspace only and signs claude.ai in to that workspace', async () => {
    const ws = (await call('POST', '/api/workspaces', human, { name: 'Community', key: 'COM' })).body;
    const sl = (await call('GET', '/api/me', human)).body.workspace.key;
    const ping = (path: string, token?: string) => call('POST', path, token, { jsonrpc: '2.0', id: 1, method: 'ping' });

    // Plain /mcp keeps working with any token; /mcp/KEY only with that workspace's tokens.
    expect((await ping('/mcp', ai)).status).toBe(200);
    expect((await ping(`/mcp/${sl}`, ai)).status).toBe(200);
    expect((await ping('/mcp/com', ws.token)).status).toBe(200);
    const wrong = await ping('/mcp/COM', ai);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp/COM');
    expect((await ping('/mcp/NOPE', ai)).status).toBe(404);

    // OAuth discovery for the workspace address names it as the resource.
    const pr = await call('GET', '/.well-known/oauth-protected-resource/mcp/COM');
    expect(pr.body).toMatchObject({ resource: 'https://kunla.test/mcp/COM', authorization_servers: ['https://kunla.test'] });
    expect((await call('GET', '/.well-known/oauth-authorization-server/mcp/COM')).body.token_endpoint).toBe('https://kunla.test/oauth/token');

    // Approving with a token from another workspace is refused; with the right one the connector joins Community.
    const reg = await call('POST', '/oauth/register', undefined, { client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const approve = (token: string) => call('POST', '/oauth/approve', token, {
      client_id: reg.body.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
      resource: 'https://kunla.test/mcp/COM',
    });
    const refused = await approve(human);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Community');
    const ok = await approve(ws.token);
    expect(ok.status).toBe(200);
    const members = (await call('GET', '/api/members', ws.token)).body.map((m: any) => m.name);
    expect(members).toContain("L's claude.ai");
    expect((await call('GET', '/api/members', human)).body.map((m: any) => m.name)).not.toContain("L's claude.ai");
  });
});

describe('work map grouping', () => {
  it('tags each bar with its project and kind of work so lanes can be grouped by them', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Write the launch post', kind: 'writing' });
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    const m = (await call('GET', '/api/map?days=1', human)).body;
    const seg = m.lanes.find((l: any) => l.name === "L's Claude Code").segments[0];
    expect(seg).toMatchObject({ key: 'MKT-1', project: 'MKT', work: 'writing', kind: 'work' });
    expect(m.projects.map((p: any) => p.key)).toContain('MKT');
  });
});
