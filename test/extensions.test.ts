// KD-75: plug-in points (policies, audit sinks, sign-in providers) and the licence check.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import app, { scheduled } from '../src/index';
import { makeD1 } from './d1-shim';
import { readLicence, hasFeature, COMMUNITY } from '../src/licence';
import { register, reset, type AuditEvent } from '../src/extensions';
import * as core from '../src/core';

const script = '../scripts/licence.mjs';
const tools = () => import(/* @vite-ignore */ script as string) as Promise<any>;

const call = async (env: any, method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
};

describe('licence keys', () => {
  it('are Community without a key, and Enterprise with a valid signed one', async () => {
    const { keygen, sign } = await tools();
    const { privateKey, publicKey } = await keygen();
    expect(await readLicence(undefined, new Date(), publicKey)).toEqual(COMMUNITY);
    const key = await sign(privateKey, { licensee: 'Acme', features: ['sso', 'audit'], seats: 5, expires_at: '2030-01-01' });
    const l = await readLicence(key, new Date('2026-11-11'), publicKey);
    expect(l).toMatchObject({ edition: 'enterprise', licensee: 'Acme', features: ['sso', 'audit'], seats: 5 });
    expect(hasFeature(l, 'sso')).toBe(true);
    expect(hasFeature(l, 'scim')).toBe(false);
  });

  it('refuse a tampered, expired or foreign key, saying why', async () => {
    const { keygen, sign } = await tools();
    const ours = await keygen();
    const theirs = await keygen();
    const key = await sign(ours.privateKey, { licensee: 'Acme', features: ['sso'], expires_at: '2026-01-01' });
    expect((await readLicence(key, new Date('2026-11-11'), ours.publicKey)).problem).toMatch(/expired/);
    const forged = await sign(theirs.privateKey, { licensee: 'Acme', features: ['sso'] });
    expect((await readLicence(forged, new Date(), ours.publicKey)).edition).toBe('community');
    const [body, sig] = (await sign(ours.privateKey, { features: ['sso'] })).split('.');
    const tampered = `${Buffer.from(JSON.stringify({ features: ['sso', 'audit'] })).toString('base64url')}.${sig}`;
    expect((await readLicence(tampered, new Date(), ours.publicKey)).problem).toMatch(/signature/);
    expect((await readLicence(`${body}`, new Date(), ours.publicKey)).problem).toMatch(/format/);
    // The shipped build has no public key yet, so no key can turn Enterprise on.
    expect((await readLicence(key)).edition).toBe('community');
  });
});

describe('plug-in points', () => {
  let env: any, admin: string, ai: string;
  const enterprise = { edition: 'enterprise' as const, licensee: 'Acme', features: ['policies', 'audit', 'sso'], seats: null, expires_at: null };

  beforeEach(async () => {
    reset();
    env = { DB: makeD1(), LEASE_MINUTES: '30' };
    admin = (await call(env, 'POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
    ai = (await call(env, 'POST', '/api/members', admin, { name: "L's Claude", kind: 'ai', platform: 'claude-code' })).body.token;
    await call(env, 'POST', '/api/tasks', admin, { project: 'KD', title: 'Research a vendor', kind: 'research', status: 'ready' });
  });
  afterEach(() => reset());

  it('lets nothing change on Community, even with extensions registered', async () => {
    register({ policies: [{ name: 'no-agents', feature: 'policies', check: () => 'No agents here.' }] });
    expect((await call(env, 'POST', '/api/tasks/KD-1/claim', ai, {})).status).toBe(200);
    const ed = await call(env, 'GET', '/api/edition');
    expect(ed.body).toMatchObject({ edition: 'community', sign_in: [] });
  });

  it('policies can refuse an action, only when the licence has their feature', async () => {
    const { keygen, sign } = await tools();
    const { privateKey, publicKey } = await keygen();
    register({ policies: [{ name: 'no-research-agents', feature: 'policies', check: (_c, a) => a.type === 'claim_task' && a.task.kind === 'research' ? 'Agents may not take research tasks here.' : null }] });
    const { refusal } = await import('../src/extensions');
    const ctx: any = { me: { kind: 'ai' } };
    const action = { type: 'claim_task' as const, task: { key: 'KD-1', kind: 'research', project_id: 'p' } };
    expect(await refusal(ctx, action, COMMUNITY)).toBeNull();
    expect(await refusal(ctx, action, enterprise)).toMatch(/research/);
    expect(await refusal(ctx, action, { ...enterprise, features: ['sso'] })).toBeNull();
    expect(publicKey && privateKey).toBeTruthy();
  });

  it('sends the record to audit sinks from the cron, picking up where it left off', async () => {
    const sent: AuditEvent[][] = [];
    register({ audit: [{ name: 'test', feature: 'audit', send: async (events) => { sent.push(events); } }] });
    const { flushAudit } = await import('../src/extensions');
    await flushAudit(env.DB, {}, COMMUNITY);
    expect(sent).toHaveLength(0);
    await flushAudit(env.DB, {}, enterprise);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({ task_key: 'KD-1', actor: 'L', actor_kind: 'human' });
    await flushAudit(env.DB, {}, enterprise);
    expect(sent).toHaveLength(1); // nothing new
    await call(env, 'POST', '/api/tasks/KD-1/claim', ai, {});
    await flushAudit(env.DB, {}, enterprise);
    expect(sent[1].map((e) => e.type)).toContain('claimed');
    // The Worker's cron runs it too (Community here, so nothing is sent).
    const jobs: Promise<unknown>[] = [];
    await scheduled(null, env, { waitUntil: (p) => jobs.push(p) });
    await Promise.all(jobs);
    expect(sent).toHaveLength(2);
  });

  it('checks policies and seats inside the core when the licence turns them on', async () => {
    const ctxFor = async (token: string, licence: any) => {
      const me = (await core.memberForToken(env.DB, token))!;
      return { db: env.DB, me, space: me.space_id, baseUrl: 'https://kunla.test', leaseMinutes: 30, licence } as core.Ctx;
    };
    register({ policies: [{ name: 'only-claude', feature: 'policies', check: (_c, a) => a.type === 'add_member' && a.kind === 'ai' && a.platform !== 'claude-code' ? 'Only Claude Code agents may join.' : null }] });
    const c = await ctxFor(admin, enterprise);
    await expect(core.addMember(c, { name: 'Codex', kind: 'ai', platform: 'codex' })).rejects.toThrow(/Only Claude Code/);
    await expect(core.addMember(c, { name: 'Another Claude', kind: 'ai', platform: 'claude-code' })).resolves.toBeTruthy();
    // Seats count people only; agents stay free.
    const two = await ctxFor(admin, { ...enterprise, seats: 2 });
    await core.addMember(two, { name: 'Maya', kind: 'human' });
    await expect(core.addMember(two, { name: 'Jon', kind: 'human' })).rejects.toThrow(/covers 2 people/);
    await expect(core.addMember(two, { name: 'Gemini', kind: 'ai', platform: 'claude-code' })).resolves.toBeTruthy();
  });

  it('keeps sign-in routes closed without a licence', async () => {
    register({ signIn: [{ id: 'okta', label: 'Sign in with Okta', feature: 'sso', handle: async () => new Response('hi') }] });
    expect((await call(env, 'GET', '/auth/okta/start')).status).toBe(404);
  });
});
