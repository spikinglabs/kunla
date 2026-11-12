// KD-70: sign in with an emailed one-time link, for people without a Google, Microsoft or GitHub account.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

const call = async (env: any, method: string, path: string, token?: string, body?: unknown, form = false) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, redirect: 'manual',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json, text, location: res.headers.get('location') || '' };
};

let env: any, admin: string, sent: { from: string; to: string; subject: string; text: string }[];
const linkIn = (text: string) => text.match(/\/auth\/email\/open\?t=([A-Za-z0-9_-]+)/)![1];
beforeEach(async () => {
  sent = [];
  env = { DB: makeD1(), LEASE_MINUTES: '30', MAIL_FROM: 'Kunla <kunla@acme.test>', EMAIL: { send: async (m: any) => { sent.push(m); } } };
  admin = (await call(env, 'POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
  await call(env, 'POST', '/api/members', admin, { name: 'Bob', kind: 'human', email: 'bob@acme.com' });
  const com = (await call(env, 'POST', '/api/workspaces', admin, { name: 'Community', key: 'COM' })).body.token;
  await call(env, 'POST', '/api/members', com, { name: 'Bob C', kind: 'human', email: 'Bob@Acme.com' });
});
afterEach(() => vi.unstubAllGlobals());

describe('email sign-in links', () => {
  it('is offered only when a way to send email is set up', async () => {
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['email']);
    delete env.EMAIL;
    expect((await call(env, 'GET', '/api/edition')).body.sign_in).toEqual([]);
    expect((await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com' })).status).toBe(404);
  });

  it('emails a one-time link that signs the person in to every workspace with that email', async () => {
    const r = await call(env, 'POST', '/auth/email/start', undefined, { email: ' BOB@acme.com ' });
    expect(r.body.message).toMatch(/on its way/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'Kunla <kunla@acme.test>', to: 'bob@acme.com', subject: 'Your Kunla sign-in link' });
    const t = linkIn(sent[0].text);
    // Opening the link only shows a button (mail scanners open links); the button signs in.
    const page = await call(env, 'GET', `/auth/email/open?t=${t}`);
    expect(page.text).toContain('<button>Sign in</button>');
    const done = await call(env, 'POST', '/auth/email/open', undefined, { t }, true);
    expect(done.status).toBe(303);
    const m = done.location.match(/^\/app\/#\/use\/([^/]+)\/also\/(.+)$/)!;
    const names = await Promise.all([m[1], m[2]].map(async (x) => (await call(env, 'GET', '/api/me', decodeURIComponent(x))).body.name));
    expect(names.sort()).toEqual(['Bob', 'Bob C']);
    // Once only.
    expect((await call(env, 'POST', '/auth/email/open', undefined, { t }, true)).location).toMatch(/signin_error=.*already%20used/);
  });

  it('says the same for unknown emails and sends nothing; limits links per hour; links expire', async () => {
    const r = await call(env, 'POST', '/auth/email/start', undefined, { email: 'eve@evil.test' });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/If eve@evil.test belongs/);
    expect(sent).toHaveLength(0);
    expect((await call(env, 'POST', '/auth/email/start', undefined, { email: 'nope' })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com' })).status).toBe(200);
    expect((await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com' })).status).toBe(429);
    const raw = (env.DB as any);
    await raw.prepare(`UPDATE login_links SET expires_at = '2000-01-01T00:00:00Z'`).run();
    expect((await call(env, 'POST', '/auth/email/open', undefined, { t: linkIn(sent[0].text) }, true)).location).toMatch(/signin_error=/);
  });

  it('goes back to the claude.ai approval page when asked from there, and nowhere else', async () => {
    await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com', return: '/oauth/authorize?client_id=x' });
    await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com', return: 'https://evil.test/' });
    const a = await call(env, 'POST', '/auth/email/open', undefined, { t: linkIn(sent[0].text) }, true);
    expect(a.location).toMatch(/^\/oauth\/authorize\?client_id=x#signin=/);
    const b = await call(env, 'POST', '/auth/email/open', undefined, { t: linkIn(sent[1].text) }, true);
    expect(b.location).toMatch(/^\/app\/#\/use\//);
  });

  it('sends through Resend when that is what is set up', async () => {
    delete env.EMAIL; env.RESEND_API_KEY = 're_test';
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => { calls.push({ url, init }); return new Response('{"id":"e1"}'); });
    await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com' });
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.headers.authorization).toBe('Bearer re_test');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ from: 'Kunla <kunla@acme.test>', to: ['bob@acme.com'] });
  });

  it('on Kunla Cloud, asks the control plane to send it, signed', async () => {
    delete env.EMAIL; delete env.MAIL_FROM;
    Object.assign(env, { KUNLA_CLOUD_MAIL: 'true', KUNLA_CLOUD_SECRET: 's3cret', KUNLA_TENANT: 'acme', KUNLA_CLOUD_HOOK: 'https://cloud.test/hooks/kunla' });
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['email']);
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => { calls.push({ url, init }); return new Response('{"sent":true}'); });
    await call(env, 'POST', '/auth/email/start', undefined, { email: 'bob@acme.com' });
    expect(calls[0].url).toBe('https://cloud.test/api/teams/acme/mail');
    expect(calls[0].init.headers['x-kunla-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ to: 'bob@acme.com', subject: 'Your Kunla sign-in link' });
  });
});
