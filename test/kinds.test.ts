import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { inferKind, linkType, normalizeKind, parseKinds } from '../src/kinds';

// KD-37: Kunla records all kinds of work, not only code.
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

let human: string, ai: string;
const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;

beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai' })).body.token;
});

describe('kinds of work', () => {
  it('guesses the kind from words and links, and labels links', () => {
    expect(inferKind('Read the Toolformer paper')).toBe('learning');
    expect(inferKind('Discuss pricing with Jon')).toBe('discussion');
    expect(inferKind('Market research: AI task queues')).toBe('research');
    expect(inferKind('Draft launch blog article')).toBe('outreach');
    expect(inferKind('Prospect list for DACH sales')).toBe('outreach');
    expect(inferKind('Weekly KPI dashboard')).toBe('research');
    expect(inferKind('Plan the offsite')).toBe('operations');
    expect(inferKind('Write an article on hybrid teams')).toBe('writing');
    expect(inferKind('Learn how Durable Objects work')).toBe('learning');
    expect(inferKind('Fix webhook retries')).toBe('code');
    expect(inferKind('Something', '', ['https://github.com/a/b/pull/3'])).toBe('code');
    expect(inferKind('Something', '', ['https://arxiv.org/abs/2302.04761'])).toBe('learning');
    expect(inferKind('Water the plants')).toBe('other');
    expect(linkType('https://github.com/a/b/pull/3')).toBe('pr');
    expect(linkType('https://docs.google.com/spreadsheets/d/x')).toBe('sheet');
    expect(linkType('https://claude.ai/artifact/abc')).toBe('doc');
    expect(linkType('https://claude.ai/chat/abc')).toBe('chat');
    expect(linkType('https://www.linkedin.com/posts/x')).toBe('post');
    expect(linkType('https://example.com/report.pdf')).toBe('file');
    expect(normalizeKind('Article')).toBe('writing');
    expect(normalizeKind('reading')).toBe('learning');
    expect(normalizeKind('marketing')).toBe('outreach');
    expect(normalizeKind('banana')).toBeNull();
  });

  it('stores the kind given, guesses it otherwise, and lets people change it', async () => {
    const a = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Competitor scan', kind: 'research' })).body;
    expect(a.kind).toBe('research');
    const b = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Read the Toolformer paper' })).body;
    const t = await task(b.key);
    expect(t.kind).toBe('learning');
    expect(t.how_to_finish.hand_in).toMatch(/Notes/);
    expect(t.kinds_here.map((k: any) => k.key)).toContain('outreach');
    expect((await call('POST', '/api/tasks', human, { title: 'x', kind: 'banana' })).status).toBe(400);
    await call('PATCH', `/api/tasks/${b.key}`, human, { kind: 'learning' });
    expect((await task(b.key)).kind).toBe('learning');
  });

  it('a sub-task with no clear kind takes its parent’s', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Q1 campaign', kind: 'marketing' }); // MKT-1, marketing is outreach
    const s = (await call('POST', '/api/tasks', human, { parent: 'MKT-1', title: 'Pick the colours' })).body;
    expect(s.kind).toBe('outreach');
  });

  it('logs a discussion from a chat with notes and no link, straight to done', async () => {
    const r = await tool(ai, 'log_work', {
      summary: 'Decided to target mixed-vendor teams first.', title: 'Positioning discussion', kind: 'discussion',
      notes: '- Target mixed-vendor teams\n- Next: rewrite the landing page', notes_title: 'Decisions', session: 'https://claude.ai/chat/abc',
    });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ status: 'done', kind: 'discussion', origin: 'logged' });
    expect(r.data.notes[0]).toMatchObject({ title: 'Decisions', author: "L's Claude" });
    expect(r.data.notes[0].body).toContain('mixed-vendor');
  });

  it('sends research for review with notes instead of a link, and shows them in the inbox', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Size the market' }); // MKT-1
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    const none = await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Done' });
    expect(none.isError).toBe(true);
    expect(none.data).toMatch(/notes/);
    const ok = await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'About 40k teams.', notes: 'Answer: ~40k teams.\nSources: https://example.com/a' });
    expect(ok.isError).toBeFalsy();
    expect(ok.data.status).toBe('review');
    const inbox = (await call('GET', '/api/inbox', human)).body;
    const item = inbox.items.find((i: any) => i.task.key === 'MKT-1');
    expect(item.task.kind).toBe('research');
    expect(item.task.notes[0].body).toContain('40k');
    // Approving work without a PR just marks it done.
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect((await task('MKT-1')).status).toBe('done');
  });

  it('notes logged earlier count when the work is sent for review', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Read the RLHF survey' }); // MKT-1
    await tool(ai, 'claim_task', { key: 'MKT-1' });
    await tool(ai, 'log_work', { task: 'MKT-1', summary: 'Read sections 1-3', notes: 'Claims...' });
    const r = await tool(ai, 'submit_for_review', { key: 'MKT-1', summary: 'Read it', deliverables: [] });
    expect(r.isError).toBeFalsy();
  });

  it('labels deliverable links by type and filters tasks by kind', async () => {
    const t = (await tool(ai, 'log_work', { summary: 'Wrote the post', kind: 'writing', deliverables: [{ url: 'https://docs.google.com/document/d/x' }, { url: 'https://arxiv.org/abs/1' }] })).data;
    expect(t.deliverables.map((d: any) => d.type)).toEqual(['doc', 'paper']);
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Fix the webhook' });
    const writing = (await call('GET', '/api/tasks?kind=writing', human)).body;
    expect(writing.map((x: any) => x.key)).toEqual([t.key]);
    const listed = await tool(ai, 'list_tasks', { kind: 'code' });
    expect(listed.data.map((x: any) => x.title)).toEqual(['Fix the webhook']);
  });

  it('guesses a kind for tasks stored before kinds existed', async () => {
    env = { DB: makeD1(':memory:', { before: '0013' }), LEASE_MINUTES: '30' };
    human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO tasks (id, project_id, key, title, status, space_id, created_at, updated_at)
      SELECT 'old', id, 'MKT-9', 'Read the scaling laws paper', 'ready', space_id, ?, ? FROM projects WHERE key = 'MKT'`).bind(now, now).run();
    env.DB.migrate();
    expect((await task('MKT-9')).kind).toBe('learning');
    expect((await call('GET', '/api/tasks?kind=learning', human)).body.map((x: any) => x.key)).toEqual(['MKT-9']);
  });
});

describe('kinds per workspace and project', () => {
  it('reads a kinds setting from lines, keeping built-ins and adding the team’s own', () => {
    const d = parseKinds(['Research', 'Customer calls: notes with the next step and its date', '- Learning'])!;
    expect(d.map((x) => x.key)).toEqual(['research', 'customer-calls', 'learning']);
    expect(d[0].builtin).toBe(true);
    expect(d[1]).toMatchObject({ label: 'Customer calls', hand_in: 'notes with the next step and its date', builtin: false });
    expect(parseKinds(null)).toBeNull();
    expect(() => parseKinds('not json and ' + 'x'.repeat(40))).toThrow();
  });

  it('a project overrides the workspace, which overrides the defaults', async () => {
    await call('POST', '/api/projects', human, { key: 'SALES', name: 'Sales' });
    // Workspace: a lean list.
    let r = await call('PATCH', '/api/projects/WS', human, { kinds: ['Writing', 'Research', 'Discussion'] });
    expect(r.status).toBe(200);
    // Project: its own list, including two kinds of its own.
    r = await call('PATCH', '/api/projects/SALES', human, { kinds: ['Prospecting: a list of accounts with why each fits', 'Customer calls: notes with the next step', 'Discussion'] });
    expect(r.status).toBe(200);
    const k = (await call('GET', '/api/kinds', human)).body;
    expect(k.workspace.kinds.map((x: any) => x.key)).toEqual(['writing', 'research', 'discussion', 'other']);
    const sales = k.projects.find((p: any) => p.key === 'SALES');
    expect(sales.kinds.map((x: any) => x.key)).toEqual(['prospecting', 'customer-calls', 'discussion', 'other']);
    expect(k.projects.find((p: any) => p.key === 'MKT').own).toBeNull(); // inherits the workspace

    // Guesses stay inside the list that applies.
    const a = (await call('POST', '/api/tasks', human, { project: 'SALES', title: 'Customer call with Acme' })).body;
    expect(a.kind).toBe('customer-calls');
    const b = (await call('POST', '/api/tasks', human, { project: 'SALES', title: 'Find 20 fintech prospects' })).body;
    expect(b.kind).toBe('prospecting');
    const c2 = (await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Fix webhook retries' })).body;
    expect(c2.kind).toBe('other'); // no Code in this workspace's list
    // A kind that isn't in the list is refused, with the list in the message.
    const bad = await call('POST', '/api/tasks', human, { project: 'SALES', title: 'x', kind: 'code' });
    expect(bad.status).toBe(400);
    expect(bad.body.error ?? JSON.stringify(bad.body)).toMatch(/prospecting/);
    // get_task tells agents which kinds apply and what to hand in.
    const t = (await tool(ai, 'get_task', { key: a.key })).data;
    expect(t.kinds_here.map((x: any) => x.label)).toEqual(['Prospecting', 'Customer calls', 'Discussion', 'Other']);
    expect(t.how_to_finish.hand_in).toBe('notes with the next step');
    expect(t.kind_label).toBe('Customer calls');
    // whoami lists them too.
    const me = (await tool(ai, 'whoami')).data;
    expect(me.kinds_of_work.projects.SALES).toContain('prospecting');
    // Filter by a team's own kind.
    expect((await call('GET', '/api/tasks?kind=customer-calls', human)).body.map((x: any) => x.key)).toEqual([a.key]);
    // Back to inheriting.
    await call('PATCH', '/api/projects/SALES', human, { kinds: null });
    expect((await call('GET', '/api/kinds', human)).body.projects.find((p: any) => p.key === 'SALES').own).toBeNull();
    // Agents can't change the list.
    expect((await call('PATCH', '/api/projects/SALES', ai, { kinds: ['Code'] })).status).toBe(403);
  });
});
