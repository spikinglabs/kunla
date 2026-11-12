// KD-68: people sign in with their work Google or Microsoft account; agents keep tokens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeD1 } from './d1-shim';

const call = async (env: any, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json, location: res.headers.get('location') || '', cookie: res.headers.get('set-cookie') || '' };
};
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${b64u({ alg: 'RS256' })}.${b64u(claims)}.sig`;

let env: any, admin: string, bob: { id: string; token: string };
const GOOGLE = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' };
beforeEach(async () => {
  env = { DB: makeD1(), LEASE_MINUTES: '30', ...GOOGLE };
  admin = (await call(env, 'POST', '/api/setup', undefined, { name: 'L', project_key: 'KD', project_name: 'Kunla Dev' })).body.token;
  const r = (await call(env, 'POST', '/api/members', admin, { name: 'Bob', kind: 'human', email: ' Bob@Acme.com ' })).body;
  bob = { id: r.member.id, token: r.token };
});
afterEach(() => vi.unstubAllGlobals());

async function signIn(claims: Record<string, unknown>, provider = 'google') {
  const start = await call(env, 'GET', `/auth/${provider}/start`);
  expect(start.status).toBe(302);
  const state = new URL(start.location).searchParams.get('state')!;
  const cookie = start.cookie.split(';')[0];
  let sent: any = null;
  vi.stubGlobal('fetch', async (url: string, init: any) => { sent = { url, body: new URLSearchParams(init.body) }; return new Response(JSON.stringify({ id_token: idToken(claims) })); });
  const res = await call(env, 'GET', `/auth/${provider}/callback?code=abc&state=${state}`, undefined, undefined, { cookie });
  return { res, sent, start };
}

describe('sign in with Google or Microsoft', () => {
  it('offers only the providers that are set up', async () => {
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['google']);
    env.MICROSOFT_CLIENT_ID = 'mid'; env.MICROSOFT_CLIENT_SECRET = 'ms';
    env.MICROSOFT_TENANT = 'common'; // any directory could vouch for any email: hidden until a workspace trusts one
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['google']);
    env.MICROSOFT_TENANT = 'tenant-1';
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['google', 'microsoft']);
    delete env.GOOGLE_CLIENT_ID;
    expect((await call(env, 'GET', '/auth/google/start')).location).toMatch(/signin_error=/);
  });

  it('signs the person with the matching verified email in with a fresh token', async () => {
    const { res, sent, start } = await signIn({ iss: 'https://accounts.google.com', aud: 'gid', exp: Date.now() / 1000 + 300, email: 'bob@acme.com', email_verified: true });
    const q = new URL(start.location).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe('https://kunla.test/auth/google/callback');
    expect(sent.body.get('code_verifier')).toBeTruthy();
    expect(sent.body.get('client_secret')).toBe('gsecret');
    expect(res.status).toBe(302);
    const token = decodeURIComponent(res.location.match(/^\/app\/#\/use\/(.+)$/)![1]);
    expect((await call(env, 'GET', '/api/me', token)).body.name).toBe('Bob');
    // The person's other tokens keep working.
    expect((await call(env, 'GET', '/api/me', bob.token)).status).toBe(200);
  });

  it('refuses unverified emails, wrong audiences, strangers and a missing state cookie', async () => {
    const ok = { iss: 'https://accounts.google.com', aud: 'gid', exp: Date.now() / 1000 + 300, email: 'bob@acme.com', email_verified: true };
    for (const bad of [{ ...ok, email_verified: false }, { ...ok, aud: 'other' }, { ...ok, iss: 'https://evil.test' }, { ...ok, exp: 1 }, { ...ok, email: 'eve@acme.com' }]) {
      const { res } = await signIn(bad);
      expect(res.location).toMatch(/^\/app\/\?signin_error=/);
    }
    expect((await signIn({ ...ok, email: 'eve@acme.com' })).res.location).toContain(encodeURIComponent('Nobody with eve@acme.com'));
    const start = await call(env, 'GET', '/auth/google/start');
    const state = new URL(start.location).searchParams.get('state');
    expect((await call(env, 'GET', `/auth/google/callback?code=abc&state=${state}`)).location).toMatch(/signin_error=/);
  });

  it('accepts Microsoft accounts from the one configured tenant', async () => {
    Object.assign(env, { MICROSOFT_CLIENT_ID: 'mid', MICROSOFT_CLIENT_SECRET: 'ms', MICROSOFT_TENANT: 'tenant-1' });
    const claims = { iss: 'https://login.microsoftonline.com/tenant-1/v2.0', aud: 'mid', exp: Date.now() / 1000 + 300, preferred_username: 'BOB@acme.com' };
    const { res, sent } = await signIn(claims, 'microsoft');
    expect(sent.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(res.location).toMatch(/^\/app\/#\/use\//);
    expect((await signIn({ ...claims, iss: 'https://login.microsoftonline.com/other/v2.0' }, 'microsoft')).res.location).toMatch(/signin_error=/);
  });

  it('without a fixed tenant, each workspace lists the Microsoft directories it trusts (KD-70)', async () => {
    const T1 = '11111111-1111-4111-8111-111111111111', T2 = '22222222-2222-4222-8222-222222222222';
    Object.assign(env, { MICROSOFT_CLIENT_ID: 'mid', MICROSOFT_CLIENT_SECRET: 'ms' });
    expect((await call(env, 'GET', '/api/signin/microsoft', admin)).body).toEqual({ available: true, fixed_tenant: null, tenants: [] });
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['google']);
    // Only admins, only tenant ids, never the personal-accounts tenant.
    expect((await call(env, 'PUT', '/api/signin/microsoft', bob.token, { tenants: [T1] })).status).toBe(403);
    expect((await call(env, 'PUT', '/api/signin/microsoft', admin, { tenants: 'acme.com' })).status).toBe(400);
    expect((await call(env, 'PUT', '/api/signin/microsoft', admin, { tenants: ['9188040d-6c67-4c5b-b112-36a304b66dad'] })).status).toBe(400);
    expect((await call(env, 'PUT', '/api/signin/microsoft', admin, { tenants: `${T1.toUpperCase()}\n${T1}` })).body.tenants).toEqual([T1]);
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['google', 'microsoft']);
    // A second workspace with Bob in it trusts another directory.
    const com = (await call(env, 'POST', '/api/workspaces', admin, { name: 'Community', key: 'COM' })).body.token;
    await call(env, 'POST', '/api/members', com, { name: 'Bobby', kind: 'human', email: 'bob@acme.com' });
    await call(env, 'PUT', '/api/signin/microsoft', com, { tenants: [T2] });

    const claims = (tid: string) => ({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, aud: 'mid', exp: Date.now() / 1000 + 300, preferred_username: 'bob@acme.com' });
    const { res, sent, start } = await signIn(claims(T1), 'microsoft');
    expect(new URL(start.location).pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect(sent.url).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
    // Only the workspace that trusts T1 lets Bob in.
    const m = res.location.match(/^\/app\/#\/use\/([^/]+)$/)!;
    expect((await call(env, 'GET', '/api/me', decodeURIComponent(m[1]))).body.workspace.key).toBe('WS');
    const other = (await signIn(claims(T2), 'microsoft')).res.location.match(/^\/app\/#\/use\/([^/]+)$/)!;
    expect((await call(env, 'GET', '/api/me', decodeURIComponent(other[1]))).body.workspace.key).toBe('COM');
    // A directory nobody trusts, a token whose issuer doesn't match its tenant, and personal accounts are refused.
    const T3 = '33333333-3333-4333-8333-333333333333';
    expect((await signIn(claims(T3), 'microsoft')).res.location).toContain(encodeURIComponent('No workspace here trusts'));
    expect((await signIn({ ...claims(T1), iss: `https://login.microsoftonline.com/${T3}/v2.0` }, 'microsoft')).res.location).toMatch(/signin_error=/);
    expect((await signIn(claims('9188040d-6c67-4c5b-b112-36a304b66dad'), 'microsoft')).res.location).toMatch(/signin_error=/);
  });

  it('routes Microsoft through Kunla Cloud when it has no fixed tenant', async () => {
    Object.assign(env, { MICROSOFT_CLIENT_ID: 'mid', MICROSOFT_CLIENT_SECRET: 'ms', KUNLA_TENANT: 'acme', KUNLA_CLOUD_HOOK: 'https://cloud.test/hooks/kunla' });
    const q = new URL((await call(env, 'GET', '/auth/microsoft/start')).location).searchParams;
    expect(q.get('redirect_uri')).toBe('https://cloud.test/auth/microsoft/callback');
    expect(q.get('state')).toMatch(/^acme\./);
    env.MICROSOFT_TENANT = 'tenant-1'; // a team's own directory and app: straight back
    expect(new URL((await call(env, 'GET', '/auth/microsoft/start')).location).searchParams.get('redirect_uri')).toBe('https://kunla.test/auth/microsoft/callback');
  });

  it('only admins set emails, one person per email', async () => {
    expect((await call(env, 'PATCH', `/api/members/${bob.id}`, bob.token, { email: 'l@acme.com' })).status).toBe(403);
    const me = (await call(env, 'GET', '/api/me', admin)).body;
    expect((await call(env, 'PATCH', `/api/members/${me.id}`, admin, { email: 'BOB@acme.com' })).status).toBe(409);
    expect((await call(env, 'PATCH', `/api/members/${me.id}`, admin, { email: 'nope' })).status).toBe(400);
    expect((await call(env, 'PATCH', `/api/members/${me.id}`, admin, { email: 'L@acme.com' })).body.email).toBe('l@acme.com');
    const ai = (await call(env, 'POST', '/api/members', admin, { name: 'Bot', kind: 'ai', email: 'bot@acme.com' })).body;
    expect(ai.member.email).toBeNull();
  });
});

describe('one sign-in for every workspace with your email (KD-29)', () => {
  const ok = { iss: 'https://accounts.google.com', aud: 'gid', exp: Date.now() / 1000 + 300, email: 'bob@acme.com', email_verified: true };
  it('brings a token for each workspace that knows the email; the app opens one and lists the rest', async () => {
    const com = (await call(env, 'POST', '/api/workspaces', admin, { name: 'Community', key: 'COM' })).body.token;
    expect((await call(env, 'POST', '/api/members', com, { name: 'Bobby', kind: 'human', email: 'bob@acme.com' })).status).toBe(200);
    const m = (await signIn(ok)).res.location.match(/^\/app\/#\/use\/([^/]+)\/also\/(.+)$/)!;
    expect(m).toBeTruthy();
    const names = await Promise.all([m[1], ...m[2].split(',')].map(async (t) => (await call(env, 'GET', '/api/me', decodeURIComponent(t))).body.workspace.key));
    expect(names.sort()).toEqual(['COM', 'WS']);
  });

  it('goes back to the claude.ai approval page when it started there, and nowhere else', async () => {
    const back = encodeURIComponent('/oauth/authorize?client_id=x&state=y');
    const start = await call(env, 'GET', `/auth/google/start?return=${back}`);
    const state = new URL(start.location).searchParams.get('state')!;
    const cookie = start.cookie.split(/,\s*(?=kunla_oidc)/).map((c) => c.split(';')[0]).join('; ');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id_token: idToken(ok) })));
    const res = await call(env, 'GET', `/auth/google/callback?code=abc&state=${state}`, undefined, undefined, { cookie });
    expect(res.location).toMatch(/^\/oauth\/authorize\?client_id=x&state=y#signin=kun_/);
    const evil = await call(env, 'GET', `/auth/google/start?return=${encodeURIComponent('https://evil.test/')}`);
    expect(evil.cookie).toMatch(/kunla_oidc_back=;/);
  });
});

describe('sign in with GitHub', () => {
  const github = async (user: object | null, emails: object[] | null, extra: Record<string, string> = {}) => {
    Object.assign(env, { GITHUB_LOGIN_CLIENT_ID: 'ghid', GITHUB_LOGIN_CLIENT_SECRET: 'ghs', ...extra });
    const start = await call(env, 'GET', '/auth/github/start');
    const state = new URL(start.location).searchParams.get('state')!;
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_x' }));
      if (url.endsWith('/user')) return new Response(JSON.stringify(user));
      if (url.endsWith('/user/emails')) return new Response(JSON.stringify(emails));
      return new Response('{}', { status: 404 });
    });
    const res = await call(env, 'GET', `/auth/github/callback?code=abc&state=${state}`, undefined, undefined, { cookie: start.cookie.split(';')[0] });
    return { start, res };
  };
  it('matches a verified email or the linked GitHub login', async () => {
    expect((await call(env, 'GET', '/api/edition')).body.sign_in.map((p: any) => p.id)).toEqual(['google']);
    const { start, res } = await github({ login: 'bobgh' }, [{ email: 'old@x.com', verified: true, primary: true }, { email: 'BOB@acme.com', verified: true, primary: false }]);
    expect(new URL(start.location).searchParams.get('scope')).toBe('read:user user:email');
    expect(res.location).toMatch(/^\/app\/#\/use\//);
    expect((await github({ login: 'stranger' }, [{ email: 'bob@acme.com', verified: false, primary: true }])).res.location).toMatch(/signin_error=/);
    // Signing in with GitHub linked the login (KD-86), so next time the login alone is enough.
    expect((await env.DB.prepare('SELECT github_login FROM members WHERE id = ?').bind(bob.id).first()).github_login).toBe('bobgh');
    expect((await github({ login: 'BobGH' }, [])).res.location).toMatch(/^\/app\/#\/use\//);
  });

  it('on Kunla Cloud, comes back through the Cloud router with the shared app', async () => {
    delete env.GITHUB_LOGIN_CLIENT_ID;
    Object.assign(env, { GITHUB_APP_CLIENT_ID: 'appid', GITHUB_APP_CLIENT_SECRET: 'apps', KUNLA_TENANT: 'acme', KUNLA_CLOUD_HOOK: 'https://cloud.test/hooks/kunla' });
    const start = await call(env, 'GET', '/auth/github/start');
    const q = new URL(start.location).searchParams;
    expect(q.get('client_id')).toBe('appid');
    expect(q.get('redirect_uri')).toBe('https://cloud.test/auth/github/callback');
    expect(q.get('state')).toMatch(/^acme\./);

    // Google too: the shared Cloud client, back through the router, and the round trip still signs Bob in.
    Object.assign(env, { GOOGLE_CLIENT_ID: 'cloud-gid' });
    const { res, sent, start: gs } = await signIn({ iss: 'https://accounts.google.com', aud: 'cloud-gid', exp: Date.now() / 1000 + 300, email: 'bob@acme.com', email_verified: true });
    const gq = new URL(gs.location).searchParams;
    expect(gq.get('redirect_uri')).toBe('https://cloud.test/auth/google/callback');
    expect(gq.get('state')).toMatch(/^acme\./);
    expect(sent.body.get('redirect_uri')).toBe('https://cloud.test/auth/google/callback');
    expect(res.location).toMatch(/^\/app\/#\/use\//);
  });
});
