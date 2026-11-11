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
    env.MICROSOFT_TENANT = 'common'; // any directory could vouch for any email: refused
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
