import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

// KD-86: the signed-in person's profile page.
let env: any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let human: string, ai: string, aiId: string, humanId: string;
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', workspace_name: 'Acme', workspace_key: 'ACME' })).body.token;
  humanId = (await call('GET', '/api/me', human)).body.id;
  const a = await call('POST', '/api/members', human, { name: "L's Claude Code", kind: 'ai', platform: 'claude-code' });
  ai = a.body.token; aiId = a.body.member.id;
});

describe('profile', () => {
  it('shows who you are, where you are signed in, your agents and your numbers', async () => {
    await call('POST', '/api/tasks', human, { title: 'Write the launch post', status: 'ready' });
    await call('PATCH', `/api/members/${humanId}`, human, { github_login: 'octocat' });
    await call('PATCH', `/api/members/${humanId}`, human, { email: 'l@acme.test' });
    const p = await call('GET', '/api/profile', human);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ name: 'L', roles: expect.arrayContaining(['admin']), email: 'l@acme.test', github_login: 'octocat', stats: { created: 1 } });
    expect(p.body.sign_ins).toHaveLength(1);
    expect(p.body.sign_ins[0]).toMatchObject({ current: true, how: 'Personal token' });
    expect(JSON.stringify(p.body)).not.toContain('token_hash');
    expect(p.body.agents).toEqual([expect.objectContaining({ id: aiId, name: "L's Claude Code", platform: 'claude-code', connections: 1, continuous: false })]);
  });

  it('is for people only', async () => {
    expect((await call('GET', '/api/profile', ai)).status).toBe(403);
  });

  it('signs out one other place, but not this browser', async () => {
    // A second sign-in for the same person: a new token from rotation would revoke the first, so add one directly.
    const { issueToken } = await import('../src/core');
    const other = await issueToken(env.DB, humanId, 'sign-in:google');
    const p = await call('GET', '/api/profile', human);
    expect(p.body.sign_ins.map((s: any) => s.how).sort()).toEqual(['Personal token', 'Signed in with Google']);
    const here = p.body.sign_ins.find((s: any) => s.current), there = p.body.sign_ins.find((s: any) => !s.current);
    expect((await call('DELETE', `/api/profile/sign-ins/${here.id}`, human)).status).toBe(400);
    expect((await call('DELETE', `/api/profile/sign-ins/${there.id}`, human)).status).toBe(200);
    expect((await call('GET', '/api/me', other)).status).toBe(401);
    expect((await call('GET', '/api/me', human)).status).toBe(200);
  });

  it("can't sign out someone else's token", async () => {
    const add = await call('POST', '/api/members', human, { name: 'Sam', kind: 'human' });
    const sam = add.body.token;
    const p = await call('GET', '/api/profile', human);
    expect((await call('DELETE', `/api/profile/sign-ins/${p.body.sign_ins[0].id}`, sam)).status).toBe(404);
  });
});
