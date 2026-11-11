// KD-84: waiting on tasks and conditions, assumptions instead of waiting, the bottleneck and the relations graph.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { sign } from '../src/github';
import { linkApp, APP_SECRET } from './gh-app';

let env: any;
let human: string, a1: string, a2: string, a1Id: string;
let pending: Promise<unknown>[] = [];
let wakes: any[] = [];
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
const task = async (key: string, token = human) => (await call('GET', `/api/tasks/${key}`, token)).body;
const tool = async (token: string, name: string, args: unknown) => call('POST', `/api/tools/${name}`, token, args);
const create = async (title: string, extra: Record<string, unknown> = {}) => (await call('POST', '/api/tasks', human, { project: 'MKT', title, ...extra })).body;
const submitAndApprove = async (key: string, token = a2) => {
  await call('POST', `/api/tasks/${key}/claim`, token);
  await call('POST', `/api/tasks/${key}/submit`, token, { summary: 'done', deliverables: [{ url: 'https://example.com/doc' }] });
  return call('POST', `/api/tasks/${key}/review`, human, { verdict: 'approved' });
};

beforeEach(async () => {
  wakes = [];
  vi.stubGlobal('fetch', async (_url: string, init: any) => { wakes.push(JSON.parse(init.body)); return new Response('ok'); });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  const x = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai', platform: 'claude-code' });
  const y = await call('POST', '/api/members', human, { name: 'Writer', kind: 'ai', platform: 'claude' });
  a1 = x.body.token; a1Id = x.body.member.id; a2 = y.body.token;
  await call('PUT', `/api/members/${a1Id}/wake`, human, { url: 'https://hook.test/coder' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('waiting on another task', () => {
  it('agents skip a waiting task and cannot claim it; people can; it clears itself when the blocker is done', async () => {
    await create('Schema');                                   // MKT-1
    await create('API', { waiting_on: ['MKT-1'] });           // MKT-2
    const t = await task('MKT-2');
    expect(t.waiting).toBe(true);
    expect(t.waiting_on[0]).toMatchObject({ kind: 'task', label: 'MKT-1', task: { key: 'MKT-1' } });
    expect((await task('MKT-1')).blocks.map((b: any) => b.key)).toEqual(['MKT-2']);
    expect((await call('GET', '/api/tasks?project=MKT', human)).body.find((r: any) => r.key === 'MKT-2').waiting).toBe(1);

    // next_task offers the blocker, never the waiting task.
    expect((await call('GET', '/api/next', a1)).body.task.key).toBe('MKT-1');
    const refused = await call('POST', '/api/tasks/MKT-2/claim', a1);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('MKT-2 is waiting on MKT-1');
    expect(refused.body.error).toContain('call next_task');

    // Hand MKT-2 to Coder so we can see the wake when it clears.
    await call('PATCH', '/api/tasks/MKT-2', human, { assignee: 'Coder' });
    wakes = [];
    await submitAndApprove('MKT-1');
    const after = await task('MKT-2');
    expect(after.waiting).toBe(false);
    expect(after.history.find((e: any) => e.type === 'unblocked').note).toBe('MKT-1 is done, so MKT-2 can go ahead.');
    expect(wakes.find((w) => w.event === 'unblocked')).toMatchObject({ agent: 'Coder', task: { key: 'MKT-2' } });
    expect((await call('GET', '/api/next', a1)).body.task.key).toBe('MKT-2');
  });

  it('a person can start a waiting task anyway, and the record says so', async () => {
    await create('Schema');
    await create('API', { waiting_on: ['MKT-1'] });
    const r = await call('POST', '/api/tasks/MKT-2/claim', human);
    expect(r.status).toBe(200);
    expect((await task('MKT-2')).history.find((e: any) => e.type === 'claimed').note).toContain('Started before it stopped waiting');
  });

  it('refuses circles, waiting on itself, on a finished task, and a sub-task waiting on its parent', async () => {
    await create('A'); await create('B', { waiting_on: ['MKT-1'] }); await create('C', { waiting_on: ['MKT-2'] });
    const circle = await call('PATCH', '/api/tasks/MKT-1', human, { waiting_on: ['MKT-3'] });
    expect(circle.status).toBe(409);
    expect(circle.body.error).toContain('go in a circle');
    expect((await call('PATCH', '/api/tasks/MKT-1', human, { waiting_on: ['MKT-1'] })).status).toBe(400);
    await create('Sub', { parent: 'MKT-1' });                // MKT-4
    expect((await call('PATCH', '/api/tasks/MKT-4', human, { waiting_on: ['MKT-1'] })).body.error).toContain("can't wait on it");
    // A parent waiting on something its own sub-task waits for... MKT-2 waits on MKT-1, whose sub-task MKT-4 would wait on MKT-2: circle.
    expect((await call('PATCH', '/api/tasks/MKT-4', human, { waiting_on: ['MKT-2'] })).status).toBe(409);
    await call('PATCH', '/api/tasks/MKT-3', human, { status: 'declined' });
    expect((await call('PATCH', '/api/tasks/MKT-1', human, { waiting_on: ['MKT-3'] })).body.error).toContain('already declined');
  });

  it('a declined blocker clears the wait too, and the same wait is not added twice', async () => {
    await create('A'); await create('B', { waiting_on: ['MKT-1', 'mkt-1'] });
    expect((await task('MKT-2')).waiting_on).toHaveLength(1);
    await call('PATCH', '/api/tasks/MKT-1', human, { status: 'declined' });
    const b = await task('MKT-2');
    expect(b.waiting).toBe(false);
    expect(b.history.find((e: any) => e.type === 'unblocked').note).toContain('MKT-1 was declined');
  });
});

describe('waiting on a condition', () => {
  it('words: an agent ticks it when it happens; still waiting on the rest until then', async () => {
    await create('A');
    await create('Launch', { waiting_on: ['budget approved', 'MKT-1'] });
    let t = await task('MKT-2');
    expect(t.waiting_on.map((w: any) => w.label)).toEqual(['"budget approved"', 'MKT-1']);
    const met = await tool(a1, 'update_task', { key: 'MKT-2', waits_met: ['budget'], note: 'L approved it in the chat' });
    expect(met.status).toBe(200);
    t = await task('MKT-2');
    expect(t.waiting_on.map((w: any) => w.label)).toEqual(['MKT-1']);
    expect(t.history.find((e: any) => e.type === 'wait_met').note).toContain('Still waiting on MKT-1');
    expect((await tool(a1, 'update_task', { key: 'MKT-2', waits_met: ['nothing like this'] })).body.error).toContain("isn't waiting on");
    await tool(a1, 'update_task', { key: 'MKT-2', not_waiting_on: ['MKT-1'] });
    expect((await task('MKT-2')).waiting).toBe(false);
  });

  it('a PR link clears itself when GitHub says the PR merged', async () => {
    await linkApp(env.DB);
    await create('Docs', { waiting_on: ['https://github.com/acme/app/pull/9'] });
    expect((await task('MKT-1')).waiting_on[0]).toMatchObject({ kind: 'condition', condition: 'acme/app#9 merged', link: 'https://github.com/acme/app/pull/9' });
    const body = JSON.stringify({ action: 'closed', installation: { id: 42 }, pull_request: { number: 9, html_url: 'https://github.com/acme/app/pull/9', title: 'Unrelated title', body: '', merged: true, head: { ref: 'x' }, user: { login: 'octo' } } });
    const res = await app.fetch(new Request('https://kunla.test/hooks/github', { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1', 'x-hub-signature-256': await sign(APP_SECRET, body) } }), env, exec);
    expect((await res.json<any>()).waits_cleared).toBe(1);
    const t = await task('MKT-1');
    expect(t.waiting).toBe(false);
    expect(t.history.find((e: any) => e.type === 'unblocked').note).toContain('merged on GitHub');
  });
});

describe('assumptions instead of waiting', () => {
  it('lands in the inbox; a correction sends work in review back to the agent and wakes it', async () => {
    await create('Export');
    await call('POST', '/api/tasks/MKT-1/claim', a1);
    await tool(a1, 'log_work', { task: 'MKT-1', summary: 'Built the export', assumption: 'The export is CSV, not Excel' });
    await call('POST', '/api/tasks/MKT-1/submit', a1, { summary: 'done', deliverables: [{ url: 'https://example.com/pr' }] });
    const inbox = (await call('GET', '/api/inbox', human)).body;
    const item = inbox.items.find((i: any) => i.kind === 'assumption');
    expect(item).toMatchObject({ task: { key: 'MKT-1' }, assumption: { text: 'The export is CSV, not Excel', made_by: { name: 'Coder' } } });
    // Agents don't see or settle them.
    expect((await call('GET', '/api/inbox', a1)).body.items.some((i: any) => i.kind === 'assumption')).toBe(false);
    expect((await call('POST', `/api/assumptions/${item.assumption.id}`, a1, { confirm: true })).status).toBe(403);
    wakes = [];
    const r = await call('POST', `/api/assumptions/${item.assumption.id}`, human, { correct: 'Excel, the finance team uses pivot tables' });
    expect(r.body).toMatchObject({ state: 'corrected', status: 'in_progress' });
    const t = await task('MKT-1');
    expect(t.status).toBe('in_progress');
    expect(t.assignee.name).toBe('Coder');
    expect(t.assumptions[0]).toMatchObject({ state: 'corrected', answer: 'Excel, the finance team uses pivot tables', decided_by: { name: 'L' } });
    expect(wakes.find((w) => w.event === 'assumption_corrected')?.note).toContain('Actually: Excel');
    expect((await call('GET', '/api/inbox', human)).body.items.some((i: any) => i.kind === 'assumption')).toBe(false);
    expect((await call('POST', `/api/assumptions/${item.assumption.id}`, human, { confirm: true })).status).toBe(409);
  });

  it('confirming only adds to the record', async () => {
    await create('Post', { assumption: 'Audience is EU only' });
    const id = (await task('MKT-1')).assumptions[0].id;
    expect((await call('POST', `/api/assumptions/${id}`, human, { confirm: true })).body.state).toBe('confirmed');
    const t = await task('MKT-1');
    expect(t.status).toBe('ready');
    expect(t.history.some((e: any) => e.type === 'assumption_confirmed')).toBe(true);
  });
});

describe('the whole picture', () => {
  it('the Briefing names the bottleneck and the quiet promises', async () => {
    await create('Schema');                                    // MKT-1
    await create('API', { waiting_on: ['MKT-1'] });            // MKT-2
    await create('App', { waiting_on: ['MKT-2'] });            // MKT-3
    await create('Docs', { waiting_on: ['MKT-1'] });           // MKT-4
    await create('Ads', { waiting_on: ['budget approved'] });  // MKT-5
    // Three days ago: nobody has touched MKT-1 since, and nobody ticked the budget.
    const old = new Date(Date.now() - 3 * 86400_000).toISOString();
    await env.DB.prepare('UPDATE waits SET created_at = ?').bind(old).run();
    await env.DB.prepare(`UPDATE tasks SET updated_at = ? WHERE key = 'MKT-1'`).bind(old).run();
    await env.DB.prepare(`UPDATE events SET created_at = ? WHERE task_id = (SELECT id FROM tasks WHERE key = 'MKT-1')`).bind(old).run();
    const b = (await call('GET', '/api/briefing?hours=24', human)).body;
    expect(b.bottlenecks[0]).toMatchObject({ key: 'MKT-1', holds_up: 3, quiet: true });
    expect(b.bottlenecks[0].held.sort()).toEqual(['MKT-2', 'MKT-3', 'MKT-4']);
    const quiet = b.asks.filter((a: any) => a.kind === 'quiet_promise');
    expect(quiet.map((a: any) => a.line)).toEqual(expect.arrayContaining([
      expect.stringContaining('waited 3 days on MKT-1, but nobody has picked MKT-1 up'),
      expect.stringContaining('waited 3 days for "budget approved"'),
    ]));
  });

  it('relations: nodes and edges for the waits and sub-tasks, narrowed to one task or project', async () => {
    await create('Schema'); await create('API', { waiting_on: ['MKT-1', 'design signed off'] }); await create('Sub', { parent: 'MKT-2' });
    await create('Unrelated');
    const g = (await call('GET', '/api/relations', human)).body;
    expect(g.nodes.map((n: any) => n.id).filter((x: string) => x.startsWith('MKT')).sort()).toEqual(['MKT-1', 'MKT-2', 'MKT-3']);
    expect(g.nodes.find((n: any) => n.type === 'condition').title).toBe('design signed off');
    expect(g.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'MKT-1', to: 'MKT-2', kind: 'wait' }),
      expect.objectContaining({ from: 'MKT-3', to: 'MKT-2', kind: 'sub' }),
    ]));
    expect(g.nodes.find((n: any) => n.id === 'MKT-2').waiting).toBe(2);
    const focus = (await call('GET', '/api/relations?focus=MKT-3', human)).body;
    expect(focus.nodes).toHaveLength(4);
    const mcp = await tool(a1, 'relations', { task: 'MKT-1' });
    expect(mcp.body.result.link).toContain('#/map/relations');
  });

  it('the Work map lists tasks that wait', async () => {
    await create('Schema'); await create('API', { waiting_on: ['MKT-1'] });
    const m = (await call('GET', '/api/map?days=1', human)).body;
    expect(m.waits.find((w: any) => w.key === 'MKT-2')).toMatchObject({ who: 'Anyone', on: 'MKT-1' });
  });
});
