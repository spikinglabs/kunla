import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

// KD-10: progress and decision inbox views for chats (MCP Apps).
let env: any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const mcp = async (token: string, method: string, params?: unknown) => (await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method, params })).body;

let human: string, ai: string;
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'mkt', project_name: 'Q1 campaign' })).body.token;
  ai = (await call('POST', '/api/members', human, { name: "L's Claude", kind: 'ai', platform: 'claude-ai' })).body.token;
});

describe('chat views (MCP Apps)', () => {
  it('advertises resources and links project_status and decision_inbox to their views', async () => {
    const init = await mcp(ai, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.capabilities.resources).toBeDefined();
    const tools = (await mcp(ai, 'tools/list')).result.tools;
    expect(tools.find((t: any) => t.name === 'project_status')._meta.ui.resourceUri).toBe('ui://kunla/progress');
    expect(tools.find((t: any) => t.name === 'decision_inbox')._meta.ui.resourceUri).toBe('ui://kunla/inbox');
    expect(tools.find((t: any) => t.name === 'next_task')._meta).toBeUndefined();
    const list = (await mcp(ai, 'resources/list')).result.resources;
    expect(list.map((r: any) => r.uri)).toEqual(['ui://kunla/progress', 'ui://kunla/inbox']);
  });

  it('serves each view as one self-contained HTML file', async () => {
    for (const uri of ['ui://kunla/progress', 'ui://kunla/inbox']) {
      const r = (await mcp(ai, 'resources/read', { uri })).result.contents[0];
      expect(r.mimeType).toBe('text/html;profile=mcp-app');
      expect(r.text).toContain('ui/initialize');
      expect(r.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    }
    expect((await mcp(ai, 'resources/read', { uri: 'ui://kunla/nope' })).error.code).toBe(-32002);
  });

  it('keeps the text fallback and adds structured data for the view', async () => {
    await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Draft pricing page' });
    const r = (await mcp(ai, 'tools/call', { name: 'project_status', arguments: { project: 'MKT' } })).result;
    expect(JSON.parse(r.content[0].text).counts.ready).toBe(1);
    expect(r.structuredContent).toMatchObject({ counts: { ready: 1 }, me: { kind: 'ai' }, board: 'https://kunla.test' });
    const inbox = (await mcp(ai, 'tools/call', { name: 'decision_inbox', arguments: {} })).result;
    expect(inbox.structuredContent).toMatchObject({ count: 0, items: [] });
    const plain = (await mcp(ai, 'tools/call', { name: 'whoami', arguments: {} })).result;
    expect(plain.structuredContent).toBeUndefined();
  });
});
