// KD-71: one shared public Kunla GitHub App for Kunla Cloud. Teams only install it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { sign } from '../src/github';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let env: any, admin: string, calls: { url: string; body: any; headers: any }[] = [], userSees = [42];
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://acme.kunla.test${path}`, { method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, exec);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location') || '', body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
};
const hook = async (event: string, payload: unknown, secret = 'shared-whsec') => {
  const body = JSON.stringify(payload);
  const res = await app.fetch(new Request('https://acme.kunla.test/hooks/github', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': `d-${Math.random()}`, 'x-hub-signature-256': await sign(secret, body) } }), env, exec);
  return { status: res.status, body: await res.json<any>() };
};

beforeEach(async () => {
  calls = []; userSees = [42];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
    if (url === 'https://github.com/login/oauth/access_token') return json(JSON.parse(init.body).code === 'good' ? { access_token: 'ghu_user' } : { error: 'bad_verification_code' });
    if (url.includes('/user/installations')) return json({ installations: userSees.map((id) => ({ id })) });
    const inst = /\/app\/installations\/(\d+)$/.exec(url);
    if (inst) return json({ id: Number(inst[1]), account: { login: 'acme', type: 'Organization' } });
    if (url === 'https://cloud.test/github/installations') return json({ ok: true });
    return json({}, 404);
  });
  env = { DB: makeD1(), LEASE_MINUTES: '30', GITHUB_APP_ID: '7', GITHUB_APP_SLUG: 'kunla', GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
    GITHUB_APP_WEBHOOK_SECRET: 'shared-whsec', GITHUB_APP_CLIENT_ID: 'Iv1.x', GITHUB_APP_CLIENT_SECRET: 'cs',
    KUNLA_TENANT: 'acme', KUNLA_CLOUD_HOOK: 'https://cloud.test/github/installations', KUNLA_CLOUD_SECRET: 'cloud-secret' };
  admin = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
});
afterEach(() => vi.unstubAllGlobals());

async function install(code = 'good', id = 42) {
  const s = await call('POST', '/api/integrations/github/app', admin, {});
  expect(s.body.install_url).toMatch(/^https:\/\/github\.com\/apps\/kunla\/installations\/new\?state=acme\./);
  const state = new URL(s.body.install_url).searchParams.get('state');
  return call('GET', `/hooks/github/app/installed?installation_id=${id}&setup_action=install&state=${state}&code=${code}`);
}

describe('shared Kunla GitHub App', () => {
  it('skips creating an app: admins go straight to installing the shared one', async () => {
    const info = (await call('GET', '/api/integrations/github', admin)).body;
    expect(info.app).toMatchObject({ registered: true, shared: true, slug: 'kunla', merge: true });
    expect((await call('GET', '/hooks/github/app/created?code=abc&state=x')).location).toContain('gh=exists');
  });

  it('links an install only when GitHub confirms the installer can see it, and tells the router', async () => {
    expect((await install('good')).location).toContain('gh=connected');
    const told = calls.find((c) => c.url === 'https://cloud.test/github/installations')!;
    expect(told.body).toMatchObject({ action: 'linked', installation_id: 42, tenant: 'acme' });
    const sig = createHmac('sha256', 'cloud-secret').update(JSON.stringify(told.body)).digest('hex');
    expect(told.headers['x-kunla-signature-256']).toBe(`sha256=${sig}`);
    // Signed with the shared app's secret, its deliveries now reach this workspace.
    expect((await hook('ping', { installation: { id: 42 } })).status).toBe(200);
    expect((await hook('ping', { installation: { id: 42 } }, 'wrong')).status).toBe(401);
  });

  it("refuses someone else's installation id or a missing sign-in", async () => {
    userSees = [5];
    expect((await install('good', 42)).location).toContain('gh=failed');
    userSees = [42];
    expect((await install('bad', 42)).location).toContain('gh=failed');
    expect((await call('GET', '/api/integrations/github', admin)).body.app.installations).toEqual([]);
    expect(calls.some((c) => c.url === 'https://cloud.test/github/installations')).toBe(false);
  });

  it('tells the router when the app is uninstalled', async () => {
    await install();
    calls = [];
    await hook('installation', { action: 'deleted', installation: { id: 42, account: { login: 'acme' } } });
    expect(calls.find((c) => c.url === 'https://cloud.test/github/installations')?.body).toMatchObject({ action: 'unlinked', installation_id: 42 });
  });
});
