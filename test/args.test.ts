import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

// KD-47: a misnamed argument must never silently do something else.
let env: any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const tool = async (token: string, name: string, args: unknown) =>
  (await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;

let human: string, ai: string;
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'mkt', project_name: 'Q1 campaign' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai', platform: 'claude-ai' })).body.token;
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Draft pricing page' });
});

describe('tool arguments', () => {
  it('log_work with key adds to that task instead of creating a new one', async () => {
    const r = await tool(ai, 'log_work', { key: 'MKT-1', summary: 'Wrote the first draft' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text).key).toBe('MKT-1');
    const all = (await call('GET', '/api/tasks', human)).body;
    expect((all.tasks ?? all).length).toBe(1);
  });

  it('get_task accepts task as an alias of key', async () => {
    const r = await tool(ai, 'get_task', { task: 'MKT-1' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content[0].text).key).toBe('MKT-1');
  });

  it('refuses unknown arguments and names the real ones', async () => {
    const r = await tool(ai, 'log_work', { taskKey: 'MKT-1', summary: 'Wrote it' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("log_work doesn't take `taskKey`");
    expect(r.content[0].text).toContain('`task`');
    const all = (await call('GET', '/api/tasks', human)).body;
    expect((all.tasks ?? all).length).toBe(1);
  });

  it('refuses a non-object', async () => {
    const r = await tool(ai, 'whoami', ['x']);
    expect(r.isError).toBe(true);
  });
});
