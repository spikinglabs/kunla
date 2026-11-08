import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

// KD-16: agents propose projects; a person's accept creates them.
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
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'mkt', project_name: 'Q1 campaign' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai', platform: 'claude-ai' })).body.token;
});

describe('agents propose projects', () => {
  it('lands an agent proposal in the inbox and creates the project when a person accepts', async () => {
    const r = await tool(ai, 'create_project', { key: 'dach', name: 'DACH launch', why: 'Germany, Austria and Switzerland launch work keeps piling up in MKT.', playbook: 'German first.' });
    expect(r.data.created).toBe(false);
    const key = r.data.proposal.key;
    expect(r.data.proposal).toMatchObject({ status: 'inbox', title: 'New project: DACH launch (DACH)' });
    expect((await call('GET', '/api/projects', human)).body.map((p: any) => p.key)).not.toContain('DACH');
    const inbox = await call('GET', '/api/inbox', human);
    expect(inbox.body.items.find((i: any) => i.task.key === key)?.kind).toBe('proposal');
    // The same key can't be proposed twice, and agents still can't triage.
    expect((await tool(ai, 'create_project', { key: 'DACH', name: 'Again' })).data).toContain('already proposes');
    expect((await tool(ai, 'triage_proposal', { key, accept: true })).isError).toBe(true);
    const ok = await call('POST', `/api/tasks/${key}/triage`, human, { accept: true });
    expect(ok.body).toMatchObject({ status: 'done', project_created: { key: 'DACH', name: 'DACH launch' } });
    const p = (await call('GET', '/api/projects', human)).body.find((x: any) => x.key === 'DACH');
    expect(p).toMatchObject({ name: 'DACH launch', playbook: 'German first.' });
    // And agents can file work in it straight away.
    expect((await tool(ai, 'create_task', { project: 'DACH', title: 'Translate pricing page' })).data.key).toBe('DACH-1');
  });

  it('declines without creating anything, and rejects taken or bad keys up front', async () => {
    const r = await tool(ai, 'create_project', { key: 'OPS', name: 'Ops' });
    await call('POST', `/api/tasks/${r.data.proposal.key}/triage`, human, { accept: false });
    expect((await call('GET', '/api/projects', human)).body.map((p: any) => p.key)).not.toContain('OPS');
    expect((await tool(ai, 'create_project', { key: 'MKT', name: 'Dup' })).isError).toBe(true);
    expect((await tool(ai, 'create_project', { key: '1x', name: 'Bad' })).isError).toBe(true);
  });

  it('creates the project at once for a person', async () => {
    const r = await tool(human, 'create_project', { key: 'SALES', name: 'Sales' });
    expect(r.data).toMatchObject({ created: true, project: { key: 'SALES' } });
  });
});
