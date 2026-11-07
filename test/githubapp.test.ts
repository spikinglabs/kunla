import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import app from '../src/index';
import { makeD1 } from './d1-shim';
import { sign } from '../src/github';
import { appJwt, manifest, permissions } from '../src/githubapp';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(); // what GitHub hands back

let env: any;
let human: string, ai: string, aiId: string;
let pending: Promise<unknown>[] = [];
let calls: { method: string; url: string; body: any; auth?: string }[] = [];
let installedOn = 'acme';
const exec = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} } as any;
const flush = async () => { while (pending.length) { const p = pending; pending = []; await Promise.all(p); } };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await app.fetch(new Request(`https://kunla.test${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  }), env, exec);
  await flush();
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
};
let n = 0;
const hook = async (event: string, payload: unknown, secret = 'whsec') => {
  const body = JSON.stringify(payload);
  const res = await app.fetch(new Request('https://kunla.test/hooks/github', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': `a-${++n}`, 'x-hub-signature-256': await sign(secret, body) } }), env, exec);
  await flush();
  return { status: res.status, body: await res.json<any>() };
};
const task = async (key: string) => (await call('GET', `/api/tasks/${key}`, human)).body;

/** Admin taps Connect with GitHub, confirms on GitHub, picks repositories. Returns the install redirect. */
async function connect(token = human, installation = 42) {
  const s = await call('POST', '/api/integrations/github/app', token, { org: 'acme' });
  const state = new URL(s.body.action).searchParams.get('state');
  const created = await call('GET', `/hooks/github/app/created?code=abc123&state=${state}`);
  const installState = new URL(created.location!).searchParams.get('state');
  return call('GET', `/hooks/github/app/installed?installation_id=${installation}&setup_action=install&state=${installState}`);
}

beforeEach(async () => {
  calls = []; installedOn = 'acme';
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method: init?.method ?? 'GET', url, body, auth: init?.headers?.authorization });
    if (url.includes('agent.test')) return new Response('ok');
    if (url.endsWith('/app-manifests/abc123/conversions')) return json({ id: 99, slug: 'kunla-acme', name: 'Kunla acme', pem: PEM, webhook_secret: 'whsec', html_url: 'https://github.com/apps/kunla-acme', owner: { login: 'acme', type: 'Organization' } }, 201);
    const inst = /\/app\/installations\/(\d+)$/.exec(url);
    if (inst) return json({ id: Number(inst[1]), account: { login: inst[1] === '42' ? 'acme' : 'other', type: 'Organization' } });
    if (url.endsWith('/repos/acme/app/installation')) return installedOn === 'acme' ? json({ id: 42 }) : json({ message: 'Not Found' }, 404);
    if (url.endsWith('/app/installations/42/access_tokens')) return json({ token: 'ghs_install' }, 201);
    if (url.endsWith('/pulls/7')) return json({ state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'abc' }, title: 'MKT-1: Pricing' });
    if (url.includes('/check-runs')) return json({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
    if (url.endsWith('/pulls/7/merge')) return json({ sha: 'm1', merged: true });
    return json({}, 404);
  });
  env = { DB: makeD1(), LEASE_MINUTES: '30' };
  human = (await call('POST', '/api/setup', undefined, { name: 'L', project_key: 'MKT', project_name: 'Q1' })).body.token;
  const a = await call('POST', '/api/members', human, { name: 'Coder', kind: 'ai' });
  ai = a.body.token; aiId = a.body.member.id;
  await call('PUT', `/api/members/${aiId}/wake`, human, { url: 'https://agent.test/wake' });
  await call('POST', '/api/tasks', human, { project: 'MKT', title: 'Pricing page' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Kunla GitHub App', () => {
  it('asks for the fewest permissions', () => {
    expect(permissions(false)).toEqual({ metadata: 'read', pull_requests: 'read', checks: 'read', contents: 'read' });
    expect(permissions(true).contents).toBe('write');
    const m = manifest('https://k.test', 'Kunla acme', true);
    expect(m).toMatchObject({ public: false, hook_attributes: { url: 'https://k.test/hooks/github' }, redirect_url: 'https://k.test/hooks/github/app/created',
      setup_url: 'https://k.test/hooks/github/app/installed', default_events: ['pull_request', 'push', 'check_suite'] });
  });

  it('signs a JWT GitHub can check with the app key', async () => {
    const jwt = await appJwt({ id: 99, pem: PEM });
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ iss: '99' });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('only admins start it; the manifest goes to the organization', async () => {
    expect((await call('POST', '/api/integrations/github/app', ai, {})).status).toBe(403);
    const r = await call('POST', '/api/integrations/github/app', human, { org: 'acme', merge: false });
    expect(r.body.action).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{36}$/);
    expect(JSON.parse(r.body.manifest).default_permissions.contents).toBe('read');
  });

  it('registers, installs and links the installation to the workspace in two taps', async () => {
    const done = await connect();
    expect(done.location).toBe('/app/#/team/github?gh=connected');
    const info = (await call('GET', '/api/integrations/github', human)).body;
    expect(info.app).toMatchObject({ registered: true, slug: 'kunla-acme', merge: true, installations: [{ id: 42, account: 'acme' }] });
    expect(info.merge_ready).toBe(true);
    // A second tap goes straight to the install page.
    expect((await call('POST', '/api/integrations/github/app', human, {})).body.install_url).toMatch(/^https:\/\/github\.com\/apps\/kunla-acme\/installations\/new\?state=/);
  });

  it('refuses a made-up or reused state', async () => {
    expect((await call('GET', '/hooks/github/app/created?code=abc123&state=' + 'a'.repeat(36))).location).toBe('/app/#/team/github?gh=expired');
    const s = await call('POST', '/api/integrations/github/app', human, {});
    const state = new URL(s.body.action).searchParams.get('state');
    await call('GET', `/hooks/github/app/created?code=abc123&state=${state}`);
    expect((await call('GET', `/hooks/github/app/created?code=abc123&state=${state}`)).location).toBe('/app/#/team/github?gh=expired');
    expect((await call('GET', '/hooks/github/app/installed?installation_id=42')).location).toBe('/app/#/team/github?gh=expired');
  });

  it('delivers events from linked installations with no secret to paste', async () => {
    await connect();
    const pr = { action: 'opened', installation: { id: 42 }, repository: { full_name: 'acme/app' },
      pull_request: { number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'MKT-1: Pricing page', body: '', draft: false, merged: false, head: { ref: 'x' }, user: { login: 'octo' } } };
    const r = await hook('pull_request', pr);
    expect(r.body.updated).toEqual([{ key: 'MKT-1', from: 'ready', to: 'review' }]);
    expect((await task('MKT-1')).status).toBe('review');
    // An installation nobody linked is logged, not applied.
    const other = await hook('pull_request', { ...pr, installation: { id: 7, account: { login: 'stranger' } } });
    expect(other.status).toBe(202);
    expect(other.body.error).toContain('not linked');
    expect((await hook('pull_request', pr, 'wrong')).status).toBe(401);
  });

  it('keeps installations per workspace and forgets uninstalled ones', async () => {
    await connect();
    const ws = (await call('POST', '/api/workspaces', human, { name: 'Community' })).body;
    expect((await call('GET', '/api/integrations/github', ws.token)).body.app.installations).toEqual([]);
    await hook('installation', { action: 'deleted', installation: { id: 42, account: { login: 'acme' } } });
    expect((await call('GET', '/api/integrations/github', human)).body.app.installations).toEqual([]);
  });

  it('merges an approved PR with an installation token, no personal token needed', async () => {
    await connect();
    await call('POST', '/api/tasks/MKT-1/claim', ai);
    await call('POST', '/api/tasks/MKT-1/submit', ai, { summary: 'Done', deliverables: [{ url: 'https://github.com/acme/app/pull/7' }] });
    calls = [];
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    const m = calls.find((c) => c.method === 'PUT');
    expect(m).toMatchObject({ url: 'https://api.github.com/repos/acme/app/pulls/7/merge', auth: 'Bearer ghs_install' });
    expect(calls.find((c) => c.url.endsWith('/access_tokens'))!.body).toEqual({ repositories: ['app'] });
    expect((await task('MKT-1')).status).toBe('done');
  });

  it('leaves the merge to the agent when the repo is not installed here', async () => {
    await connect();
    installedOn = 'nobody';
    await call('POST', '/api/tasks/MKT-1/claim', ai);
    await call('POST', '/api/tasks/MKT-1/submit', ai, { summary: 'Done', deliverables: [{ url: 'https://github.com/acme/app/pull/7' }] });
    calls = [];
    await call('POST', '/api/tasks/MKT-1/review', human, { verdict: 'approved' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(calls.find((c) => c.url.includes('agent.test'))!.body.merge.by_kunla).toBe(false);
  });
});
